import { expect } from '@playwright/test';
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, isHash, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Endpoint, NoteId, RpcClient } from '@miden-sdk/miden-sdk';

import { ACTIVITY_PENDING_PATH } from '../../../src/app/pages/activity-paths';
import { isRecord } from '../../../src/lib/update/guards';
import { withRpcTimeout } from '../../../src/lib/miden-chain/rpc-timeout';
import { WcCounterparty } from '../ios/helpers/wc-counterparty';
import { getEnvironmentConfig } from '../config/environments';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from './balance-truth';
import { openRouteStep, waitForReviewSubmitEnabled } from './bridge';
import { mainnetChain, mainnetRpc } from './mainnet-bridge-sources';
import {
  saveMainnetEpochCheckpoint,
  type MainnetEpochCheckpoint,
  type EpochForwardAuthority
} from './mainnet-epoch-checkpoint';
import { epochReadOnlyProvider } from './mainnet-epoch-provider';
import {
  inspectEpochCollateralRequest,
  inspectEpochForwardQuote,
  inspectEpochReturnNote,
  inspectEpochRefundNote,
  mainnetConsumeRequestHash
} from './mainnet-epoch-request';
import { runGuardedEpochForward } from './mainnet-epoch-ui';
import { waitForFastQuote } from './epoch-quote';
import {
  TxStatus,
  USER_CANCELLED_REASON,
  assertNeverStartedBuilding,
  assertStaysCancelledWithQueueLive,
  openHistoryDetails,
  plantQueueBlocker,
  readTransactionRow,
  readTransactionRowsWithBytes,
  releaseQueueBlocker,
  waitForTransactionRow,
  readTransactionRows,
  type TransactionRowSnapshot
} from './history';
import { canonicalMainnetLoopFaucet } from './mainnet-loop-config';
import { readMainnetMidenBlock } from './mainnet-miden-read';
import { awaitMainnetLoopAuthorization } from './mainnet-loop-authorization';
import { armMainnetConsumeAuthorization, releaseMainnetConsumeAuthorization } from './mainnet-consume-authorization';
import {
  createEpochEvmSender,
  reconcileEpochEvmReceipts,
  inspectEpochForwardReceipt,
  type EpochEvmRecoveryEvidence
} from './mainnet-epoch-evm';
import { planEpochRoundTrip } from './mainnet-epoch-ui';
import { realizedMainnetLoopLoss } from './mainnet-loop-budget';
import { fetchMainnetOneClickUsdPrices } from './mainnet-one-click-prices';
import { exportMakerNote } from './swap';
import { BRIDGE_DEPOSIT_LAYER } from './send-flow-scripts';
import { evmChainSlug } from '../../../src/lib/remote-config/chains';

