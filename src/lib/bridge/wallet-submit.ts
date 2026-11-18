import { v4 as uuid } from 'uuid';
import type { EIP1193Provider, WalletClient } from 'viem';

import type { BridgeNoteDeps } from 'lib/epoch/miden-note';
import { requestSWTransactionProcessing, startBackgroundTransactionProcessing } from 'lib/miden/activity';
import { readBalanceSnapshot } from 'lib/miden/balance-snapshot';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { strictPriceSymbolFor } from 'lib/miden/swap/tokens';
import { isExtension } from 'lib/platform';
import { isNominalQuote, quotedPrice } from 'lib/prices/binance';
import { useWalletStore } from 'lib/store';

import {
  evaluateBalanceCap,
  priceSymbolsForBalanceCap,
  type BalanceCapEvaluation,
  type BalanceCapPrices,
  type MidenBalances
} from './core/balance-cap';
import { assertReviewedBridge, type BridgeReviewContext, type ReviewedTransfer } from './core/review';
import { configKey, type BridgeRoute } from './core/routes';
import type { SubmissionChecks } from './core/submission';
import { captureBridgeWalletScope, findAdmittedBridgeOperation, type BridgeOperationInput } from './operation';

export type BridgeWalletDeps = BridgeNoteDeps & {
  getContext: () => BridgeReviewContext;
  getEvmWallet: () => Promise<WalletClient | undefined>;
  onOperation: (id: string) => void;
};
/** Public operationId is the durable wallet row id, not the internal BridgeOperationInput correlation UUID. */
export type BridgeSubmissionOutcome =
  | { kind: 'started'; operationId: string }
  | { kind: 'rejected'; operationId?: string };

export function walletBridgeBalanceCap(route: BridgeRoute, amount: string, account: string): BalanceCapEvaluation {
  if (route.mode !== 'receive' || route.recovery.config.limits?.bridgeInMaxBalanceUsd === undefined)
    return { status: 'allowed' };
  const state = useWalletStore.getState();
  const rows = state.balances[account];
  if (
    !rows ||
    !readBalanceSnapshot(rows, { accountId: account, ...captureBridgeWalletScope() }) ||
    state.balancesLoading[account] ||
    state.balanceReadFailed[account] ||
    state.tokenPricesStatus !== 'ready'
  )
    return { status: 'unavailable' };
  const balances: MidenBalances = {};
  for (const row of rows) {
    if (!hasKnownScale(row.metadata)) continue;
    if (row.balanceBaseUnits === undefined || !/^\d+$/.test(row.balanceBaseUnits)) return { status: 'unavailable' };
    balances[row.tokenId] = {
      amountRaw: BigInt(row.balanceBaseUnits),
      decimals: row.metadata.decimals,
      pricingSymbol: strictPriceSymbolFor(row.tokenId, row.metadata.symbol, route.recovery.network)
    };
  }
  const now = Date.now();
  // The original bridge-in cap values USDC at par; never adopt the test-network nominal price for other assets.
  const prices: BalanceCapPrices = { USDC: { usdDecimal: '1', fetchedAt: now } };
  for (const symbol of priceSymbolsForBalanceCap(route, balances)) {
    if (symbol === 'USDC') continue;
    const quote = quotedPrice(state.tokenPrices, symbol);
    if (quote && !isNominalQuote(quote) && quote.observedAt !== undefined)
      prices[symbol] = { usdDecimal: quote.price.toString(), fetchedAt: quote.observedAt };
  }
  return evaluateBalanceCap(route, amount, balances, prices, now);
}

const inputs = new WeakMap<
  ReviewedTransfer,
  { operation: BridgeOperationInput; scope: ReturnType<typeof captureBridgeWalletScope> }
>();

export async function submitReviewedBridge(
  review: ReviewedTransfer,
  deps: BridgeWalletDeps
): Promise<BridgeSubmissionOutcome> {
  let captured = inputs.get(review);
  if (!captured) {
    captured = {
      operation: { operationId: uuid(), review: structuredClone(review) },
      scope: captureBridgeWalletScope()
    };
    inputs.set(review, captured);
  }
  const { operation, scope } = captured;
  let rowId: string | undefined;
  const notify = (id: string) => {
    rowId = id;
    try {
      deps.onOperation(id);
    } catch {
      /* Observer departure cannot revoke or erase original admitted facts. */
    }
  };
  const readCurrent = async () => {
    const current = deps.getContext();
    if (configKey(scope) !== configKey(captureBridgeWalletScope())) throw new Error('Bridge wallet scope changed');
    assertReviewedBridge(operation.review, current, Date.now());
    if (walletBridgeBalanceCap(current.route, current.amount, current.accounts.midenAccount).status !== 'allowed')
      throw new Error('Bridge balance cap unavailable or exceeded');
    return current;
  };
  const checks: SubmissionChecks = {
    readCurrent,
    now: () => Date.now(),
    verifyBalanceCap: async () => {
      await readCurrent();
    }
  };
  try {
    const original = await findAdmittedBridgeOperation(operation);
    if (original) {
      notify(original.id);
      return { kind: 'started', operationId: original.id };
    }
    await readCurrent();
    const { route } = operation.review;
    if (route.provider === 'epoch' && route.mode === 'receive') return { kind: 'rejected' };
    if (route.mode === 'send') {
      if (route.provider === 'epoch') {
        const { runEpochSend } = await import('./providers/epoch');
        await readCurrent();
        const result = await runEpochSend(operation, { ...deps, checks }, notify);
        rowId = result.txId ?? rowId;
      } else {
        if (route.provider === 'agglayer') {
          const { runAgglayerSend } = await import('./providers/agglayer/flows');
          await readCurrent();
          rowId = await runAgglayerSend(operation, { guardianProvider: deps.guardianProvider, checks });
        } else {
          const { runXReserveSend } = await import('./providers/xreserve/flows');
          await readCurrent();
          rowId = await runXReserveSend(operation, checks);
        }
        if (isExtension()) requestSWTransactionProcessing();
        else startBackgroundTransactionProcessing(deps.signTransaction, false, deps.guardianProvider);
      }
    } else {
      const wallet = await deps.getEvmWallet();
      await readCurrent();
      if (!wallet) return { kind: 'rejected' };
      const provider: Pick<EIP1193Provider, 'request'> = { request: wallet.transport.request };
      if (route.provider === 'agglayer') {
        const { runAgglayerReceive } = await import('./providers/agglayer/flows');
        const { agglayerReadClient } = await import('./providers/agglayer/provider');
        await readCurrent();
        const chain = route.recovery.config.supportedEvmChains[route.source.network];
        if (!chain) return { kind: 'rejected' };
        rowId = await runAgglayerReceive(operation, { provider, client: agglayerReadClient(chain.chainId), checks });
      } else {
        const { runXReserveReceive } = await import('./providers/xreserve/flows');
        const { xreserveReadClient } = await import('./providers/xreserve/provider');
        await readCurrent();
        const chain = route.recovery.config.supportedEvmChains[route.source.network];
        if (!chain) return { kind: 'rejected' };
        rowId = await runXReserveReceive(operation, { provider, client: xreserveReadClient(chain.chainId), checks });
      }
    }
    if (!rowId) return { kind: 'rejected' };
    notify(rowId);
    return { kind: 'started', operationId: rowId };
  } catch {
    const original = await findAdmittedBridgeOperation(operation).catch(() => undefined);
    rowId = original?.id ?? rowId;
    if (rowId) notify(rowId);
    return rowId ? { kind: 'rejected', operationId: rowId } : { kind: 'rejected' };
  }
}
