import { mkdirSync, writeFileSync } from 'node:fs';
import { privateKeyToAddress } from 'viem/accounts';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import { vaultBalanceByFaucetId, walletDiscoveredBaseFee, walletDiscoveredNativeFaucetId } from './balance-truth';
import { loadMainnetNearCheckpoint, saveMainnetNearCheckpoint } from './mainnet-near-checkpoint';
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
import { OneClickHttpError, requestOneClickQuote } from '../../../src/lib/one-click/client';

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