/** Runtime adapter; funded entry remains disabled until all recovery/return drivers are complete. */
export async function runEpochForward(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string,
  runId: string,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  const age = Date.now() - Date.parse(state.createdAt);
  if (
    state.phase !== 'forward-authorized' ||
    state.sourceRunId !== runId ||
    state.authorizationRunId !== runId ||
    state.forwardNoteId ||
    state.forwardMidenTxId ||
    state.transactions?.length ||
    age < 0 ||
    age > 600_000 ||
    Date.now() - Date.parse(state.pricedAt) > 600_000
  )
    throw new Error('Epoch forward requires fresh unused same-run authorization');
  if (
    (await wallet.getAccountAddress()) !== state.account ||
    (await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)) !== BigInt(state.native.balance)
  )
    throw new Error('Epoch Guardian actor or native portfolio changed before forward execution');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const account = getAddress(state.evm.account);
  const token = getAddress(state.evm.token);
  const tokenBalance = () =>
    client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  if (
    (await client.getBalance({ address: account })) !== BigInt(state.evm.nativeBalance) ||
    (await tokenBalance()) !== BigInt(state.evm.tokenBalance)
  )
    throw new Error('Epoch EVM portfolio changed before forward execution');
  const networkId = evmChainSlug(state.evm.chainId);
  if (!networkId) throw new Error('Unknown Epoch mainnet destination');
  await openRouteStep(wallet, {
    destAddress: account,
    tokenSymbol: state.native.symbol,
    amount: formatUnits(BigInt(state.principal), 6),
    network: { id: networkId, name: mainnetChain(state.evm.chainId).name }
  });
  const visibleQuote = await waitForFastQuote(wallet.page, [], { timeoutMs: 90_000 });
  if (
    !visibleQuote.amount ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(visibleQuote.amount) ||
    parseUnits(visibleQuote.amount, 6) < BigInt(state.forwardMinimum)
  )
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
      await expect
        .poll(
          async () => {
            const rows = (await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).filter(
              row => !oldIds.has(row.id)
            );
            if (rows.length > 1) throw new Error('Ambiguous Epoch forward queue rows');
            queued = rows[0];
            if (queued && queued.status !== TxStatus.Queued)
              throw new Error('Epoch queue hold failed before inspection');
            return queued?.status;
          },
          { timeout: 90_000 }
        )
        .toBe(TxStatus.Queued);
    },
    inspect: async () => {
      if (!queued?.requestBytes || !queued.extraInputs) throw new Error('Missing actual queued Epoch execution bytes');
      assertNeverStartedBuilding(queued, 'before Epoch collateral inspection', TxStatus.Queued);
      const extra = queued.extraInputs;
      if (
        extra.provider !== 'epoch' ||
        extra.destinationNetwork !== state.evm.chainId ||
        typeof extra.destinationAddress !== 'string' ||
        extra.destinationAddress.toLowerCase() !== account.toLowerCase() ||
        queued.amount !== state.principal ||
        typeof extra.reclaimHeight !== 'number'
      )
        throw new Error('Epoch queued row differs from its authorized route');
      // shortcut: Playwright retains 100 requests; missing SDK inputs fail closed, use scoped capture if valid traffic exceeds this window.
      const requests = await wallet.page.requests();
      const quote = requests.findLast(request => request.url() === `${service}/checkIfDepositNeeded`);
      const nonceRequest = requests.findLast(
        request =>
          request.url().toLowerCase() === `${service}/suggested-nonce/${state.virtualChainId}/${account}`.toLowerCase()
      );
      const response = await nonceRequest?.response();
      if (!quote || !response?.ok()) throw new Error('Missing actual SDK quote or latest nonce response');
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        typeof body.nonce !== 'string' ||
        !/^(?:0x[0-9a-f]{1,64}|0|[1-9]\d{0,77})$/i.test(body.nonce)
      )
        throw new Error('Invalid actual SDK nonce response');
      const currentBlock = await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl);
      const payload = quote.postDataJSON();
      const binding = inspectEpochForwardQuote(state, payload, currentBlock, BigInt(body.nonce).toString());
      const inspected = inspectEpochCollateralRequest(state, Uint8Array.from(queued.requestBytes), {
        currentBlock,
        reclaimHeight: extra.reclaimHeight,
        bindingHash: binding.bindingHash
      });
      authority = {
        minimumOutput: payload.compact.mandate.minTokenOut,
        bindingHash: binding.bindingHash,
        reclaimHeight: inspected.reclaimHeight,
        mandateReclaimHeight: binding.mandateReclaimHeight
      };
      return { rowId: queued.id, ...inspected };
    },
    persist: async inspection => {
      if (!authority) throw new Error('Missing exact inspected Epoch collateral authority');
      state.forwardNoteId = inspection.noteId;
      state.forwardAuthority = authority;
      persist();
      await awaitMainnetLoopAuthorization(path, gatePath, signal);
    },
    release: async () => {
      const fresh = (await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).find(
        row => row.id === queued?.id
      );
      if (
        !fresh?.requestBytes ||
        !queued?.requestBytes ||
        fresh.requestBytes.length !== queued.requestBytes.length ||
        fresh.requestBytes.some((value, index) => value !== queued?.requestBytes?.[index])
      )
        throw new Error('Epoch request bytes changed after inspection');
      assertNeverStartedBuilding(fresh, 'immediately before Epoch queue release', TxStatus.Queued);
      const currentBlock = await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl);
      if (
        signal.aborted ||
        !authority ||
        authority.mandateReclaimHeight <= currentBlock ||
        Date.now() - Date.parse(state.createdAt) > 600_000 ||
        Date.now() - Date.parse(state.pricedAt) > 600_000
      )
        throw new Error('Epoch authorization became stale or aborted while awaiting upload');
      inspectEpochCollateralRequest(state, Uint8Array.from(fresh.requestBytes), {
        currentBlock,
        reclaimHeight: authority.reclaimHeight,
        bindingHash: authority.bindingHash
      });
      if ((await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)) !== BigInt(state.native.balance))
        throw new Error('Epoch native portfolio changed while awaiting authorization upload');
      await releaseQueueBlocker(wallet.page, blocker);
    },
    settle: async () => {
      if (!queued) throw new Error('Lost Epoch queue identity after release');
      await waitForTransactionRow(
        wallet.page,
        queued.id,
        value => value?.status === TxStatus.Completed || value?.status === TxStatus.Failed,
        { what: 'the exact Epoch collateral receipt', timeoutMs: 300_000 }
      );
      const row = (await readTransactionRowsWithBytes(wallet.page, 'bridged-send')).find(
        value => value.id === queued?.id
      );
      if (
        !row ||
        row.status !== TxStatus.Completed ||
        !row.transactionId ||
        !isHash(row.transactionId) ||
        !row.outputNoteIds?.includes(state.forwardNoteId ?? '') ||
        row.feeAmount === undefined ||
        !/^(0|[1-9]\d*)$/.test(row.feeAmount) ||
        !row.feeFaucetId ||
        canonicalMainnetLoopFaucet(row.feeFaucetId) !== state.native.hex
      )
        throw new Error('Missing exact Epoch collateral transaction, output note or fee receipt');
      state.forwardMidenTxId = row.transactionId;
      state.paidMidenFees = row.feeAmount;
      persist();
      await recoverEpochForward(wallet, state, path, signal);
    },
    cancelQueued: async () => {
      if (!queued) return false;
      const before = await readTransactionRow(wallet.page, queued.id);
      if (!before) return false;
      assertNeverStartedBuilding(before, 'before cancelling rejected Epoch collateral', TxStatus.Queued);
      await openHistoryDetails(wallet, queued.id);
      await wallet.page.getByTestId('history-cancel-button').click();
      const failed = await waitForTransactionRow(wallet.page, queued.id, row => row?.status === TxStatus.Failed, {
        what: 'confirmed Epoch queue cancellation',
        timeoutMs: 60_000
      });
      assertNeverStartedBuilding(failed, 'after Epoch queue cancellation', TxStatus.Failed);
      return failed.error === USER_CANCELLED_REASON;
    },
    unspent: async () => {
      await releaseQueueBlocker(wallet.page, blocker);
      if (!queued) throw new Error('Missing cancelled Epoch row');
      await assertStaysCancelledWithQueueLive(wallet.page, queued.id, USER_CANCELLED_REASON, { forMs: 15_000 });
      state.phase = 'unspent';
      persist();
    },
    uncertain: async () => {
      state.phase = 'recovery-required';
      persist();
    }
  });
}

