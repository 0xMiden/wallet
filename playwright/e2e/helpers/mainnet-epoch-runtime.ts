import { expect } from '@playwright/test';
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, isHash, parseEventLogs, parseUnits } from 'viem';

import { isRecord } from '../../../src/lib/update/guards';
import { getEnvironmentConfig } from '../config/environments';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from './balance-truth';
import { openRouteStep, waitForReviewSubmitEnabled } from './bridge';
import { mainnetChain, mainnetRpc } from './mainnet-bridge-sources';
import { saveMainnetEpochCheckpoint, type MainnetEpochCheckpoint, type EpochForwardAuthority } from './mainnet-epoch-checkpoint';
import { epochReadOnlyProvider } from './mainnet-epoch-provider';
import { inspectEpochCollateralRequest, inspectEpochForwardQuote } from './mainnet-epoch-request';
import { runGuardedEpochForward } from './mainnet-epoch-ui';
import { waitForFastQuote } from './epoch-quote';
import {
  TxStatus, USER_CANCELLED_REASON, assertNeverStartedBuilding, assertStaysCancelledWithQueueLive,
  openHistoryDetails, plantQueueBlocker, readTransactionRow, readTransactionRowsWithBytes,
  releaseQueueBlocker, waitForTransactionRow, type TransactionRowSnapshot
} from './history';
import { canonicalMainnetLoopFaucet } from './mainnet-loop-config';
import { readMainnetMidenBlock } from './mainnet-miden-read';
import { evmChainSlug } from '../../../src/lib/remote-config/chains';

