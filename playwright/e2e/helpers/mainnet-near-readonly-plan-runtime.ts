import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { expect } from '@playwright/test';
import { createPublicClient, erc20Abi, getAddress, http, isHash, isHex, type Hash } from 'viem';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import {
  fromBaseUnits,
  vaultBalanceByFaucetId,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from './balance-truth';
import {
  loadMainnetNearCheckpoint,
  parseMainnetNearCheckpoint,
  saveMainnetNearCheckpoint,
  type MainnetNearCheckpoint
} from './mainnet-near-checkpoint';
import { loadMainnetSwapCheckpoint } from './mainnet-swap-checkpoint';
import { loadMainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';
import { realizedMainnetLoopLoss, remainingMainnetLoopBudget } from './mainnet-loop-budget';
import { canonicalMainnetLoopFaucet } from './mainnet-loop-config';
import { restoreMainnetLoopGuardian } from './mainnet-loop-wallet';
import { loadMainnetOneClickSetup } from './mainnet-one-click-config';
import { createMainnetOneClickEvmSender, readMainnetEvmHolding } from './mainnet-one-click-evm';
import { createMainnetOneClickOriginFetcher } from './mainnet-one-click-origin';
import { fetchMainnetOneClickUsdPrices, mainnetOneClickPriceId } from './mainnet-one-click-prices';
import {
  prepareMainnetNearRoundTrip,
  selectMainnetNearNativeAsset,
  type MainnetNearPlanningFacts
} from './mainnet-near-plan';
import {
  assertOneClickQuoteBinding,
  fetchOneClickStatus,
  ONE_CLICK_EVM_CHAIN_IDS,
  OneClickHttpError,
  requestOneClickQuote,
  submitOneClickDeposit
} from '../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../src/lib/one-click/signature';
import { assertOneClickFundingDeadline } from '../../../src/lib/one-click/deadline';
import type { OneClickConfig, OneClickStatusResponse } from '../../../src/lib/one-click/types';
import { armMainnetSendAuthorization, releaseMainnetSendAuthorization } from './mainnet-send-authorization';
import {
  captureMainnetOneClickReviewQuote,
  confirmMainnetOneClickReview,
  connectMainnetOneClickWallet,
  selectMainnetOneClickAssets
} from './mainnet-one-click-ui';
import {
  assertNeverStartedBuilding,
  plantQueueBlocker,
  readTransactionRows,
  readTransactionRowsWithBytes,
  releaseQueueBlocker,
  TxStatus,
  waitForSendRow,
  waitForTransactionRow,
  type TransactionRowSnapshot
} from './history';
import { readMainnetMidenOutputCandidates, readMainnetMidenOwnNoteCreator } from './mainnet-miden-indexer';
import { verifyMainnetMidenNoteInclusion } from './mainnet-miden-read';
import {
  createMainnetNearEvmBroadcast,
  inspectMainnetNearForwardReceipt,
  reconcileMainnetNearEvmReceipt
} from './mainnet-near-evm';
import { getEnvironmentConfig } from '../config/environments';
import { mainnetChain, mainnetRpc } from './mainnet-bridge-sources';
import { inspectMainnetReturnNote, mainnetConsumeRequestHash } from './mainnet-miden-request';
import { armMainnetConsumeAuthorization, releaseMainnetConsumeAuthorization } from './mainnet-consume-authorization';
import { exportPublicInputNote } from './swap';
import { awaitMainnetLoopAuthorization } from './mainnet-loop-authorization';
import { tokenValueUsdMicro } from './mainnet-one-click-plan';
import { WcCounterparty } from '../ios/helpers/wc-counterparty';

export const MAINNET_NEAR_STATE_PATH = 'test-results/mainnet-1click-state/roundtrip.json';

export async function runMainnetNearStage(wallet: GuardianAwareWalletPage, mode: string): Promise<void> {
  if(mode!=='prepare')throw new Error('Read-only NEAR plan forbids all execution modes');
  const runId = process.env.GITHUB_RUN_ID;
  if (
    process.env.E2E_NETWORK !== 'mainnet' ||
    !runId ||
    !/^[1-9]\d{0,19}$/.test(runId) ||
    process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    !['recover', 'prepare', 'forward', 'reverse'].includes(mode)
  )
    throw new Error('Native NEAR requires an explicit first-attempt mainnet workflow stage');
  const previous = loadMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH);
  if (mode === 'recover') {
    if (
      previous?.phase === 'forward-authorized' &&
      !previous.forwardQuote &&
      !previous.sendAuthority &&
      !previous.forwardMidenTxId &&
      !previous.forwardReceived &&
      !previous.reverseQuote &&
      previous.evmNonceBefore === undefined &&
      !previous.transactions?.length &&
      !previous.consumeAuthority &&
      previous.paidMidenFees === '0' &&
      previous.paidEvmFees === '0' &&
      process.env.MAINNET_NEAR_FORWARD_ATTEMPTED === 'false'
    ) {
      previous.phase = 'unspent';
      previous.updatedAt = new Date().toISOString();
      saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, previous);
    }
    if (previous?.consumeAuthority && !previous.returnMidenTxId)
      throw new Error('Original native NEAR claim has an unknown outcome; never retry or renew it');
    if (previous && !['complete', 'unspent', 'cancelled'].includes(previous.phase)) {
      if (!previous.forwardQuote || !previous.sendAuthority)
        throw new Error(
          'Original native NEAR principal is unresolved without its actual send fingerprint; never renew it'
        );
      const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
      if (!keyPair) throw new Error('Existing original Guardian key pair is required for native NEAR recovery');
      await restoreMainnetLoopGuardian(wallet, keyPair);
      if ((await wallet.getAccountAddress()) !== previous.account)
        throw new Error('Original native NEAR recovery Guardian changed');
      try {
        await recoverMainnetNear(
          wallet,
          previous,
          `${MAINNET_NEAR_STATE_PATH}.recover`,
          AbortSignal.timeout(1_100_000)
        );
      } catch {
        throw new Error(
          'Original native NEAR recovery blocked; retain its original public checkpoint, never renew uncertain authority'
        );
      }
      mkdirSync('test-results', { recursive: true });
      writeFileSync(
        'test-results/mainnet-near-recovery.json',
        `${JSON.stringify({ recoveryOnly: true, sourceRunId: previous.sourceRunId })}\n`
      );
      return;
    }
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/mainnet-near-recovery.json', `${JSON.stringify({ recoveryOnly: false })}\n`);
    return;
  }
  if (
    mode === 'forward' &&
    (!previous ||
      previous.sourceRunId !== runId ||
      previous.authorizationRunId !== runId ||
      previous.phase !== 'forward-authorized' ||
      previous.sendAuthority ||
      previous.forwardMidenTxId)
  )
    throw new Error('Native NEAR requires unused same-run forward authority');
  if (
    mode === 'reverse' &&
    (!previous ||
      previous.sourceRunId !== runId ||
      previous.phase !== 'forward-settled' ||
      previous.evmNonceBefore !== undefined ||
      previous.reverseQuote ||
      previous.returnAmount ||
      previous.transactions?.length ||
      previous.consumeAuthority)
  )
    throw new Error('Original native NEAR reverse authority is used or unresolved; never refresh it');
  if (mode !== 'prepare') {
    if (process.env.MAINNET_LOOP_RECOVERY_CLEARED !== 'true')
      throw new Error('The all-provider recovery barrier must clear before native NEAR funding');
    if (!previous) throw new Error('Missing original native NEAR authority');
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
    const key = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
    if (
      !keyPair ||
      !/^[0-9a-f]{64}$/i.test(key) ||
      privateKeyToAddress(`0x${key}`).toLowerCase() !== previous.evm.account.toLowerCase()
    )
      throw new Error('Existing original Guardian and EVM keys are required before native NEAR funding');
    await restoreMainnetLoopGuardian(wallet, keyPair);
    if ((await wallet.getAccountAddress()) !== previous.account)
      throw new Error('Original native NEAR Guardian changed');
    const signal = AbortSignal.timeout(1_100_000);
    try {
      if (mode === 'forward')
        await runMainnetNearForward(wallet, previous, `${MAINNET_NEAR_STATE_PATH}.forward`, signal);
      else await runMainnetNearReverse(wallet, previous, `${MAINNET_NEAR_STATE_PATH}.reverse`, signal);
    } catch {
      throw new Error(
        'Native NEAR stage blocked; retain original public authority and never retry uncertain submissions'
      );
    }
    return;
  }
  if (previous && !['complete', 'unspent', 'cancelled'].includes(previous.phase))
    throw new Error('Cannot replace unresolved original native NEAR authority');
  if (previous?.sourceRunId === runId) throw new Error('Native NEAR authority already exists for this source run');
  const swap = loadMainnetSwapCheckpoint('test-results/mainnet-swap-state/roundtrip.json');
  const epoch = loadMainnetEpochCheckpoint('test-results/mainnet-epoch-state/roundtrip.json');
  const epochPreview=JSON.parse(readFileSync('test-results/epoch-readonly-preview.json','utf8'));
  if(epochPreview.eligible!==true||epochPreview.grantPersisted!==false||epochPreview.sdkAuthorityIssued!==false)throw new Error('Read-only Epoch preview is not eligible');
  const originalAllowance=BigInt(process.env.MAINNET_LOOP_LOSS_BUDGET_USD_MICROS??'0');
  expect(originalAllowance).toBe(1997018n);
  const allowance=originalAllowance-BigInt(epochPreview.worstCaseCostUsdMicros);
  expect(allowance>0n).toBe(true);
  if (process.env.MAINNET_LOOP_RECOVERY_CLEARED !== 'true')
    throw new Error('The all-provider recovery barrier must clear before native NEAR preparation');
  const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
  const key = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
  if (!keyPair || !/^[0-9a-f]{64}$/i.test(key)) throw new Error('Existing funded Guardian and EVM keys are required');
  const evmAccount = privateKeyToAddress(`0x${key}`);
  await restoreMainnetLoopGuardian(wallet, keyPair);
  const account = await wallet.getAccountAddress();
  if (swap?.account !== account || epochPreview.account !== account)
    throw new Error('Native NEAR and both predecessor costs must belong to the same existing Guardian');
  const setup = await loadMainnetOneClickSetup(fetch, fetch, wallet.extensionId);
  if (!setup) throw new Error('Requested native NEAR coverage requires the owned live nightly catalog/config overlay');
  const faucet = await walletDiscoveredNativeFaucetId(wallet.page);
  const baseFee = await walletDiscoveredBaseFee(wallet.page);
  if (!faucet || baseFee === null || baseFee < 1) throw new Error('Missing actual native faucet or fee metadata');
  const nativeHex = canonicalMainnetLoopFaucet(faucet);
  const balance = await vaultBalanceByFaucetId(wallet.page, faucet);
  const nativeAsset = selectMainnetNearNativeAsset(setup.assets, nativeHex, balance, BigInt(baseFee) * 60n);
  const verifiedNative = setup.config.midenAssets.find(
    asset => asset.assetId === nativeAsset.assetId && canonicalMainnetLoopFaucet(asset.faucetId) === nativeHex
  );
  if (!verifiedNative) throw new Error('Missing on-chain verified native price binding');
  const assets = setup.assets
    .filter(
      asset =>
        (asset.chainId === 1 || asset.chainId === 42161) &&
        /^(USDC|USDT|USDT0)$/i.test(asset.symbol) &&
        asset.decimals === 6 &&
        asset.contractAddress &&
        asset.contractAddress !== 'native' &&
        asset.coingeckoId
    )
    .sort((left, right) => (left.chainId === 42161 ? 0 : 1) - (right.chainId === 42161 ? 0 : 1))
    .slice(0, 4);
  if (!assets.length)
    throw new Error('Requested native NEAR coverage has no supported metadata-verified stablecoin return');
  const nativePriceId = mainnetOneClickPriceId(nativeAsset, verifiedNative);
  const prices = await fetchMainnetOneClickUsdPrices([
    ...new Set([nativePriceId, 'ethereum', ...assets.map(asset => mainnetOneClickPriceId(asset, verifiedNative))])
  ]);
  const nativePrice = prices.usdMicrosById[nativePriceId];
  const gasPrice = prices.usdMicrosById.ethereum;
  if (!nativePrice || !gasPrice) throw new Error('Missing original native or EVM gas USD price');
  const candidates: MainnetNearPlanningFacts['candidates'] = [];
  for (const asset of assets) {
    const tokenPrice = prices.usdMicrosById[mainnetOneClickPriceId(asset, verifiedNative)];
    if (!tokenPrice) throw new Error('Missing source-specific EVM token price');
    candidates.push({
      holding: await readMainnetEvmHolding(asset, evmAccount),
      tokenUsdMicros: tokenPrice,
      gasUsdMicros: gasPrice
    });
  }
  const fetcher = createMainnetOneClickOriginFetcher(setup.config.serviceUrl, wallet.extensionId);
  const state = await prepareMainnetNearRoundTrip(
    {
      account,
      accountHex: canonicalMainnetLoopFaucet(account),
      evmAccount,
      sourceRunId: runId,
      pricedAt: prices.fetchedAt,
      native: {
        faucetId: faucet,
        hex: nativeHex,
        symbol: 'USDCX',
        decimals: 6,
        balance: balance.toString(),
        usdMicros: nativePrice.toString()
      },
      baseFee: BigInt(baseFee),
      lossBudgetUsdMicros: allowance,
      config: setup.config,
      nativeAsset,
      candidates
    },
    async request => {
      try {
        return await requestOneClickQuote(setup.config, request, true, fetcher);
      } catch (error) {
        if (error instanceof OneClickHttpError && error.status === 400) return undefined;
        throw error;
      }
    }
  );
  const keys=['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'];
  const policies=await wallet.page.evaluate(async names=>chrome.storage.local.get(names),keys);
  expect(keys.every(key=>policies[key]===undefined)).toBe(true);
  writeFileSync('test-results/near-readonly-preview.json',JSON.stringify({purpose:'independent read-only NEAR live two-way plan; candidate discarded, NOT accepted provider history',eligible:true,account:state.account,chainId:state.evm.chainId,principal:state.principal,forwardMinimum:state.forwardMinimum,reverseMinimum:state.reverseMinimum,lossBudgetUsdMicros:state.lossBudgetUsdMicros,epochWorstCostReserved:epochPreview.worstCaseCostUsdMicros,noLivePolicy:true,grantPersisted:false,sdkAuthorityIssued:false}));
}

