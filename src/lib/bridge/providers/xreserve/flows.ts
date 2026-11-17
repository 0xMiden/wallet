// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/flows.ts (MIT).
import { parseUnits } from 'viem';

import { quoteAmounts } from 'lib/bridge/core/quote';
import { configKey } from 'lib/bridge/core/routes';
import { verifyBridgeSubmission, type SubmissionChecks } from 'lib/bridge/core/submission';
import { captureBridgeWalletScope, findAdmittedBridgeOperation, type BridgeOperationInput } from 'lib/bridge/operation';
import { startBridgeReceiveSubmission } from 'lib/miden/activity/bridge-receive';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { initiateUsdcxBurn } from 'lib/usdcx/burn';
import { getUsdcxSourceChain } from 'lib/usdcx/constant';

import { submitXReserveDeposit, type XReserveDepositRequest } from './deposit';

export async function runXReserveReceive(
  operation: BridgeOperationInput,
  deps: Omit<XReserveDepositRequest, 'operation' | 'rowId'> & { checks: SubmissionChecks }
): Promise<string> {
  operation = structuredClone(operation);
  const originalScope = captureBridgeWalletScope();
  const existing = await findAdmittedBridgeOperation(operation);
  if (existing) return existing.id;
  const { review } = operation;
  const { route, quote, accounts } = review;
  const chain = route.recovery.config.supportedEvmChains[route.source.network];
  if (
    route.provider !== 'xreserve' ||
    route.mode !== 'receive' ||
    route.destination.kind !== 'miden' ||
    !chain ||
    !quote
  )
    throw new Error('Circle receive terms changed');
  const source = getUsdcxSourceChain(chain.chainId);
  const faucetId = route.destination.faucetId;
  await verifyBridgeSubmission(review, deps.checks);
  if (configKey(originalScope) !== configKey(captureBridgeWalletScope()))
    throw new Error('Circle wallet scope changed');
  return startBridgeReceiveSubmission(
    () => {
      if (configKey(originalScope) !== configKey(captureBridgeWalletScope()))
        throw new Error('Circle wallet scope changed');
      return initiateBridgedReceiveTransaction({
        accountId: accounts.midenAccount,
        amount: parseUnits(quote.received, route.destination.decimals),
        faucetId,
        provider: 'usdcx',
        sourceChainId: chain.chainId,
        sourceAddress: accounts.evmAddress,
        sourceAmount: quoteAmounts(route, quote).sourceTotal,
        sourceSymbol: route.source.symbol,
        usdcxSource: source,
        operation
      });
    },
    async (rowId, claimed) => {
      if (!claimed) return;
      await submitXReserveDeposit({ ...deps, rowId, operation: claimed });
    }
  );
}

export async function runXReserveSend(
  operation: BridgeOperationInput,
  checks: Pick<SubmissionChecks, 'readCurrent' | 'now'>
): Promise<string> {
  operation = structuredClone(operation);
  const { review } = operation;
  const { route, amount, accounts } = review;
  const chain = route.recovery.config.supportedEvmChains[route.destination.network];
  if (route.provider !== 'xreserve' || route.mode !== 'send' || route.source.kind !== 'miden' || !chain)
    throw new Error('Circle send terms changed');
  return initiateUsdcxBurn({
    senderPublicKey: accounts.midenAccount,
    faucetId: route.source.faucetId,
    amount: parseUnits(amount, route.source.decimals),
    destinationAddress: accounts.evmAddress,
    destinationChainId: chain.chainId,
    operation,
    checks
  });
}
