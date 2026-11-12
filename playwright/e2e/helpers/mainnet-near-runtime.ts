import { mkdirSync, writeFileSync } from 'node:fs';
import { privateKeyToAddress } from 'viem/accounts';
import { expect } from '@playwright/test';
import { createPublicClient, getAddress, http, isHash } from 'viem';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import { fromBaseUnits, vaultBalanceByFaucetId, walletDiscoveredBaseFee, walletDiscoveredNativeFaucetId } from './balance-truth';
import { loadMainnetNearCheckpoint, parseMainnetNearCheckpoint, saveMainnetNearCheckpoint, type MainnetNearCheckpoint } from './mainnet-near-checkpoint';
import { loadMainnetSwapCheckpoint } from './mainnet-swap-checkpoint';
import { loadMainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';
import { remainingMainnetLoopBudget } from './mainnet-loop-budget';
import { canonicalMainnetLoopFaucet } from './mainnet-loop-config';
import { restoreMainnetLoopGuardian } from './mainnet-loop-wallet';
import { loadMainnetOneClickSetup } from './mainnet-one-click-config';
import { readMainnetEvmHolding } from './mainnet-one-click-evm';
import { createMainnetOneClickOriginFetcher } from './mainnet-one-click-origin';
import { fetchMainnetOneClickUsdPrices, mainnetOneClickPriceId } from './mainnet-one-click-prices';
import { prepareMainnetNearRoundTrip, selectMainnetNearNativeAsset, type MainnetNearPlanningFacts } from './mainnet-near-plan';
import { assertOneClickQuoteBinding, fetchOneClickStatus, OneClickHttpError, requestOneClickQuote } from '../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../src/lib/one-click/signature';
import { assertOneClickFundingDeadline } from '../../../src/lib/one-click/deadline';
import type { OneClickStatusResponse } from '../../../src/lib/one-click/types';
import { armMainnetSendAuthorization, releaseMainnetSendAuthorization } from './mainnet-send-authorization';
import { captureMainnetOneClickReviewQuote, confirmMainnetOneClickReview } from './mainnet-one-click-ui';
import { assertNeverStartedBuilding, plantQueueBlocker, readTransactionRows, readTransactionRowsWithBytes,
  releaseQueueBlocker, TxStatus, waitForSendRow } from './history';
import { readMainnetMidenOwnNoteCreator } from './mainnet-miden-indexer';
import { verifyMainnetMidenNoteInclusion } from './mainnet-miden-read';
import { inspectMainnetNearForwardReceipt } from './mainnet-near-evm';
import { getEnvironmentConfig } from '../config/environments';
import { mainnetChain, mainnetRpc } from './mainnet-bridge-sources';

export const MAINNET_NEAR_STATE_PATH = 'test-results/mainnet-1click-state/roundtrip.json';

export async function runMainnetNearStage(wallet: GuardianAwareWalletPage, mode: string): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID;
  if (process.env.E2E_NETWORK !== 'mainnet' || !runId || !/^[1-9]\d{0,19}$/.test(runId) ||
      process.env.GITHUB_RUN_ATTEMPT !== '1' || !['recover', 'prepare', 'forward', 'reverse'].includes(mode))
    throw new Error('Native NEAR requires an explicit first-attempt mainnet workflow stage');
  const previous = loadMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH);
  if (mode === 'recover') {
    if (previous?.consumeAuthority && !previous.returnMidenTxId)
      throw new Error('Original native NEAR claim has an unknown outcome; never retry or renew it');
    if (previous && !['complete', 'unspent', 'cancelled'].includes(previous.phase))
      throw new Error('Original native NEAR principal requires exact provider and chain reconciliation before fresh funding');
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/mainnet-near-recovery.json', `${JSON.stringify({ recoveryOnly: false })}\n`);
    return;
  }
  if (mode === 'forward' && (!previous || previous.sourceRunId !== runId || previous.authorizationRunId !== runId ||
      previous.phase !== 'forward-authorized' || previous.sendAuthority || previous.forwardMidenTxId))
    throw new Error('Native NEAR requires unused same-run forward authority');
  // shortcut: fresh funding stays disabled until real recovery adapters and the all-provider workflow barrier are wired.
  if (mode !== 'prepare') throw new Error('Native NEAR funded stage is not enabled before integrated recovery');
  if (previous && !['complete', 'unspent', 'cancelled'].includes(previous.phase))
    throw new Error('Cannot replace unresolved original native NEAR authority');
  if (previous?.sourceRunId === runId) throw new Error('Native NEAR authority already exists for this source run');
  const swap = loadMainnetSwapCheckpoint('test-results/mainnet-swap-state/roundtrip.json');
  const epoch = loadMainnetEpochCheckpoint('test-results/mainnet-epoch-state/roundtrip.json');
  const allowance = remainingMainnetLoopBudget(runId, 'near', [{ provider: 'swap', checkpoint: swap }, { provider: 'epoch', checkpoint: epoch }]);
  const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
  const key = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
  if (!keyPair || !/^[0-9a-f]{64}$/i.test(key)) throw new Error('Existing funded Guardian and EVM keys are required');
  const evmAccount = privateKeyToAddress(`0x${key}`);
  await restoreMainnetLoopGuardian(wallet, keyPair);
  const account = await wallet.getAccountAddress();
  if (swap?.account !== account || epoch?.account !== account)
    throw new Error('Native NEAR and both predecessor costs must belong to the same existing Guardian');
  const setup = await loadMainnetOneClickSetup(fetch, fetch, wallet.extensionId);
  if (!setup) throw new Error('Requested native NEAR coverage requires the owned live nightly catalog/config overlay');
  const faucet = await walletDiscoveredNativeFaucetId(wallet.page);
  const baseFee = await walletDiscoveredBaseFee(wallet.page);
  if (!faucet || baseFee === null || baseFee < 1) throw new Error('Missing actual native faucet or fee metadata');
  const nativeHex = canonicalMainnetLoopFaucet(faucet);
  const balance = await vaultBalanceByFaucetId(wallet.page, faucet);
  const nativeAsset = selectMainnetNearNativeAsset(setup.assets, nativeHex, balance, BigInt(baseFee) * 60n);
  const verifiedNative = setup.config.midenAssets.find(asset => asset.assetId === nativeAsset.assetId &&
    canonicalMainnetLoopFaucet(asset.faucetId) === nativeHex);
  if (!verifiedNative) throw new Error('Missing on-chain verified native price binding');
  const assets = setup.assets.filter(asset => (asset.chainId === 1 || asset.chainId === 42161) &&
    /^(USDC|USDT|USDT0)$/i.test(asset.symbol) && asset.decimals === 6 && asset.contractAddress &&
    asset.contractAddress !== 'native' && asset.coingeckoId).sort((left, right) =>
      (left.chainId === 42161 ? 0 : 1) - (right.chainId === 42161 ? 0 : 1)).slice(0, 4);
  if (!assets.length) throw new Error('Requested native NEAR coverage has no supported metadata-verified stablecoin return');
  const nativePriceId = mainnetOneClickPriceId(nativeAsset, verifiedNative);
  const prices = await fetchMainnetOneClickUsdPrices([...new Set([nativePriceId, 'ethereum',
    ...assets.map(asset => mainnetOneClickPriceId(asset, verifiedNative))])]);
  const nativePrice = prices.usdMicrosById[nativePriceId]; const gasPrice = prices.usdMicrosById.ethereum;
  if (!nativePrice || !gasPrice) throw new Error('Missing original native or EVM gas USD price');
  const candidates: MainnetNearPlanningFacts['candidates'] = [];
  for (const asset of assets) {
    const tokenPrice = prices.usdMicrosById[mainnetOneClickPriceId(asset, verifiedNative)];
    if (!tokenPrice) throw new Error('Missing source-specific EVM token price');
    candidates.push({ holding: await readMainnetEvmHolding(asset, evmAccount), tokenUsdMicros: tokenPrice, gasUsdMicros: gasPrice });
  }
  const fetcher = createMainnetOneClickOriginFetcher(setup.config.serviceUrl, wallet.extensionId);
  const state = await prepareMainnetNearRoundTrip({ account, accountHex: canonicalMainnetLoopFaucet(account), evmAccount,
    sourceRunId: runId, pricedAt: prices.fetchedAt, native: { faucetId: faucet, hex: nativeHex, symbol: 'USDCX', decimals: 6,
      balance: balance.toString(), usdMicros: nativePrice.toString() }, baseFee: BigInt(baseFee), lossBudgetUsdMicros: allowance,
    config: setup.config, nativeAsset, candidates }, async request => {
      try { return await requestOneClickQuote(setup.config, request, true, fetcher); }
      catch (error) { if (error instanceof OneClickHttpError && error.status === 400) return undefined; throw error; }
    });
  saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
}