export async function runMainnetNearForward(
  wallet: GuardianAwareWalletPage,
  state: MainnetNearCheckpoint,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  parseMainnetNearCheckpoint(state);
  const age = Date.now() - Date.parse(state.pricedAt);
  if (
    state.sourceRunId !== process.env.GITHUB_RUN_ID ||
    state.phase !== 'forward-authorized' ||
    state.sendAuthority ||
    state.forwardMidenTxId ||
    age < 0 ||
    age > 600_000 ||
    signal.aborted ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Original native NEAR forward authority is stale, used or belongs to another actor');
  const setup = await loadMainnetOneClickSetup(fetch, fetch, wallet.extensionId);
  if (
    !setup ||
    setup.config.serviceUrl !== state.serviceUrl ||
    JSON.stringify(setup.config.appFees ?? []) !== JSON.stringify(state.appFees) ||
    JSON.stringify(setup.config.feePolicy) !== JSON.stringify(state.feePolicy)
  )
    throw new Error('Native NEAR config differs from the original uploaded authority');
  const native = setup.assets.find(asset => asset.assetId === state.nativeAssetId);
  const evm = setup.assets.find(asset => asset.assetId === state.evmAssetId);
  if (
    !native ||
    !evm ||
    evm.chainId !== state.evm.chainId ||
    evm.contractAddress?.toLowerCase() !== state.evm.token.toLowerCase()
  )
    throw new Error('Original native NEAR asset bindings are unavailable');
  const holding = await readMainnetEvmHolding(evm, getAddress(state.evm.account));
  if (
    holding.balanceBaseUnits !== BigInt(state.evm.tokenBalance) ||
    holding.nativeBalanceWei !== BigInt(state.evm.nativeBalance) ||
    (await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)) !== BigInt(state.native.balance)
  )
    throw new Error('Native NEAR portfolio changed before funding');
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
  };
  const blocker = await plantQueueBlocker(wallet.page);
  await wallet.navigateTo('/swap');
  const quote = await captureMainnetOneClickReviewQuote(
    wallet,
    {
      payNetwork: 'miden',
      payAssetId: native.assetId,
      receiveNetwork: evm.blockchain,
      receiveAssetId: evm.assetId,
      amount: fromBaseUnits(BigInt(state.principal), 6),
      externalAddress: state.evm.account
    },
    {
      originAsset: native.assetId,
      destinationAsset: evm.assetId,
      amount: BigInt(state.principal),
      refundTo: state.account,
      recipient: state.evm.account
    }
  );
  const requestDeadline = quote.quoteRequest.deadline;
  if (
    !requestDeadline ||
    !quote.quote.depositAddress ||
    quote.quote.depositMemo !== undefined ||
    quote.quote.refundFee === undefined
  )
    throw new Error('Native NEAR requires an exact simple deposit with original expiry and bounded refund');
  assertOneClickQuoteBinding(
    {
      originAsset: native,
      destinationAsset: evm,
      amount: state.principal,
      refundTo: state.account,
      recipient: state.evm.account,
      deadline: requestDeadline,
      slippageTolerance: 100
    },
    quote,
    false,
    setup.config
  );
  const deadline = assertOneClickFundingDeadline(requestDeadline, quote.quote.deadline);
  state.forwardQuote = {
    quoteHash: hashOneClickQuote(quote),
    correlationId: quote.correlationId,
    depositAddress: quote.quote.depositAddress,
    deadline,
    amountIn: quote.quote.amountIn,
    minimumOutput: quote.quote.minAmountOut,
    refundFee: quote.quote.refundFee
  };
  await persist();
  const handle = await armMainnetSendAuthorization(wallet.page, {
    accountId: state.accountHex,
    recipientId: canonicalMainnetLoopFaucet(quote.quote.depositAddress),
    faucetId: state.native.hex,
    amount: state.principal,
    expiresAt: Math.min(Date.parse(deadline), Date.parse(state.pricedAt) + 600_000)
  });
  await confirmMainnetOneClickReview(wallet.page);
  const queued = await waitForSendRow(wallet.page, {
    recipient: quote.quote.depositAddress,
    amountBaseUnits: BigInt(state.principal),
    status: TxStatus.Queued
  });
  assertNeverStartedBuilding(queued, 'before exact native NEAR send authorization', TxStatus.Queued);
  const unrelated = (await readTransactionRows(wallet.page)).filter(
    row =>
      row.id !== queued.id &&
      row.id !== blocker &&
      row.status === TxStatus.Queued &&
      row.accountId &&
      canonicalMainnetLoopFaucet(row.accountId) === state.accountHex
  );
  if (unrelated.length || signal.aborted) throw new Error('Native NEAR forward queue is unrelated or aborted');
  await releaseQueueBlocker(wallet.page, blocker);
  const acknowledged = await releaseMainnetSendAuthorization(wallet.page, handle, {
    checkpointPath: MAINNET_NEAR_STATE_PATH,
    gatePath,
    signal,
    persist: async authority => {
      state.sendAuthority = authority;
      await persist();
    }
  });
  await waitForSendRow(wallet.page, {
    recipient: quote.quote.depositAddress,
    amountBaseUnits: BigInt(state.principal),
    status: TxStatus.Completed,
    requireTransactionId: true,
    timeoutMs: 300_000
  });
  const rows = (await readTransactionRowsWithBytes(wallet.page, 'send')).filter(row => row.id === queued.id);
  const row = rows[0];
  const noteId = acknowledged.noteId;
  if (
    rows.length !== 1 ||
    !row ||
    !noteId ||
    row.status !== TxStatus.Completed ||
    !row.outputNoteIds?.includes(noteId) ||
    !row.transactionId ||
    !isHash(row.transactionId) ||
    !row.feeAmount ||
    !/^[1-9]\d*$/.test(row.feeAmount) ||
    !row.feeFaucetId ||
    canonicalMainnetLoopFaucet(row.feeFaucetId) !== state.native.hex
  )
    throw new Error('Missing actual native NEAR source transaction, output note or fee receipt');
  const creator = await readMainnetMidenOwnNoteCreator(noteId, state.accountHex);
  if (creator.transactionId !== row.transactionId.toLowerCase())
    throw new Error('Native NEAR source transaction differs from its actual note creator');
  await verifyMainnetMidenNoteInclusion(getEnvironmentConfig().rpcUrl, noteId, creator.blockNumber, state.accountHex);
  state.forwardMidenTxId = creator.transactionId;
  state.paidMidenFees = row.feeAmount;
  await persist();
  const fetcher = createMainnetOneClickOriginFetcher(state.serviceUrl, wallet.extensionId);
  let settled: OneClickStatusResponse | undefined;
  await expect
    .poll(
      async () => {
        if (signal.aborted) throw new Error('Native NEAR settlement was aborted');
        settled = await fetchOneClickStatus(setup.config, quote.quote.depositAddress ?? '', undefined, quote, fetcher);
        if (settled.status === 'FAILED' || settled.status === 'REFUNDED')
          throw new Error('Original native NEAR deposit requires recovery; never retry funding');
        return settled.status;
      },
      { timeout: 900_000, intervals: [5000, 10000, 15000] }
    )
    .toBe('SUCCESS');
  const origins = settled?.swapDetails.originChainTxHashes;
  if (origins?.length !== 1 || origins[0]?.hash.toLowerCase() !== state.forwardMidenTxId)
    throw new Error('Native NEAR provider settlement does not identify the actual original source transaction');
  const hashes = settled?.swapDetails.destinationChainTxHashes;
  const hash = hashes?.[0]?.hash.toLowerCase();
  if (hashes?.length !== 1 || !hash || !isHash(hash))
    throw new Error('Missing unique provider-correlated native NEAR destination transaction');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const received = inspectMainnetNearForwardReceipt(state, hash, receipt);
  const after = await readMainnetEvmHolding(evm, getAddress(state.evm.account));
  await wallet.refreshBalancesLanded(90_000);
  if (
    after.balanceBaseUnits !== BigInt(state.evm.tokenBalance) + received ||
    after.nativeBalanceWei !== BigInt(state.evm.nativeBalance) ||
    (await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)) !==
      BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees)
  )
    throw new Error('Native NEAR forward portfolio differs from its exact attributed receipts');
  state.forwardEvmTxHash = hash;
  state.forwardReceived = received.toString();
  state.phase = 'forward-settled';
  await persist();
}