/** Runtime adapter; funded entry remains disabled until all recovery/return drivers are complete. */
export async function runEpochForward(
  wallet: GuardianAwareWalletPage, state: MainnetEpochCheckpoint, path: string, runId: string
): Promise<void> {
  const age = Date.now() - Date.parse(state.createdAt);
  if (state.phase !== 'forward-authorized' || state.sourceRunId !== runId || state.authorizationRunId !== runId ||
      state.forwardNoteId || state.forwardMidenTxId || state.transactions?.length || age < 0 || age > 600_000 ||
      Date.now() - Date.parse(state.pricedAt) > 600_000)
    throw new Error('Epoch forward requires fresh unused same-run authorization');
  if (await wallet.getAccountAddress() !== state.account ||
      await vaultBalanceByFaucetId(wallet.page, state.native.faucetId) !== BigInt(state.native.balance))
    throw new Error('Epoch Guardian actor or native portfolio changed before forward execution');
  const client = createPublicClient({ chain: mainnetChain(state.evm.chainId), transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 }) });
  const account = getAddress(state.evm.account);
  const token = getAddress(state.evm.token);
  const tokenBalance = () => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  if (await client.getBalance({ address: account }) !== BigInt(state.evm.nativeBalance) ||
      await tokenBalance() !== BigInt(state.evm.tokenBalance))
    throw new Error('Epoch EVM portfolio changed before forward execution');
  const networkId = evmChainSlug(state.evm.chainId);
  if (!networkId) throw new Error('Unknown Epoch mainnet destination');
  await openRouteStep(wallet, { destAddress: account, tokenSymbol: state.native.symbol,
    amount: formatUnits(BigInt(state.principal), 6), network: { id: networkId, name: mainnetChain(state.evm.chainId).name } });
  const visibleQuote = await waitForFastQuote(wallet.page, [], { timeoutMs: 90_000 });
  if (!visibleQuote.amount || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(visibleQuote.amount) ||
      parseUnits(visibleQuote.amount, 6) < BigInt(state.forwardMinimum))
    throw new Error('Epoch visible output no longer meets the uploaded floor');
  await wallet.page.getByTestId('bridge-route-fast').click();
  await wallet.page.getByTestId('bridge-route-confirm').click();
  await wallet.page.waitForURL(/#\/send\/review\?/, { timeout: 30_000 });
  await waitForReviewSubmitEnabled(wallet.page, 90_000);
  const oldIds = new Set((await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).map(row => row.id));
  const blocker = await plantQueueBlocker(wallet.page);
  let queued: TransactionRowSnapshot | undefined;
  let authority: EpochForwardAuthority | undefined;
  const persist = () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  const service = state.allocatorUrl.replace(/\/+$/, '');
  await runGuardedEpochForward({
    enqueue: async () => {
      await wallet.page.getByTestId('send-review-submit').click();
      await expect.poll(async () => {
        const rows = (await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).filter(row => !oldIds.has(row.id));
        if (rows.length > 1) throw new Error('Ambiguous Epoch forward queue rows');
        queued = rows[0];
        if (queued && queued.status !== TxStatus.Queued) throw new Error('Epoch queue hold failed before inspection');
        return queued?.status;
      }, { timeout: 90_000 }).toBe(TxStatus.Queued);
    },
    inspect: async () => {
      if (!queued?.requestBytes || !queued.extraInputs) throw new Error('Missing actual queued Epoch execution bytes');
      assertNeverStartedBuilding(queued, 'before Epoch collateral inspection', TxStatus.Queued);
      const extra = queued.extraInputs;
      if (extra.provider !== 'epoch' || extra.destinationNetwork !== state.evm.chainId ||
          typeof extra.destinationAddress !== 'string' || extra.destinationAddress.toLowerCase() !== account.toLowerCase() ||
          queued.amount !== state.principal || typeof extra.reclaimHeight !== 'number')
        throw new Error('Epoch queued row differs from its authorized route');
      // shortcut: Playwright retains 100 requests; missing SDK inputs fail closed, use scoped capture if valid traffic exceeds this window.
      const requests = await wallet.page.requests();
      const quote = requests.findLast(request => request.url() === `${service}/checkIfDepositNeeded`);
      const nonceRequest = requests.findLast(request => request.url().toLowerCase() ===
        `${service}/suggested-nonce/${state.virtualChainId}/${account}`.toLowerCase());
      const response = await nonceRequest?.response();
      if (!quote || !response?.ok()) throw new Error('Missing actual SDK quote or latest nonce response');
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.nonce !== 'string' || !/^(?:0x[0-9a-f]{1,64}|0|[1-9]\d{0,77})$/i.test(body.nonce))
        throw new Error('Invalid actual SDK nonce response');
      const currentBlock = await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl);
      const payload = quote.postDataJSON();
      const binding = inspectEpochForwardQuote(state, payload, currentBlock, BigInt(body.nonce).toString());
      const inspected = inspectEpochCollateralRequest(state, Uint8Array.from(queued.requestBytes), {
        currentBlock, reclaimHeight: extra.reclaimHeight, bindingHash: binding.bindingHash
      });
      authority = { minimumOutput: payload.compact.mandate.minTokenOut, bindingHash: binding.bindingHash,
        reclaimHeight: inspected.reclaimHeight, mandateReclaimHeight: binding.mandateReclaimHeight };
      return { rowId: queued.id, ...inspected };
    },
    persist: async inspection => {
      if (!authority) throw new Error('Missing exact inspected Epoch collateral authority');
      state.forwardNoteId = inspection.noteId; state.forwardAuthority = authority; persist();
    },
    release: async () => {
      const fresh = (await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).find(row => row.id === queued?.id);
      if (!fresh?.requestBytes || !queued?.requestBytes || fresh.requestBytes.length !== queued.requestBytes.length ||
          fresh.requestBytes.some((value, index) => value !== queued?.requestBytes?.[index]))
        throw new Error('Epoch request bytes changed after inspection');
      assertNeverStartedBuilding(fresh, 'immediately before Epoch queue release', TxStatus.Queued);
      await releaseQueueBlocker(wallet.page, blocker);
    },
    settle: async () => {
      if (!queued) throw new Error('Lost Epoch queue identity after release');
      await waitForTransactionRow(wallet.page, queued.id,
        value => value?.status === TxStatus.Completed || value?.status === TxStatus.Failed,
        { what: 'the exact Epoch collateral receipt', timeoutMs: 300_000 });
      const row = (await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).find(value => value.id === queued?.id);
      if (!row || row.status !== TxStatus.Completed || !row.transactionId || !isHash(row.transactionId) ||
          !row.outputNoteIds?.includes(state.forwardNoteId ?? '') || row.feeAmount === undefined ||
          !/^(0|[1-9]\d*)$/.test(row.feeAmount) || !row.feeFaucetId ||
          canonicalMainnetLoopFaucet(row.feeFaucetId) !== state.native.hex)
        throw new Error('Missing exact Epoch collateral transaction, output note or fee receipt');
      state.forwardMidenTxId = row.transactionId;
      state.paidMidenFees = row.feeAmount;
      persist();
      const provider = epochReadOnlyProvider(state.allocatorUrl, state.virtualChainId, account);
      let fill: string | undefined;
      await expect.poll(async () => {
        const status = await provider.sdk.getIntentStatus(provider.config, account, state.forwardNonce);
        if (!Array.isArray(status)) throw new Error('Invalid Epoch status response');
        const hashes = new Set(status.filter(leg => leg.chainId === state.evm.chainId &&
          ['success', 'completed'].includes(leg.status) && typeof leg.transactionHash === 'string').map(leg => leg.transactionHash));
        if (hashes.size > 1) throw new Error('Ambiguous Epoch destination receipts');
        fill = [...hashes][0] ?? undefined;
        return !!fill;
      }, { timeout: 300_000, intervals: [5000, 10000, 15000] }).toBe(true);
      if (!fill || !isHash(fill)) throw new Error('Epoch did not provide an exact destination transaction');
      const receipt = await client.getTransactionReceipt({ hash: fill });
      if (receipt.status !== 'success' || receipt.from.toLowerCase() === account.toLowerCase())
        throw new Error('Epoch destination receipt reverted or was self-filled');
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true })
        .filter(log => log.address.toLowerCase() === token.toLowerCase() && log.args.to.toLowerCase() === account.toLowerCase());
      if (transfers.some(log => log.args.from.toLowerCase() === account.toLowerCase())) throw new Error('Epoch cannot self-fill its payout');
      const received = transfers.reduce((sum, log) => sum + log.args.value, 0n);
      if (!state.forwardAuthority || received < BigInt(state.forwardAuthority.minimumOutput)) throw new Error('Epoch receipt underfilled the authorized output');
      await wallet.refreshBalancesLanded(90_000);
      if (await vaultBalanceByFaucetId(wallet.page, state.native.faucetId) !==
          BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees) ||
          await tokenBalance() !== BigInt(state.evm.tokenBalance) + received ||
          await client.getBalance({ address: account }) !== BigInt(state.evm.nativeBalance))
        throw new Error('Epoch forward portfolio does not equal its exact receipts');
      state.forwardEvmTxHash = fill;
      state.forwardReceived = received.toString();
      state.phase = 'forward-settled'; persist();
    },
    cancelQueued: async () => {
      if (!queued) return false;
      const before = await readTransactionRow(wallet.page, queued.id);
      if (!before) return false;
      assertNeverStartedBuilding(before, 'before cancelling rejected Epoch collateral', TxStatus.Queued);
      await openHistoryDetails(wallet, queued.id);
      await wallet.page.getByTestId('history-cancel-button').click();
      const failed = await waitForTransactionRow(wallet.page, queued.id, row => row?.status === TxStatus.Failed,
        { what: 'confirmed Epoch queue cancellation', timeoutMs: 60_000 });
      assertNeverStartedBuilding(failed, 'after Epoch queue cancellation', TxStatus.Failed);
      return failed.error === USER_CANCELLED_REASON;
    },
    unspent: async () => {
      await releaseQueueBlocker(wallet.page, blocker);
      if (!queued) throw new Error('Missing cancelled Epoch row');
      await assertStaysCancelledWithQueueLive(wallet.page, queued.id, USER_CANCELLED_REASON, { forMs: 15_000 });
      state.phase = 'unspent'; persist();
    },
    uncertain: async () => { state.phase = 'recovery-required'; persist(); }
  });
}