export async function runMainnetNearForward(
  wallet: GuardianAwareWalletPage, state: MainnetNearCheckpoint, gatePath: string, signal: AbortSignal
): Promise<void> {
  parseMainnetNearCheckpoint(state);
  const age = Date.now() - Date.parse(state.pricedAt);
  if (state.sourceRunId !== process.env.GITHUB_RUN_ID || state.phase !== 'forward-authorized' || state.sendAuthority ||
      state.forwardMidenTxId || age < 0 || age > 600_000 || signal.aborted || await wallet.getAccountAddress() !== state.account)
    throw new Error('Original native NEAR forward authority is stale, used or belongs to another actor');
  const setup = await loadMainnetOneClickSetup(fetch, fetch, wallet.extensionId);
  if (!setup || setup.config.serviceUrl !== state.serviceUrl ||
      JSON.stringify(setup.config.appFees ?? []) !== JSON.stringify(state.appFees) ||
      JSON.stringify(setup.config.feePolicy) !== JSON.stringify(state.feePolicy))
    throw new Error('Native NEAR config differs from the original uploaded authority');
  const native = setup.assets.find(asset => asset.assetId === state.nativeAssetId);
  const evm = setup.assets.find(asset => asset.assetId === state.evmAssetId);
  if (!native || !evm || evm.chainId !== state.evm.chainId || evm.contractAddress?.toLowerCase() !== state.evm.token.toLowerCase())
    throw new Error('Original native NEAR asset bindings are unavailable');
  const holding = await readMainnetEvmHolding(evm, getAddress(state.evm.account));
  if (holding.balanceBaseUnits !== BigInt(state.evm.tokenBalance) || holding.nativeBalanceWei !== BigInt(state.evm.nativeBalance) ||
      await vaultBalanceByFaucetId(wallet.page, state.native.faucetId) !== BigInt(state.native.balance))
    throw new Error('Native NEAR portfolio changed before funding');
  const persist = async () => { state.updatedAt = new Date().toISOString(); saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state); };
  const blocker = await plantQueueBlocker(wallet.page);
  await wallet.navigateTo('/swap');
  const quote = await captureMainnetOneClickReviewQuote(wallet, { payNetwork: 'miden', payAssetId: native.assetId,
    receiveNetwork: evm.blockchain, receiveAssetId: evm.assetId, amount: fromBaseUnits(BigInt(state.principal), 6), externalAddress: state.evm.account },
    { originAsset: native.assetId, destinationAsset: evm.assetId, amount: BigInt(state.principal), refundTo: state.account, recipient: state.evm.account });
  const requestDeadline = quote.quoteRequest.deadline;
  if (!requestDeadline || !quote.quote.depositAddress || quote.quote.depositMemo !== undefined || quote.quote.refundFee === undefined)
    throw new Error('Native NEAR requires an exact simple deposit with original expiry and bounded refund');
  assertOneClickQuoteBinding({ originAsset: native, destinationAsset: evm, amount: state.principal, refundTo: state.account,
    recipient: state.evm.account, deadline: requestDeadline, slippageTolerance: 100 }, quote, false, setup.config);
  const deadline = assertOneClickFundingDeadline(requestDeadline, quote.quote.deadline);
  state.forwardQuote = { quoteHash: hashOneClickQuote(quote), correlationId: quote.correlationId, depositAddress: quote.quote.depositAddress,
    deadline, amountIn: quote.quote.amountIn, minimumOutput: quote.quote.minAmountOut, refundFee: quote.quote.refundFee };
  await persist();
  const handle = await armMainnetSendAuthorization(wallet.page, { accountId: state.accountHex,
    recipientId: canonicalMainnetLoopFaucet(quote.quote.depositAddress), faucetId: state.native.hex, amount: state.principal,
    expiresAt: Math.min(Date.parse(deadline), Date.parse(state.pricedAt) + 600_000) });
  await confirmMainnetOneClickReview(wallet.page);
  const queued = await waitForSendRow(wallet.page, { recipient: quote.quote.depositAddress, amountBaseUnits: BigInt(state.principal), status: TxStatus.Queued });
  assertNeverStartedBuilding(queued, 'before exact native NEAR send authorization', TxStatus.Queued);
  const unrelated = (await readTransactionRows(wallet.page)).filter(row => row.id !== queued.id && row.id !== blocker &&
    row.status === TxStatus.Queued && row.accountId && canonicalMainnetLoopFaucet(row.accountId) === state.accountHex);
  if (unrelated.length || signal.aborted) throw new Error('Native NEAR forward queue is unrelated or aborted');
  await releaseQueueBlocker(wallet.page, blocker);
  await releaseMainnetSendAuthorization(wallet.page, handle, { checkpointPath: MAINNET_NEAR_STATE_PATH, gatePath, signal,
    persist: async authority => { state.sendAuthority = authority; await persist(); } });
  await waitForSendRow(wallet.page, { recipient: quote.quote.depositAddress, amountBaseUnits: BigInt(state.principal),
    status: TxStatus.Completed, requireTransactionId: true, timeoutMs: 300_000 });
  const rows = (await readTransactionRowsWithBytes(wallet.page, 'send')).filter(row => row.id === queued.id);
  const row = rows[0]; const noteId = state.sendAuthority?.noteId;
  if (rows.length !== 1 || !row || !noteId || row.status !== TxStatus.Completed || !row.outputNoteIds?.includes(noteId) ||
      !row.transactionId || !isHash(row.transactionId) || !row.feeAmount || !/^[1-9]\d*$/.test(row.feeAmount) || !row.feeFaucetId ||
      canonicalMainnetLoopFaucet(row.feeFaucetId) !== state.native.hex)
    throw new Error('Missing actual native NEAR source transaction, output note or fee receipt');
  const creator = await readMainnetMidenOwnNoteCreator(noteId, state.accountHex);
  if (creator.transactionId !== row.transactionId.toLowerCase()) throw new Error('Native NEAR source transaction differs from its actual note creator');
  await verifyMainnetMidenNoteInclusion(getEnvironmentConfig().rpcUrl, noteId, creator.blockNumber, state.accountHex);
  state.forwardMidenTxId = creator.transactionId; state.paidMidenFees = row.feeAmount; await persist();
  const fetcher = createMainnetOneClickOriginFetcher(state.serviceUrl, wallet.extensionId);
  let settled: OneClickStatusResponse | undefined;
  await expect.poll(async () => {
    if (signal.aborted) throw new Error('Native NEAR settlement was aborted');
    settled = await fetchOneClickStatus(setup.config, quote.quote.depositAddress ?? '', undefined, quote, fetcher);
    if (settled.status === 'FAILED' || settled.status === 'REFUNDED') throw new Error('Original native NEAR deposit requires recovery; never retry funding');
    return settled.status;
  }, { timeout: 900_000, intervals: [5000, 10000, 15000] }).toBe('SUCCESS');
  const hashes = settled?.swapDetails.destinationChainTxHashes;
  const hash = hashes?.[0]?.hash.toLowerCase();
  if (hashes?.length !== 1 || !hash || !isHash(hash)) throw new Error('Missing unique provider-correlated native NEAR destination transaction');
  const client = createPublicClient({ chain: mainnetChain(state.evm.chainId), transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 }) });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const received = inspectMainnetNearForwardReceipt(state, hash, receipt);
  const after = await readMainnetEvmHolding(evm, getAddress(state.evm.account));
  await wallet.refreshBalancesLanded(90_000);
  if (after.balanceBaseUnits !== BigInt(state.evm.tokenBalance) + received || after.nativeBalanceWei !== BigInt(state.evm.nativeBalance) ||
      await vaultBalanceByFaucetId(wallet.page, state.native.faucetId) !== BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees))
    throw new Error('Native NEAR forward portfolio differs from its exact attributed receipts');
  state.forwardEvmTxHash = hash; state.forwardReceived = received.toString(); state.phase = 'forward-settled'; await persist();
}