async function finishMainnetNearReturn(
  wallet: GuardianAwareWalletPage,
  state: MainnetNearCheckpoint,
  kind: 'return' | 'refund'
): Promise<void> {
  const returned = kind === 'return' ? state.reverseReceived : state.refunded;
  if (
    !state.returnMidenTxId ||
    !isHash(state.returnMidenTxId) ||
    !state.consumeAuthority ||
    !returned ||
    !state.returnNoteId ||
    !state.returnProviderTxId
  )
    throw new Error('Missing original actual native NEAR consume receipt; never infer it from labels or balances');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const account = getAddress(state.evm.account);
  const [token, gas] = await Promise.all([
    client.readContract({
      address: getAddress(state.evm.token),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account]
    }),
    client.getBalance({ address: account })
  ]);
  await wallet.refreshBalancesLanded(90_000);
  const native = await vaultBalanceByFaucetId(wallet.page, state.native.faucetId);
  if (
    native !==
      BigInt(state.native.balance) - BigInt(state.principal) + BigInt(returned) - BigInt(state.paidMidenFees) ||
    token !==
      BigInt(state.evm.tokenBalance) + BigInt(state.forwardReceived ?? '0') - BigInt(state.returnAmount ?? '0') ||
    gas !== BigInt(state.evm.nativeBalance) - BigInt(state.paidEvmFees)
  )
    throw new Error('Native NEAR final portfolio differs from original principal and actual attributed receipts');
  const prices = state.returnValuation;
  state.realizedCostUsdMicros = realizedMainnetLoopLoss([
    {
      identity: `miden:${state.native.hex}`,
      before: BigInt(state.native.balance),
      after: native,
      decimals: 6,
      usdMicros: BigInt(prices?.nativeUsdMicros ?? state.native.usdMicros)
    },
    {
      identity: `evm:${state.evm.chainId}:token:${state.evm.token.toLowerCase()}`,
      before: BigInt(state.evm.tokenBalance),
      after: token,
      decimals: 6,
      usdMicros: BigInt(prices?.tokenUsdMicros ?? state.evm.tokenUsdMicros)
    },
    {
      identity: `evm:${state.evm.chainId}:native`,
      before: BigInt(state.evm.nativeBalance),
      after: gas,
      decimals: 18,
      usdMicros: BigInt(prices?.gasUsdMicros ?? state.evm.nativeUsdMicros)
    }
  ]).toString();
  state.phase = kind === 'return' ? 'complete' : 'cancelled';
  state.updatedAt = new Date().toISOString();
  saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
}