/** Reconcile the original completed collateral receipt and provider payout; never enqueue another mint. */
export async function recoverEpochForward(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string,
  signal: AbortSignal
): Promise<void> {
  if (
    !state.forwardAuthority ||
    !state.forwardNoteId ||
    !state.forwardMidenTxId ||
    state.reverseNonce !== undefined ||
    state.transactions?.length ||
    state.consumeAuthority ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Epoch forward reconciliation requires its original collateral receipt and no later submission');
  const account = getAddress(state.evm.account);
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const provider = epochReadOnlyProvider(state.allocatorUrl, state.virtualChainId, account);
  let fill: string | undefined;
  await expect
    .poll(
      async () => {
        if (signal.aborted) throw new Error('Epoch forward reconciliation aborted');
        const status = await provider.sdk.getIntentStatus(provider.config, account, state.forwardNonce);
        if (!Array.isArray(status)) throw new Error('Invalid Epoch status response');
        const hashes = new Set(
          status
            .filter(
              leg =>
                leg.chainId === state.evm.chainId &&
                ['success', 'completed'].includes(leg.status) &&
                typeof leg.transactionHash === 'string'
            )
            .map(leg => leg.transactionHash)
        );
        if (hashes.size > 1) throw new Error('Ambiguous Epoch destination receipts');
        fill = [...hashes][0] ?? undefined;
        return !!fill;
      },
      { timeout: 300_000, intervals: [5000, 10000, 15000] }
    )
    .toBe(true);
  if (!fill || !isHash(fill)) throw new Error('Epoch did not provide an exact destination transaction');
  const receipt = await client.getTransactionReceipt({ hash: fill });
  const received = inspectEpochForwardReceipt(state, fill, receipt);
  await wallet.refreshBalancesLanded(90_000);
  const tokenBalance = await client.readContract({
    address: getAddress(state.evm.token),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account]
  });
  if (
    (await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)) !==
      BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees) ||
    tokenBalance !== BigInt(state.evm.tokenBalance) + received ||
    (await client.getBalance({ address: account })) !== BigInt(state.evm.nativeBalance)
  )
    throw new Error('Epoch forward portfolio does not equal its exact receipts');
  state.forwardEvmTxHash = fill;
  state.forwardReceived = received.toString();
  state.phase = 'forward-settled';
  state.updatedAt = new Date().toISOString();
  saveMainnetEpochCheckpoint(path, state);
}

export async function persistEpochEvmCheckpoint(
  state: MainnetEpochCheckpoint,
  path: string,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  saveMainnetEpochCheckpoint(path, state);
  const transactions = state.transactions;
  if (transactions?.length && transactions.at(-1)?.feeWei === undefined)
    await awaitMainnetLoopAuthorization(path, `${gatePath}.evm-${transactions.length}`, signal);
}