export async function claimMainnetNearNote(
  wallet: GuardianAwareWalletPage,
  state: MainnetNearCheckpoint,
  providerHash: Hash,
  kind: 'return' | 'refund',
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  parseMainnetNearCheckpoint(state);
  if (
    state.consumeAuthority ||
    state.returnMidenTxId ||
    signal.aborted ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Original native NEAR claim may already have executed; never retry or refresh it');
  const minimum =
    kind === 'return'
      ? state.reverseQuote?.minimumOutput
      : state.forwardQuote
        ? (BigInt(state.principal) - BigInt(state.forwardQuote.refundFee)).toString()
        : undefined;
  if (!minimum || BigInt(minimum) <= 0n || (kind === 'refund' && (state.forwardReceived || state.transactions?.length)))
    throw new Error('Native NEAR note has no original bounded return or refund authority');
  const creator = await readMainnetMidenOutputCandidates(providerHash, state.accountHex);
  const blocker = await plantQueueBlocker(wallet.page);
  await wallet.triggerSync(true);
  await wallet.navigateTo('/history?filter=pending&view=list');
  let own: (string | null)[] = [];
  await expect
    .poll(
      async () => {
        if (signal.aborted) throw new Error('Native NEAR note discovery aborted');
        await wallet.triggerSync(true);
        own = await wallet.page
          .locator('[data-pending-note-id]')
          .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pending-note-id')));
        return creator.noteIds.some(id => own.includes(id));
      },
      { timeout: 90_000, intervals: [1000, 5000, 10000] }
    )
    .toBe(true);
  const valid: { noteId: string; bytes: Uint8Array; amount: bigint }[] = [];
  for (const noteId of creator.noteIds.filter(id => own.includes(id))) {
    const bytes = Buffer.from(await exportPublicInputNote(wallet, noteId), 'hex');
    let amount: bigint;
    try {
      amount = inspectMainnetReturnNote(
        { noteId, accountHex: state.accountHex, faucetHex: state.native.hex, minimumOutput: BigInt(minimum) },
        bytes
      );
    } catch {
      continue;
    }
    await verifyMainnetMidenNoteInclusion(
      getEnvironmentConfig().rpcUrl,
      noteId,
      creator.blockNumber,
      creator.senderHex
    );
    valid.push({ noteId, bytes, amount });
  }
  const selected = valid[0];
  if (valid.length !== 1 || !selected)
    throw new Error('Missing or ambiguous actual provider-correlated native NEAR P2ID');
  const existing = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
    row.noteIds?.includes(selected.noteId)
  );
  if (existing.length)
    throw new Error('Original native NEAR claim outcome already exists without captured authority; never retry');
  const before = await vaultBalanceByFaucetId(wallet.page, state.native.faucetId);
  if (before !== BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees))
    throw new Error('Native NEAR pre-claim portfolio differs from original actual receipts');
  state.returnProviderTxId = providerHash;
  state.returnNoteId = selected.noteId;
  state.updatedAt = new Date().toISOString();
  saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
  const handle = await armMainnetConsumeAuthorization(wallet.page, {
    accountId: state.accountHex,
    noteId: selected.noteId,
    canonicalSha256: mainnetConsumeRequestHash(selected.bytes, true)
  });
  await wallet.page
    .locator(`[data-pending-note-id="${selected.noteId}"]`)
    .getByRole('button', { name: /^Accept Transfer$/ })
    .click();
  let claim: TransactionRowSnapshot | undefined;
  await expect
    .poll(
      async () => {
        const rows = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
          row.noteIds?.includes(selected.noteId)
        );
        if (rows.length > 1) throw new Error('Ambiguous native NEAR consume rows');
        claim = rows[0];
        return claim?.status;
      },
      { timeout: 60_000 }
    )
    .toBe(TxStatus.Queued);
  if (!claim || claim.noteIds?.length !== 1) throw new Error('Native NEAR claim includes unrelated notes');
  assertNeverStartedBuilding(claim, 'before actual native NEAR consume byte authorization', TxStatus.Queued);
  const unrelated = (await readTransactionRows(wallet.page)).filter(
    row => row.id !== claim?.id && row.id !== blocker && row.status === TxStatus.Queued
  );
  if (unrelated.length || signal.aborted) throw new Error('Native NEAR claim queue is unrelated or aborted');
  await releaseQueueBlocker(wallet.page, blocker);
  await releaseMainnetConsumeAuthorization(wallet.page, handle, {
    checkpointPath: MAINNET_NEAR_STATE_PATH,
    gatePath: `${gatePath}.claim`,
    signal,
    persist: async authority => {
      state.consumeAuthority = authority;
      state.updatedAt = new Date().toISOString();
      saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
    }
  });
  const receipt = await waitForTransactionRow(
    wallet.page,
    claim.id,
    row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
    { what: 'the exact native NEAR consume receipt', timeoutMs: 300_000 }
  );
  if (
    receipt.status !== TxStatus.Completed ||
    !receipt.transactionId ||
    !isHash(receipt.transactionId) ||
    !receipt.feeAmount ||
    !/^[1-9]\d*$/.test(receipt.feeAmount) ||
    !receipt.feeFaucetId ||
    canonicalMainnetLoopFaucet(receipt.feeFaucetId) !== state.native.hex
  )
    throw new Error('Missing exact native NEAR consume transaction or actual fee receipt');
  state.returnMidenTxId = receipt.transactionId;
  state.paidMidenFees = (BigInt(state.paidMidenFees) + BigInt(receipt.feeAmount)).toString();
  if (kind === 'return') state.reverseReceived = selected.amount.toString();
  else state.refunded = selected.amount.toString();
  state.updatedAt = new Date().toISOString();
  saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
  await finishMainnetNearReturn(wallet, state, kind);
}

export async function runMainnetNearReverse(
  wallet: GuardianAwareWalletPage,
  state: MainnetNearCheckpoint,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  parseMainnetNearCheckpoint(state);
  if (
    state.phase !== 'forward-settled' ||
    !state.forwardReceived ||
    state.reverseQuote ||
    state.evmNonceBefore !== undefined ||
    state.transactions?.length ||
    state.consumeAuthority ||
    signal.aborted ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Original native NEAR reverse authority is used or unresolved; never refresh it');
  const rawKey = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
  const key = `0x${rawKey}`;
  if (
    !/^[0-9a-f]{64}$/i.test(rawKey) ||
    !isHex(key, { strict: true }) ||
    privateKeyToAddress(key).toLowerCase() !== state.evm.account.toLowerCase()
  )
    throw new Error('Native NEAR return requires the same existing funded EVM key');
  const setup = await loadMainnetOneClickSetup(fetch, fetch, wallet.extensionId);
  if (
    !setup ||
    setup.config.serviceUrl !== state.serviceUrl ||
    JSON.stringify(setup.config.appFees ?? []) !== JSON.stringify(state.appFees) ||
    JSON.stringify(setup.config.feePolicy) !== JSON.stringify(state.feePolicy)
  )
    throw new Error('Original native NEAR config changed');
  const native = setup.assets.find(asset => asset.assetId === state.nativeAssetId);
  const evm = setup.assets.find(asset => asset.assetId === state.evmAssetId);
  const verifiedNative = setup.config.midenAssets.find(
    asset => asset.assetId === state.nativeAssetId && canonicalMainnetLoopFaucet(asset.faucetId) === state.native.hex
  );
  if (
    !native ||
    !evm ||
    !verifiedNative ||
    evm.chainId !== state.evm.chainId ||
    evm.contractAddress?.toLowerCase() !== state.evm.token.toLowerCase()
  )
    throw new Error('Original native NEAR return bindings are unavailable');
  const account = getAddress(state.evm.account);
  const amount = BigInt(state.forwardReceived);
  const holding = await readMainnetEvmHolding(evm, account);
  if (
    holding.balanceBaseUnits !== BigInt(state.evm.tokenBalance) + amount ||
    holding.nativeBalanceWei !== BigInt(state.evm.nativeBalance) ||
    (await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)) !==
      BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees)
  )
    throw new Error('Native NEAR return portfolio differs from exact original attributed proceeds');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  const stopped = new AbortController();
  const activeSignal = AbortSignal.any([signal, stopped.signal]);
  let sender: ReturnType<typeof createMainnetOneClickEvmSender> | undefined;
  const counterparty = new WcCounterparty({
    privateKey: key,
    rpcUrl: mainnetRpc(state.evm.chainId),
    chainId: state.evm.chainId,
    sessionChainIds: Object.values(ONE_CLICK_EVM_CHAIN_IDS),
    send: async (transaction, sessionSignal) => {
      sessionSignal.addEventListener('abort', () => stopped.abort(), { once: true });
      if (sessionSignal.aborted) stopped.abort();
      try {
        if (!sender) throw new Error('Missing original reverse quote');
        return await sender.send(transaction, activeSignal);
      } catch {
        throw new Error('Native NEAR return blocked; inspect only its original public signed journal, never retry');
      }
    }
  });
  try {
    await wallet.navigateTo('/swap');
    const route = {
      payNetwork: evm.blockchain,
      payAssetId: evm.assetId,
      receiveNetwork: 'miden',
      receiveAssetId: native.assetId,
      amount: fromBaseUnits(amount, 6)
    };
    await selectMainnetOneClickAssets(wallet.page, route);
    await connectMainnetOneClickWallet(wallet, counterparty);
    const quote = await captureMainnetOneClickReviewQuote(
      wallet,
      route,
      {
        originAsset: evm.assetId,
        destinationAsset: native.assetId,
        amount,
        refundTo: state.evm.account,
        recipient: state.account
      },
      true
    );
    const requestDeadline = quote.quoteRequest.deadline;
    if (
      !requestDeadline ||
      !quote.quote.depositAddress ||
      quote.quote.depositMemo !== undefined ||
      quote.quote.refundFee === undefined
    )
      throw new Error('Original native NEAR return quote lacks its bounded simple deposit authority');
    const request = {
      originAsset: evm,
      destinationAsset: native,
      amount: amount.toString(),
      refundTo: state.evm.account,
      recipient: state.account,
      deadline: requestDeadline,
      slippageTolerance: 100
    };
    assertOneClickQuoteBinding(request, quote, false, setup.config);
    const deadline = assertOneClickFundingDeadline(requestDeadline, quote.quote.deadline);
    const nativePriceId = mainnetOneClickPriceId(native, verifiedNative);
    const tokenPriceId = mainnetOneClickPriceId(evm, verifiedNative);
    const prices = await fetchMainnetOneClickUsdPrices([...new Set([nativePriceId, tokenPriceId, 'ethereum'])]);
    const ceil = (current: bigint | undefined, original: string) => {
      if (!current || current <= 0n) throw new Error('Missing fresh native NEAR return market valuation');
      return current > BigInt(original) ? current : BigInt(original);
    };
    const nativePrice = ceil(prices.usdMicrosById[nativePriceId], state.native.usdMicros);
    const tokenPrice = ceil(prices.usdMicrosById[tokenPriceId], state.evm.tokenUsdMicros);
    const gasPrice = ceil(prices.usdMicrosById.ethereum, state.evm.nativeUsdMicros);
    const loss =
      BigInt(state.principal) > BigInt(quote.quote.minAmountOut)
        ? BigInt(state.principal) - BigInt(quote.quote.minAmountOut)
        : 0n;
    if (
      tokenValueUsdMicro(loss + BigInt(state.feeBudget), 6, nativePrice, true) +
        tokenValueUsdMicro(BigInt(state.evmFeeBudget), 18, gasPrice, true) >
      BigInt(state.lossBudgetUsdMicros)
    )
      throw new Error('Native NEAR actual return quote exceeds its original remaining shared allowance');
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: account, blockTag: 'latest' }),
      client.getTransactionCount({ address: account, blockTag: 'pending' })
    ]);
    if (latest !== pending || activeSignal.aborted)
      throw new Error('Original native NEAR EVM actor has unresolved pending activity');
    state.reverseQuote = {
      quoteHash: hashOneClickQuote(quote),
      correlationId: quote.correlationId,
      depositAddress: quote.quote.depositAddress,
      deadline,
      amountIn: quote.quote.amountIn,
      minimumOutput: quote.quote.minAmountOut,
      refundFee: quote.quote.refundFee
    };
    state.returnAmount = amount.toString();
    state.evmNonceBefore = latest;
    state.returnValuation = {
      pricedAt: prices.fetchedAt,
      nativeUsdMicros: nativePrice.toString(),
      tokenUsdMicros: tokenPrice.toString(),
      gasUsdMicros: gasPrice.toString()
    };
    state.phase = 'reverse-authorized';
    state.updatedAt = new Date().toISOString();
    saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
    const originalAuthority = JSON.stringify(state);
    await awaitMainnetLoopAuthorization(MAINNET_NEAR_STATE_PATH, gatePath, activeSignal);
    if (JSON.stringify(state) !== originalAuthority || hashOneClickQuote(quote) !== state.reverseQuote?.quoteHash)
      throw new Error('Original native NEAR return authority changed during upload');
    sender = createMainnetOneClickEvmSender({
      holding,
      account,
      config: setup.config,
      gasBudgetWei: BigInt(state.evmFeeBudget),
      broadcast: createMainnetNearEvmBroadcast(state, {
        signal: activeSignal,
        client: {
          getChainId: () => client.getChainId(),
          getTransactionCount: input => client.getTransactionCount(input),
          getBalance: input => client.getBalance(input),
          readTokenBalance: () =>
            client.readContract({
              address: getAddress(state.evm.token),
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [account]
            }),
          sendRawTransaction: input => client.sendRawTransaction(input),
          waitForTransactionReceipt: input => client.waitForTransactionReceipt(input)
        },
        sign: envelope => privateKeyToAccount(key).signTransaction({ ...envelope, type: 'eip1559' }),
        persist: async saved => {
          saved.updatedAt = new Date().toISOString();
          saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, saved);
          if (saved.transactions?.[0]?.feeWei === undefined)
            await awaitMainnetLoopAuthorization(MAINNET_NEAR_STATE_PATH, `${gatePath}.evm-1`, activeSignal);
        }
      })
    });
    sender.bind(request, quote);
    await confirmMainnetOneClickReview(wallet.page);
    await expect(wallet.page.getByTestId('one-click-deposit-instructions')).toContainText(
      'This route is saved in Activity',
      { timeout: 180_000 }
    );
    if (sender.broadcastCount !== 1 || !state.transactions?.[0]?.feeWei)
      throw new Error('Original native NEAR transfer is not actually receipted');
    const fetcher = createMainnetOneClickOriginFetcher(state.serviceUrl, wallet.extensionId);
    let settled: OneClickStatusResponse | undefined;
    await expect
      .poll(
        async () => {
          if (activeSignal.aborted) throw new Error('Original native NEAR return aborted');
          settled = await fetchOneClickStatus(
            setup.config,
            quote.quote.depositAddress ?? '',
            undefined,
            quote,
            fetcher
          );
          if (settled.status === 'FAILED' || settled.status === 'REFUNDED')
            throw new Error('Original native NEAR return requires recovery; never authorize another transfer');
          return settled.status;
        },
        { timeout: 900_000, intervals: [5000, 10000, 15000] }
      )
      .toBe('SUCCESS');
    const origins = settled?.swapDetails.originChainTxHashes;
    if (origins?.length !== 1 || origins[0]?.hash.toLowerCase() !== state.transactions?.[0]?.hash)
      throw new Error('Native NEAR provider return does not identify the actual original signed EVM transfer');
    const hashes = settled?.swapDetails.destinationChainTxHashes;
    const hash = hashes?.[0]?.hash.toLowerCase();
    if (hashes?.length !== 1 || !hash || !isHash(hash))
      throw new Error('Missing unique actual native NEAR return transaction');
    await claimMainnetNearNote(wallet, state, hash, 'return', gatePath, activeSignal);
  } finally {
    stopped.abort();
    await counterparty.stop();
  }
}