/** Uses the existing EVM key only after the live UI's exact return authorization has been uploaded. */
export async function runEpochReverse(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string,
  runId: string,
  key: Hex,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  if (
    state.phase !== 'forward-settled' ||
    !state.forwardAuthority ||
    state.sourceRunId !== runId ||
    state.authorizationRunId !== runId ||
    state.transactions?.length ||
    state.returnMidenTxId ||
    state.reverseNonce !== undefined ||
    state.reverseAuthority ||
    state.consumeAuthority ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Epoch return requires the original same-run, actually settled collateral authority');
  const evm = privateKeyToAccount(key);
  if (evm.address.toLowerCase() !== state.evm.account.toLowerCase()) throw new Error('Epoch EVM actor changed');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const token = getAddress(state.evm.token);
  const tokenBalance = () =>
    client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [evm.address] });
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  const blocker = await plantQueueBlocker(wallet.page);
  let sender: ReturnType<typeof createEpochEvmSender> | undefined;
  let failed = false;
  let preparing = false;
  const counterparty = new WcCounterparty({
    privateKey: key,
    chainId: state.evm.chainId,
    sessionChainIds: [state.evm.chainId],
    rpcUrl: mainnetRpc(state.evm.chainId),
    send: async (transaction, counterpartySignal) => {
      try {
        const activeSignal = AbortSignal.any([signal, counterpartySignal]);
        if (failed || activeSignal.aborted) throw new Error('Epoch return signing is already blocked');
        if (!sender) {
          if (preparing) throw new Error('Concurrent Epoch return authorization is blocked');
          preparing = true;
          const service = state.allocatorUrl.replace(/\/+$/, '');
          const requests = await wallet.page.requests();
          const quoteRequest = requests.findLast(request => request.url() === `${service}/checkIfDepositNeeded`);
          const nonceRequest = requests.findLast(
            request =>
              request.url().toLowerCase() ===
              `${service}/suggested-nonce/${state.evm.chainId}/${evm.address}`.toLowerCase()
          );
          const quoteResponse = await quoteRequest?.response();
          const nonceResponse = await nonceRequest?.response();
          if (!quoteRequest || !quoteResponse?.ok() || !nonceResponse?.ok())
            throw new Error('Missing live Epoch reverse SDK exchange');
          const quote: unknown = await quoteResponse.json();
          const nonce: unknown = await nonceResponse.json();
          const payload = quoteRequest.postDataJSON();
          if (
            !isRecord(quote) ||
            typeof quote.tokenIn !== 'string' ||
            !/^[1-9]\d{0,77}$/.test(quote.tokenIn) ||
            quote.tokenOut !== state.reverseMinimum ||
            !isRecord(nonce) ||
            typeof nonce.nonce !== 'string' ||
            !/^(?:0x[0-9a-f]{1,64}|0|[1-9]\d{0,77})$/i.test(nonce.nonce) ||
            !isRecord(payload) ||
            !isRecord(payload.compact) ||
            typeof payload.compact.expires !== 'string' ||
            !/^[1-9]\d{0,77}$/.test(payload.compact.expires)
          )
            throw new Error('Invalid live Epoch return amounts or nonce');
          const provider = epochReadOnlyProvider(state.allocatorUrl, state.evm.chainId, evm.address);
          const metadata = await provider.sdk.resolveServiceConfiguration(provider.config, state.evm.chainId);
          if (
            getAddress(metadata.compactAddress) !== getAddress(state.evm.compact) ||
            getAddress(metadata.allocatorAddress) !== getAddress(state.evm.allocator) ||
            metadata.midenMainnetVirtualChainId !== state.virtualChainId
          )
            throw new Error('Epoch live contract or network metadata changed');
          const expiry = BigInt(payload.compact.expires);
          const now = Math.floor(Date.now() / 1000);
          const ttl = metadata.compactExpirySeconds + metadata.compactExpiryBufferSeconds;
          if (expiry < BigInt(now) || expiry > BigInt(now + ttl + 1))
            throw new Error('Epoch compact expiry exceeds live metadata');
          const lockTag = provider.sdk.createLockTag(
            BigInt(metadata.compactLockResetPeriod),
            BigInt(metadata.compactLockScope),
            provider.sdk.getAllocatorId(getAddress(state.evm.allocator))
          );
          const pendingNonce = await client.getTransactionCount({ address: evm.address, blockTag: 'pending' });
          if (pendingNonce !== (await client.getTransactionCount({ address: evm.address, blockTag: 'latest' })))
            throw new Error('Existing EVM account has an unrelated pending transaction');
          const prices = await fetchMainnetOneClickUsdPrices(['usd-coin', 'ethereum']);
          const stable = prices.usdMicrosById['usd-coin'];
          const gasPrice = prices.usdMicrosById.ethereum;
          if (!stable || !gasPrice) throw new Error('Missing fresh Epoch return market prices');
          const stableCeiling = [stable, BigInt(state.native.usdMicros), BigInt(state.evm.tokenUsdMicros)].reduce(
            (left, right) => (left > right ? left : right)
          );
          const gasCeiling =
            gasPrice > BigInt(state.evm.nativeUsdMicros) ? gasPrice : BigInt(state.evm.nativeUsdMicros);
          const reverse: MainnetEpochCheckpoint = {
            ...state,
            phase: 'reverse-authorized',
            reverseNonce: BigInt(nonce.nonce).toString(),
            returnAmount: quote.tokenIn,
            evmNonceBefore: pendingNonce,
            reverseAuthority: {
              arbiter: metadata.arbiterAddress,
              lockTag: `0x${lockTag.toString(16).padStart(24, '0')}`,
              preparedAt: new Date().toISOString(),
              minimumExpiry: expiry.toString(),
              maximumExpiry: (expiry + 300n).toString(),
              valuation: {
                pricedAt: prices.fetchedAt,
                stableUsdMicros: stableCeiling.toString(),
                gasUsdMicros: gasCeiling.toString()
              }
            }
          };
          planEpochRoundTrip(reverse, BigInt(quote.tokenIn));
          Object.assign(state, reverse);
          await persist();
          await awaitMainnetLoopAuthorization(path, gatePath, activeSignal);
          if (failed) throw new Error('Epoch return authorization was blocked while awaiting upload');
          sender = createEpochEvmSender(state, {
            client: {
              getChainId: () => client.getChainId(),
              getTransactionCount: input => client.getTransactionCount(input),
              getBalance: input => client.getBalance(input),
              readTokenBalance: tokenBalance,
              readAllowance: () =>
                client.readContract({
                  address: token,
                  abi: erc20Abi,
                  functionName: 'allowance',
                  args: [evm.address, getAddress(state.evm.compact)]
                }),
              estimateGas: input => client.estimateGas(input),
              estimateFeesPerGas: () => client.estimateFeesPerGas(),
              sendRawTransaction: input => client.sendRawTransaction(input),
              waitForTransactionReceipt: input => client.waitForTransactionReceipt(input)
            },
            sign: transaction => evm.signTransaction({ ...transaction, type: 'eip1559' }),
            persist: saved => persistEpochEvmCheckpoint(saved, path, gatePath, activeSignal)
          });
        }
        return await sender.send(transaction, activeSignal);
      } catch {
        failed = true;
        // RPC errors can include serialized signed bytes; retain only the public journal for diagnosis.
        throw new Error(
          'Epoch EVM submission is unresolved; reconcile the saved signed hashes before any further signing'
        );
      }
    }
  });
  try {
    await wallet.page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/bridge/deposit`);
    await counterparty.start();
    const connection = counterparty.connectWithRetry(
      () =>
        wallet.page.evaluate(() => {
          const read = window.__TEST_APPKIT_CONNECT_URI__;
          if (!read) throw new Error('Missing mainnet AppKit connection hook');
          return read();
        }),
      () => wallet.page.evaluate(() => window.__TEST_APPKIT_STATE__?.().connected ?? false),
      { attempts: 3, backoffMs: 5000, sessionTimeoutMs: 45_000 }
    );
    await wallet.page.getByTestId('bridge-connect-wallet').click();
    await connection;
    const connected = await wallet.page.evaluate(() => window.__TEST_APPKIT_STATE__?.());
    if (!connected?.connected || connected.address?.toLowerCase() !== evm.address.toLowerCase())
      throw new Error('Epoch connected another EVM actor');
    const form = wallet.page.locator(BRIDGE_DEPOSIT_LAYER);
    await form.getByTestId('bridge-source-network').click();
    await wallet.page.getByTestId(`bridge-network-${evmChainSlug(state.evm.chainId)}`).click();
    await form.getByTestId('send-token-selector').click();
    await wallet.page.getByTestId('bridge-token-EPOCH_USDC').click();
    await form.getByTestId('send-amount-input').fill(formatUnits(BigInt(state.reverseMinimum), 6));
    await form.getByTestId('send-amount-confirm').click();
    await form.getByTestId('bridge-route-fast').click();
    await form.getByTestId('bridge-route-confirm').click();
    await form.getByTestId('bridge-deposit-review-confirm').click();
    await expect
      .poll(
        () => {
          if (failed) throw new Error('Epoch EVM request failed; inspect the public signed-hash journal');
          return state.transactions?.some(tx => tx.kind === 'deposit' && tx.feeWei !== undefined) ?? false;
        },
        { timeout: 600_000, intervals: [1000, 3000, 5000] }
      )
      .toBe(true);
    await settleEpochReturn(wallet, state, path, blocker, gatePath, signal);
  } catch (error) {
    state.phase = 'recovery-required';
    await persist();
    throw error;
  } finally {
    await counterparty.stop();
  }
}

async function settleEpochReturn(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string,
  blocker: string,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  if (state.consumeAuthority || state.returnMidenTxId)
    throw new Error('Original native claim may already have been released; do not retry');
  const account = getAddress(state.evm.account);
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  const provider = epochReadOnlyProvider(state.allocatorUrl, state.evm.chainId, account);
  let noteId: string | undefined;
  await expect
    .poll(
      async () => {
        if (signal.aborted) throw new Error('Epoch return aborted');
        const status = await provider.sdk.getIntentStatus(provider.config, account, state.reverseNonce ?? '');
        if (!Array.isArray(status)) throw new Error('Invalid Epoch return status');
        const ids = new Set(
          status
            .filter(leg => leg.chainId === state.virtualChainId && ['success', 'completed'].includes(leg.status))
            .map(leg => Reflect.get(leg, 'midenNoteId'))
            .filter((id): id is string => typeof id === 'string' && isHash(id))
        );
        if (ids.size > 1) throw new Error('Ambiguous provider-correlated Epoch return notes');
        noteId = [...ids][0];
        return !!noteId;
      },
      { timeout: 300_000, intervals: [5000, 10000, 15000] }
    )
    .toBe(true);
  if (!noteId || !isHash(noteId)) throw new Error('Missing exact Epoch return note');
  await wallet.triggerSync(true);
  const file = await exportMakerNote(wallet, noteId, 90_000);
  const bytes = Buffer.from(file, 'hex');
  const amount = inspectEpochReturnNote(state, noteId, bytes);
  const rpc = new RpcClient(new Endpoint(getEnvironmentConfig().rpcUrl));
  const notes = await withRpcTimeout(() => rpc.getNotesById([NoteId.fromHex(noteId ?? '')]), 'Epoch return inclusion', {
    retries: 0
  });
  if (notes.length !== 1 || notes[0]?.noteId.toString() !== noteId)
    throw new Error('Epoch return note is not recorded on the live chain');
  state.returnNoteId = noteId;
  await persist();
  const consume = await armMainnetConsumeAuthorization(wallet.page, {
    accountId: state.accountHex,
    noteId,
    canonicalSha256: mainnetConsumeRequestHash(bytes)
  });
  await wallet.navigateTo(ACTIVITY_PENDING_PATH);
  const current = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
    row.noteIds?.includes(noteId ?? '')
  );
  if (!current.length)
    await wallet.page
      .locator(`[data-pending-note-id="${noteId}"]`)
      .getByRole('button', { name: /^Accept$/ })
      .click();
  let claim: TransactionRowSnapshot | undefined;
  await expect
    .poll(
      async () => {
        const rows = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
          row.noteIds?.includes(noteId ?? '')
        );
        if (rows.length > 1) throw new Error('Ambiguous Epoch return claims');
        claim = rows[0];
        return claim?.status;
      },
      { timeout: 60_000 }
    )
    .toBe(TxStatus.Queued);
  if (!claim || claim.noteIds?.length !== 1) throw new Error('Epoch claim contains unrelated notes');
  assertNeverStartedBuilding(claim, 'before verified Epoch return claim release', TxStatus.Queued);
  const unexpected = (await readTransactionRows(wallet.page)).filter(
    row =>
      row.id !== claim?.id &&
      row.id !== blocker &&
      row.accountId &&
      canonicalMainnetLoopFaucet(row.accountId) === state.accountHex &&
      row.status === TxStatus.Queued
  );
  if (unexpected.length || signal.aborted) throw new Error('Epoch claim queue is unrelated or aborted');
  await releaseQueueBlocker(wallet.page, blocker);
  await releaseMainnetConsumeAuthorization(wallet.page, consume, {
    checkpointPath: path,
    gatePath: `${gatePath}.claim`,
    signal,
    persist: async authority => {
      state.consumeAuthority = authority;
      await persist();
    }
  });
  const receipt = await waitForTransactionRow(
    wallet.page,
    claim.id,
    row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
    { what: 'the exact Epoch return consume receipt', timeoutMs: 300_000 }
  );
  if (
    receipt.status !== TxStatus.Completed ||
    !receipt.transactionId ||
    !isHash(receipt.transactionId) ||
    receipt.feeAmount === undefined ||
    !/^(0|[1-9]\d*)$/.test(receipt.feeAmount) ||
    !receipt.feeFaucetId ||
    canonicalMainnetLoopFaucet(receipt.feeFaucetId) !== state.native.hex
  )
    throw new Error('Missing exact Epoch return fee receipt');
  state.returnMidenTxId = receipt.transactionId;
  state.reverseReceived = amount.toString();
  state.paidMidenFees = (BigInt(state.paidMidenFees) + BigInt(receipt.feeAmount)).toString();
  await finishEpochReturn(wallet, state, path);
}

async function finishEpochReturn(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string
): Promise<void> {
  if (!state.returnMidenTxId || !isHash(state.returnMidenTxId) || !state.reverseReceived || !state.consumeAuthority)
    throw new Error('Missing original actual native receipt; never infer it from recovered history');
  const account = getAddress(state.evm.account);
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const tokenBalance = () =>
    client.readContract({
      address: getAddress(state.evm.token),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account]
    });
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  await wallet.refreshBalancesLanded(90_000);
  const native = await vaultBalanceByFaucetId(wallet.page, state.native.faucetId);
  const evmToken = await tokenBalance();
  const evmNative = await client.getBalance({ address: account });
  state.after = { native: native.toString(), evmToken: evmToken.toString(), evmNative: evmNative.toString() };
  const valuation = state.reverseAuthority?.valuation;
  state.realizedCostUsdMicros = realizedMainnetLoopLoss([
    {
      identity: `miden:${state.native.hex}`,
      decimals: 6,
      usdMicros: BigInt(valuation?.stableUsdMicros ?? state.native.usdMicros),
      before: BigInt(state.native.balance),
      after: native
    },
    {
      identity: `evm:${state.evm.chainId}:${state.evm.token.toLowerCase()}`,
      decimals: 6,
      usdMicros: BigInt(valuation?.stableUsdMicros ?? state.evm.tokenUsdMicros),
      before: BigInt(state.evm.tokenBalance),
      after: evmToken
    },
    {
      identity: `evm:${state.evm.chainId}:native`,
      decimals: 18,
      usdMicros: BigInt(valuation?.gasUsdMicros ?? state.evm.nativeUsdMicros),
      before: BigInt(state.evm.nativeBalance),
      after: evmNative
    }
  ]).toString();
  state.phase = 'complete';
  await persist();
}

/** Reconcile already signed transactions; this path has no EVM signer or broadcast operation. */
export async function recoverEpochReturn(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  if (!state.transactions?.length || (await wallet.getAccountAddress()) !== state.account)
    throw new Error('Epoch return recovery requires an unresolved original signed journal');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  try {
    if ((await client.getChainId()) !== state.evm.chainId) throw new Error('Epoch recovery RPC chain changed');
    const evidence: EpochEvmRecoveryEvidence[] = [];
    for (const entry of state.transactions) {
      if (signal.aborted) throw new Error('Epoch recovery aborted');
      const hash = entry.hash;
      if (!hash || !isHash(hash)) throw new Error('Unknown Epoch submission hash; never retry funding');
      evidence.push({
        transaction: await client.getTransaction({ hash }),
        receipt: await client.getTransactionReceipt({ hash })
      });
    }
    const confirmed = reconcileEpochEvmReceipts(state, evidence);
    await persist();
    if (!confirmed) throw new Error('No successful original Epoch deposit; fees recorded, further signing blocked');
    if (state.returnMidenTxId) {
      await finishEpochReturn(wallet, state, path);
    } else {
      const blocker = await plantQueueBlocker(wallet.page);
      await settleEpochReturn(wallet, state, path, blocker, gatePath, signal);
    }
  } catch (error) {
    state.phase = 'recovery-required';
    await persist();
    throw error;
  }
}

/** Refund-only: consumes the original matured collateral, never creates another provider deposit. */
export async function runEpochRefund(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  if (
    !state.forwardNoteId ||
    !state.forwardAuthority ||
    state.forwardReceived ||
    state.transactions?.length ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Epoch refund requires original unresolved collateral only');
  if (state.returnMidenTxId) {
    if (!isHash(state.returnMidenTxId) || !state.consumeAuthority || state.returnNoteId !== state.forwardNoteId)
      throw new Error('Missing original actual collateral refund receipt');
    await finishEpochRefund(wallet, state, path);
    return;
  }
  if (state.consumeAuthority) throw new Error('Original refund authorization has an unknown outcome; never retry');
  const noteId = state.forwardNoteId;
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const account = getAddress(state.evm.account);
  const tokenBalance = () =>
    client.readContract({
      address: getAddress(state.evm.token),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account]
    });
  if (
    (await tokenBalance()) !== BigInt(state.evm.tokenBalance) ||
    (await client.getBalance({ address: account })) !== BigInt(state.evm.nativeBalance)
  )
    throw new Error('Epoch collateral may have settled or EVM assets changed; refund is not safe');
  const blocker = await plantQueueBlocker(wallet.page);
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  try {
    await wallet.triggerSync(true);
    const file = await exportMakerNote(wallet, noteId, 90_000);
    const bytes = Buffer.from(file, 'hex');
    const amount = inspectEpochRefundNote(state, bytes, await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl));
    const rows = await readTransactionRowsWithBytes(wallet.page, 'bridged-send');
    const minted = rows.filter(row => row.outputNoteIds?.includes(noteId) && row.status === TxStatus.Completed);
    if (state.paidMidenFees === '0') {
      if (
        minted.length !== 1 ||
        minted[0]?.feeAmount === undefined ||
        !minted[0].feeFaucetId ||
        canonicalMainnetLoopFaucet(minted[0].feeFaucetId) !== state.native.hex ||
        !/^(0|[1-9]\d*)$/.test(minted[0].feeAmount)
      )
        throw new Error('Missing actual original collateral fee evidence; do not estimate it from a vault delta');
      state.paidMidenFees = minted[0].feeAmount;
      if (minted[0].transactionId) state.forwardMidenTxId = minted[0].transactionId;
    }
    const before = await vaultBalanceByFaucetId(wallet.page, state.native.faucetId);
    if (before !== BigInt(state.native.balance) - amount - BigInt(state.paidMidenFees))
      throw new Error('Epoch refund portfolio differs from its original receipts');
    state.phase = 'recovery-required';
    state.returnNoteId = noteId;
    await persist();
    const consume = await armMainnetConsumeAuthorization(wallet.page, {
      accountId: state.accountHex,
      noteId,
      canonicalSha256: mainnetConsumeRequestHash(bytes)
    });
    await wallet.navigateTo(ACTIVITY_PENDING_PATH);
    await wallet.page
      .locator(`[data-pending-note-id="${noteId}"]`)
      .getByRole('button', { name: /^Accept$/ })
      .click();
    let claim: TransactionRowSnapshot | undefined;
    await expect
      .poll(
        async () => {
          const matches = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
            row.noteIds?.includes(noteId)
          );
          if (matches.length > 1) throw new Error('Ambiguous Epoch collateral refund rows');
          claim = matches[0];
          return claim?.status;
        },
        { timeout: 60_000 }
      )
      .toBe(TxStatus.Queued);
    if (!claim || claim.noteIds?.length !== 1) throw new Error('Epoch refund contains unrelated inputs');
    assertNeverStartedBuilding(claim, 'before original Epoch refund release', TxStatus.Queued);
    const other = (await readTransactionRows(wallet.page)).filter(
      row =>
        row.id !== claim?.id &&
        row.id !== blocker &&
        row.accountId &&
        canonicalMainnetLoopFaucet(row.accountId) === state.accountHex &&
        row.status === TxStatus.Queued
    );
    if (other.length || signal.aborted) throw new Error('Epoch refund queue is unrelated or aborted');
    await releaseQueueBlocker(wallet.page, blocker);
    await releaseMainnetConsumeAuthorization(wallet.page, consume, {
      checkpointPath: path,
      gatePath,
      signal,
      persist: async authority => {
        state.consumeAuthority = authority;
        await persist();
      }
    });
    const receipt = await waitForTransactionRow(
      wallet.page,
      claim.id,
      row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
      { what: 'original Epoch collateral refund receipt', timeoutMs: 300_000 }
    );
    if (
      receipt.status !== TxStatus.Completed ||
      !receipt.transactionId ||
      !isHash(receipt.transactionId) ||
      receipt.feeAmount === undefined ||
      !/^(0|[1-9]\d*)$/.test(receipt.feeAmount) ||
      !receipt.feeFaucetId ||
      canonicalMainnetLoopFaucet(receipt.feeFaucetId) !== state.native.hex
    )
      throw new Error('Missing actual Epoch refund fee receipt');
    state.paidMidenFees = (BigInt(state.paidMidenFees) + BigInt(receipt.feeAmount)).toString();
    state.returnMidenTxId = receipt.transactionId;
    await finishEpochRefund(wallet, state, path);
  } catch (error) {
    state.phase = 'recovery-required';
    await persist();
    throw error;
  }
}

async function finishEpochRefund(
  wallet: GuardianAwareWalletPage,
  state: MainnetEpochCheckpoint,
  path: string
): Promise<void> {
  const account = getAddress(state.evm.account);
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const tokenBalance = () =>
    client.readContract({
      address: getAddress(state.evm.token),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account]
    });
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetEpochCheckpoint(path, state);
  };
  await wallet.refreshBalancesLanded(90_000);
  const native = await vaultBalanceByFaucetId(wallet.page, state.native.faucetId);
  const evmToken = await tokenBalance();
  const evmNative = await client.getBalance({ address: account });
  if (
    native !== BigInt(state.native.balance) - BigInt(state.paidMidenFees) ||
    evmToken !== BigInt(state.evm.tokenBalance) ||
    evmNative !== BigInt(state.evm.nativeBalance)
  )
    throw new Error('Epoch refund does not equal original principal minus actual fees');
  state.after = { native: native.toString(), evmToken: evmToken.toString(), evmNative: evmNative.toString() };
  state.realizedCostUsdMicros = realizedMainnetLoopLoss([
    {
      identity: `miden:${state.native.hex}`,
      decimals: 6,
      usdMicros: BigInt(state.native.usdMicros),
      before: BigInt(state.native.balance),
      after: native
    }
  ]).toString();
  if (BigInt(state.realizedCostUsdMicros) > BigInt(state.lossBudgetUsdMicros))
    throw new Error('Epoch refund exceeds original loss allowance');
  state.phase = 'cancelled';
  await persist();
}