async function originalMainnetNearStatus(
  wallet: GuardianAwareWalletPage,
  state: MainnetNearCheckpoint,
  leg: 'forward' | 'reverse',
  sourceHash: Hash
): Promise<OneClickStatusResponse> {
  const authority = leg === 'forward' ? state.forwardQuote : state.reverseQuote;
  if (!authority) throw new Error('Missing original native NEAR provider authority');
  const config: OneClickConfig = {
    serviceUrl: state.serviceUrl,
    appFees: state.appFees,
    feePolicy: state.feePolicy,
    midenAssets: [{ assetId: state.nativeAssetId, faucetId: state.native.faucetId, decimals: 6 }]
  };
  const fetcher = createMainnetOneClickOriginFetcher(state.serviceUrl, wallet.extensionId);
  const checked = (status: OneClickStatusResponse) => {
    if (
      hashOneClickQuote(status.quoteResponse) !== authority.quoteHash ||
      status.quoteResponse.correlationId !== authority.correlationId
    )
      throw new Error('Native NEAR provider response differs from the original recorded quote');
    return status;
  };
  let status = checked(await fetchOneClickStatus(config, authority.depositAddress, undefined, undefined, fetcher));
  if (status.status === 'PENDING_DEPOSIT' || status.status === 'INCOMPLETE_DEPOSIT')
    status = checked(
      await submitOneClickDeposit(config, authority.depositAddress, sourceHash, undefined, undefined, fetcher)
    );
  return status;
}

export async function recoverMainnetNear(
  wallet: GuardianAwareWalletPage,
  state: MainnetNearCheckpoint,
  gatePath: string,
  signal: AbortSignal
): Promise<void> {
  parseMainnetNearCheckpoint(state);
  if (
    !state.forwardQuote ||
    !state.sendAuthority ||
    signal.aborted ||
    (await wallet.getAccountAddress()) !== state.account
  )
    throw new Error('Original native NEAR recovery lacks exact source authority or the existing Guardian');
  if (state.consumeAuthority && !state.returnMidenTxId)
    throw new Error('Original native NEAR claim has an unknown outcome; never retry');
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    saveMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH, state);
  };
  const noteId = state.sendAuthority.noteId;
  const creator = await readMainnetMidenOwnNoteCreator(noteId, state.accountHex);
  await verifyMainnetMidenNoteInclusion(getEnvironmentConfig().rpcUrl, noteId, creator.blockNumber, state.accountHex);
  if (state.forwardMidenTxId && state.forwardMidenTxId !== creator.transactionId)
    throw new Error('Original native NEAR source note belongs to another transaction');
  if (state.paidMidenFees === '0') {
    const rows = (await readTransactionRowsWithBytes(wallet.page, 'send')).filter(
      row => row.outputNoteIds?.includes(noteId) && row.status === TxStatus.Completed
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row?.feeAmount ||
      !/^[1-9]\d*$/.test(row.feeAmount) ||
      !row.feeFaucetId ||
      canonicalMainnetLoopFaucet(row.feeFaucetId) !== state.native.hex ||
      (row.transactionId && row.transactionId.toLowerCase() !== creator.transactionId)
    )
      throw new Error('Missing actual original native NEAR mint fee; never estimate it from a vault delta');
    state.paidMidenFees = row.feeAmount;
  }
  state.forwardMidenTxId = creator.transactionId;
  state.phase = 'recovery-required';
  await persist();
  const sourceHash = creator.transactionId;
  if (!isHash(sourceHash)) throw new Error('Invalid original actual native NEAR source hash');
  const forward = await originalMainnetNearStatus(wallet, state, 'forward', sourceHash);
  if (!forward.swapDetails.originChainTxHashes.some(item => item.hash.toLowerCase() === sourceHash))
    throw new Error('Native NEAR provider does not correlate the exact original source transaction');
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0 })
  });
  if (forward.status === 'REFUNDED') {
    if (state.forwardReceived || state.reverseQuote || state.evmNonceBefore !== undefined || state.transactions?.length)
      throw new Error('Original native NEAR forward refund contradicts known EVM proceeds or reverse authority');
    if (state.returnMidenTxId) {
      await finishMainnetNearReturn(wallet, state, 'refund');
      return;
    }
    const ids = [
      ...new Set(
        [...forward.swapDetails.originChainTxHashes, ...forward.swapDetails.destinationChainTxHashes]
          .map(item => item.hash.toLowerCase())
          .filter(hash => hash !== sourceHash)
      )
    ];
    const hash = ids[0];
    if (ids.length !== 1 || !hash || !isHash(hash))
      throw new Error('Missing unique actual provider-correlated native NEAR refund transaction');
    await claimMainnetNearNote(wallet, state, hash, 'refund', `${gatePath}.refund`, signal);
    return;
  }
  if (forward.status !== 'SUCCESS')
    throw new Error('Original native NEAR deposit is still unresolved; no fresh funding permitted');
  const destinations = forward.swapDetails.destinationChainTxHashes;
  const destination = destinations[0]?.hash.toLowerCase();
  if (destinations.length !== 1 || !destination || !isHash(destination))
    throw new Error('Missing original native NEAR EVM payout receipt');
  const received = inspectMainnetNearForwardReceipt(
    state,
    destination,
    await client.getTransactionReceipt({ hash: destination })
  );
  if (
    (state.forwardEvmTxHash && state.forwardEvmTxHash !== destination) ||
    (state.forwardReceived && BigInt(state.forwardReceived) !== received)
  )
    throw new Error('Original native NEAR payout contradicts its saved actual receipt');
  state.forwardEvmTxHash = destination;
  state.forwardReceived = received.toString();
  await persist();
  if (state.transactions?.length) {
    const entry = state.transactions[0];
    if (!entry || !isHash(entry.hash)) throw new Error('Missing original native NEAR signed transfer hash');
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: entry.hash }),
      client.getTransactionReceipt({ hash: entry.hash })
    ]);
    const successful = reconcileMainnetNearEvmReceipt(state, { transaction, receipt });
    await persist();
    if (!successful) throw new Error('Original native NEAR return reverted; actual fees retained, never retry funding');
    if (state.returnMidenTxId) {
      await finishMainnetNearReturn(wallet, state, 'return');
      return;
    }
    const reverse = await originalMainnetNearStatus(wallet, state, 'reverse', entry.hash);
    if (
      reverse.status !== 'SUCCESS' ||
      !reverse.swapDetails.originChainTxHashes.some(item => item.hash.toLowerCase() === entry.hash)
    )
      throw new Error(
        'Original native NEAR reverse settlement is unresolved; never refresh or retry its authorization'
      );
    const hashes = reverse.swapDetails.destinationChainTxHashes;
    const hash = hashes[0]?.hash.toLowerCase();
    if (hashes.length !== 1 || !hash || !isHash(hash))
      throw new Error('Missing original actual native NEAR return transaction');
    await claimMainnetNearNote(wallet, state, hash, 'return', gatePath, signal);
    return;
  }
  if (state.reverseQuote || state.evmNonceBefore !== undefined || state.returnAmount || state.consumeAuthority)
    throw new Error('Original native NEAR reverse authority has an unknown outcome; never renew it');
  state.phase = 'forward-settled';
  await persist();
  await runMainnetNearReverse(wallet, state, `${gatePath}.reverse`, signal);
}
