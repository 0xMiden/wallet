import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, test } from '../../fixtures/two-wallets';
import type { GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { fromBaseUnits, pendingNoteTotal, vaultBalanceByFaucetId, walletDiscoveredBaseFee, walletDiscoveredNativeFaucetId } from '../../helpers/balance-truth';
import { waitForSendRow, TxStatus } from '../../helpers/history';
import { mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { loadMainnetOneClickSetup } from '../../helpers/mainnet-one-click-config';
import { assertMainnetOneClickMayStart, loadMainnetOneClickCheckpoint, saveMainnetOneClickCheckpoint } from '../../helpers/mainnet-one-click-checkpoint';
import { assertMainnetEvmFunding, createMainnetOneClickEvmSender, readMainnetEvmHolding } from '../../helpers/mainnet-one-click-evm';
import {
  MAINNET_ONE_CLICK_DRY_PROBES_PER_CANDIDATE,
  MAINNET_ONE_CLICK_MAX_CANDIDATES,
  MAINNET_ONE_CLICK_CAP_MICRO_USD,
  MAINNET_ONE_CLICK_PRICE_SOURCE,
  chooseCheapestOneClickRoute,
  planOneClickRoundTrip,
  remainingOneClickCostBudget,
  searchSmallestViableAmount,
  tokenValueUsdMicro
} from '../../helpers/mainnet-one-click-plan';
import { fetchMainnetOneClickUsdPrices } from '../../helpers/mainnet-one-click-prices';
import { createMainnetOneClickOriginFetcher } from '../../helpers/mainnet-one-click-origin';
import { confirmMainnetOneClickReview, selectMainnetOneClickAssets } from '../../helpers/mainnet-one-click-ui';
import { isSameOneClickUnderlyingAsset, ONE_CLICK_EVM_CHAIN_IDS, OneClickHttpError, parseOneClickQuoteResponse, requestOneClickQuote } from '../../../../src/lib/one-click/client';
import type { OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from '../../../../src/lib/one-click/types';
import { createWalletClient, http, isHash, isHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WcCounterparty } from '../../ios/helpers/wc-counterparty';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', timeout: 1_200_000 });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'mainnet 1Click settlement uses existing funded accounts');
test.skip(!process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR, 'E2E_MAINNET_GUARDIAN_KEY_PAIR is unset');
test.skip(!process.env.E2E_MAINNET_EVM_KEY, 'E2E_MAINNET_EVM_KEY is unset');

const CHECKPOINT_PATH = 'test-results/mainnet-1click-state/roundtrip.json';
const SLIPPAGE_BPS = 100;
const MIDEN_FEE_TXS = 2n;
const TX_FEE_MULTIPLE = 30n;
const MAX_PRINCIPAL_USD_MICROS = 10_000_000n;
const CHAIN_PRIORITY = ['arb', 'eth'];
let activeCounterparty: WcCounterparty | undefined;

test.afterEach(async () => {
  await activeCounterparty?.stop();
  activeCounterparty = undefined;
});

function evmSigner(): Hex {
  const raw = process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '';
  const value = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error('E2E_MAINNET_EVM_KEY is not a valid private key');
  return value;
}

function deadline(): string {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}

function requestFor(
  originAsset: OneClickAsset,
  destinationAsset: OneClickAsset,
  amount: bigint,
  refundTo: string,
  recipient: string
): OneClickQuoteRequest {
  return {
    amount: amount.toString(),
    originAsset,
    destinationAsset,
    refundTo,
    recipient,
    deadline: deadline(),
    slippageTolerance: SLIPPAGE_BPS
  };
}

function priceMicros(prices: Readonly<Record<string, bigint>>, id: string): bigint {
  const price = prices[id];
  if (price === undefined || price <= 0n) throw new Error(`No pinned USD price for ${id}`);
  return price;
}

async function dryQuote(
  config: NonNullable<Awaited<ReturnType<typeof loadMainnetOneClickSetup>>>['config'],
  request: OneClickQuoteRequest,
  fetcher: typeof fetch
): Promise<OneClickQuoteResponse | undefined> {
  try {
    return await requestOneClickQuote(config, request, true, fetcher);
  } catch (error) {
    if (error instanceof OneClickHttpError && error.status === 400) return undefined;
    throw error;
  }
}

function quoteLoss(
  quote: OneClickQuoteResponse,
  input: OneClickAsset,
  output: OneClickAsset,
  prices: Readonly<Record<string, bigint>>
): bigint {
  const inputPrice = input.coingeckoId ? prices[input.coingeckoId] : undefined;
  const outputPrice = output.coingeckoId ? prices[output.coingeckoId] : undefined;
  if (inputPrice === undefined || outputPrice === undefined) throw new Error(`No pinned USD price for ${input.symbol} or ${output.symbol}`);
  const inputValue = tokenValueUsdMicro(BigInt(quote.quote.amountIn), input.decimals, inputPrice, true);
  const outputValue = tokenValueUsdMicro(BigInt(quote.quote.minAmountOut), output.decimals, outputPrice, false);
  let fees = 0n;
  if (quote.quote.refundFee !== undefined) fees += tokenValueUsdMicro(BigInt(quote.quote.refundFee), input.decimals, inputPrice, true);
  if (quote.quote.withdrawFee !== undefined) fees += tokenValueUsdMicro(BigInt(quote.quote.withdrawFee), output.decimals, outputPrice, true);
  return (inputValue > outputValue ? inputValue - outputValue : 0n) + fees;
}

async function readMidenTokenPricing(page: GuardianAwareWalletPage['page'], faucetId: string): Promise<{ coingeckoId?: string; decimals?: number }> {
  return page.evaluate(id => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const store = Reflect.get(window, '__TEST_STORE__');
    const getState = isRecord(store) ? Reflect.get(store, 'getState') : undefined;
    if (typeof getState !== 'function') return {};
    const state: unknown = Reflect.apply(getState, store, []);
    const metadataById = isRecord(state) ? Reflect.get(state, 'assetsMetadata') : undefined;
    const metadata = isRecord(metadataById) ? Reflect.get(metadataById, id) : undefined;
    return {
      ...(isRecord(metadata) && typeof metadata.coingeckoId === 'string' ? { coingeckoId: metadata.coingeckoId } : {}),
      ...(isRecord(metadata) && typeof metadata.decimals === 'number' ? { decimals: metadata.decimals } : {})
    };
  }, faucetId);
}

async function connectExternalWallet(wallet: GuardianAwareWalletPage, counterparty: WcCounterparty): Promise<void> {
  const state = async () => wallet.page.evaluate(() => {
    const read = window.__TEST_APPKIT_STATE__;
    if (!read) throw new Error('The mainnet E2E AppKit state hook is unavailable');
    return read();
  });
  await counterparty.start();
  const connection = counterparty.connectWithRetry(
    () => wallet.page.evaluate(() => {
      const read = window.__TEST_APPKIT_CONNECT_URI__;
      if (!read) throw new Error('The mainnet E2E AppKit URI hook is unavailable');
      return read();
    }),
    async () => (await state()).connected,
    { attempts: 3, backoffMs: 5_000, sessionTimeoutMs: 45_000 }
  );
  await wallet.page.getByTestId('one-click-connect-origin-wallet').click();
  await connection;
  const connected = await state();
  expect(connected.connected).toBe(true);
  expect(connected.address?.toLowerCase()).toBe(counterparty.address.toLowerCase());
}

async function actualReviewQuote(
  wallet: GuardianAwareWalletPage,
  route: Parameters<typeof selectMainnetOneClickAssets>[1],
  expected: { originAsset: string; destinationAsset: string; amount: bigint; refundTo: string; recipient: string },
  selected = false
): Promise<OneClickQuoteResponse> {
  const response = wallet.page.waitForResponse(
    response => {
      if (!response.url().includes('/v0/quote') || response.request().method() !== 'POST') return false;
      const body: unknown = response.request().postDataJSON();
      return typeof body === 'object' && body !== null && !Array.isArray(body) &&
        Reflect.get(body, 'dry') === false && Reflect.get(body, 'amount') === expected.amount.toString() &&
        Reflect.get(body, 'originAsset') === expected.originAsset &&
        Reflect.get(body, 'destinationAsset') === expected.destinationAsset &&
        Reflect.get(body, 'refundTo') === expected.refundTo && Reflect.get(body, 'recipient') === expected.recipient;
    },
    { timeout: 120_000 }
  );
  if (!selected) await selectMainnetOneClickAssets(wallet.page, route);
  await wallet.page.getByTestId('one-click-pay-amount').fill(route.amount);
  await expect(wallet.page.getByTestId('one-click-review-submit')).toBeEnabled({ timeout: 120_000 });
  await wallet.page.getByTestId('one-click-review-submit').click();
  await expect(wallet.page.getByTestId('one-click-review-hero')).toBeVisible();
  return parseOneClickQuoteResponse(await (await response).json());
}

test('settles the smallest observed funded 1Click round trip and returns the received balance', async ({ walletB }) => {
  test.setTimeout(1_200_000);
  const mode = process.env.MAINNET_ONE_CLICK_MODE ?? 'execute';
  if (mode !== 'preflight' && mode !== 'arm' && mode !== 'execute') throw new Error('Unknown mainnet 1Click stage');
  const sourceRunId = process.env.GITHUB_RUN_ID ?? 'local';
  const checkpoint = loadMainnetOneClickCheckpoint(CHECKPOINT_PATH);
  if (mode === 'arm') {
    if (checkpoint?.phase !== 'preflight' || checkpoint.sourceRunId !== sourceRunId) {
      throw new Error('The same-run mainnet 1Click preflight checkpoint is missing or mismatched');
    }
    saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
      ...checkpoint,
      phase: 'execution-authorized',
      updatedAt: new Date().toISOString(),
      note: 'Execution marker published before the funded stage; absence of a final artifact requires recovery review.'
    });
    return;
  }
  const resumablePreflight = mode === 'preflight' && checkpoint?.phase === 'preflight' ? checkpoint : undefined;
  if (mode === 'preflight') {
    if (!resumablePreflight) assertMainnetOneClickMayStart(checkpoint);
  } else if (checkpoint?.phase !== 'execution-authorized' || checkpoint.sourceRunId !== sourceRunId) {
    throw new Error('A same-run execution marker is required before any funded 1Click action');
  }
  const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
  if (!keyPair) throw new Error('E2E_MAINNET_GUARDIAN_KEY_PAIR is unset');
  await walletB.recoverGuardianFromHotKey(keyPair.trim());
  await walletB.triggerSync(true);
  const setup = await loadMainnetOneClickSetup(fetch, fetch, walletB.extensionId);
  test.skip(!setup, 'mainnet 1Click is unavailable until the live catalog lists a metadata-verified Miden asset');
  if (!setup) return;
  const providerFetcher = createMainnetOneClickOriginFetcher(setup.config.serviceUrl, walletB.extensionId);
  const midenAsset = setup.assets.find(asset => asset.blockchain === 'miden');
  if (!midenAsset?.faucetId || !midenAsset.coingeckoId) {
    throw new Error('The active mainnet 1Click route lacks a priced, metadata-verified Miden asset');
  }
  const evmAssets = CHAIN_PRIORITY.flatMap(chain =>
    setup.assets.filter(asset =>
      asset.blockchain === chain && /^(USDC|USDT)$/i.test(asset.symbol) && asset.coingeckoId && asset.chainId &&
      !isSameOneClickUnderlyingAsset(asset, midenAsset)
    )
  ).slice(0, MAINNET_ONE_CLICK_MAX_CANDIDATES);
  if (evmAssets.length === 0) throw new Error('The active mainnet 1Click route has no supported, priced stablecoin candidates');
  const midenAddress = await walletB.getAccountAddress();
  const evm = privateKeyToAccount(evmSigner());
  const nativeFaucet = await walletDiscoveredNativeFaucetId(walletB.page);
  const baseFee = await walletDiscoveredBaseFee(walletB.page);
  if (!nativeFaucet || baseFee === null || baseFee < 1) throw new Error('The existing Guardian account has not discovered its Miden fee reserve');
  const nativeBalance = await vaultBalanceByFaucetId(walletB.page, nativeFaucet);
  const midenFeeReserveBase = BigInt(baseFee) * TX_FEE_MULTIPLE * MIDEN_FEE_TXS;
  if (nativeBalance < midenFeeReserveBase) throw new Error('The existing Guardian account cannot cover the Miden fee reserve');
  const midenFaucetId = midenAsset.faucetId;
  const principalAvailable = await vaultBalanceByFaucetId(walletB.page, midenFaucetId);
  const maximumAmount = principalAvailable - (midenFaucetId.toLowerCase() === nativeFaucet.toLowerCase() ? midenFeeReserveBase : 0n);
  if (maximumAmount <= 0n) throw new Error('The existing Guardian account lacks spendable 1Click principal');
  const nativeMetadata = await readMidenTokenPricing(walletB.page, nativeFaucet);
  if (!nativeMetadata.coingeckoId || nativeMetadata.decimals === undefined) {
    throw new Error('The existing Guardian native fee asset has no pinned USD price metadata');
  }
  const priceIds = [...new Set([...evmAssets.map(asset => asset.coingeckoId ?? ''), midenAsset.coingeckoId, nativeMetadata.coingeckoId, 'ethereum'])];
  const prices = await fetchMainnetOneClickUsdPrices(priceIds);
  const midenPrice = prices.usdMicrosById[midenAsset.coingeckoId];
  const nativePrice = prices.usdMicrosById[nativeMetadata.coingeckoId];
  if (midenPrice === undefined || nativePrice === undefined) throw new Error('The live USD price set is incomplete');
  const amountMaximumByUsd = (MAX_PRINCIPAL_USD_MICROS * 10n ** BigInt(midenAsset.decimals)) / midenPrice;
  const searchMaximum = maximumAmount < amountMaximumByUsd ? maximumAmount : amountMaximumByUsd;
  if (searchMaximum <= 0n) throw new Error('The existing Guardian balance has no principal within the bounded $10 quote-search range');
  const candidates: Array<{
    asset: OneClickAsset;
    amount: bigint;
    forward: OneClickQuoteResponse;
    reverse: OneClickQuoteResponse;
    plan: ReturnType<typeof planOneClickRoundTrip>;
    holding: Awaited<ReturnType<typeof readMainnetEvmHolding>>;
  }> = [];

  for (const asset of evmAssets) {
    if (!asset.chainId || !asset.coingeckoId) continue;
    const holding = await readMainnetEvmHolding(asset, evm.address);
    assertMainnetEvmFunding(holding, 0n);
    const evmFeeUsd = tokenValueUsdMicro(
      holding.gasReserveWei,
      18,
      prices.usdMicrosById.ethereum ?? (() => { throw new Error('No pinned ETH price for the EVM gas reserve'); })(),
      true
    );
    const midenFeeUsd = tokenValueUsdMicro(midenFeeReserveBase, nativeMetadata.decimals, nativePrice, true);
    let result: {
      amount: bigint;
      quote: { forward: OneClickQuoteResponse; reverse: OneClickQuoteResponse; plan: ReturnType<typeof planOneClickRoundTrip> };
    } | undefined;
    try {
      result = await searchSmallestViableAmount({
        firstAmount: 1n,
        maximumAmount: searchMaximum,
        attempts: MAINNET_ONE_CLICK_DRY_PROBES_PER_CANDIDATE,
        quote: async amount => {
          const forwardRequest = requestFor(midenAsset, asset, amount, midenAddress, evm.address);
          const forward = await dryQuote(setup.config, forwardRequest, providerFetcher);
          if (!forward) return undefined;
          const reverseRequest = requestFor(asset, midenAsset, BigInt(forward.quote.minAmountOut), evm.address, midenAddress);
          const reverse = await dryQuote(setup.config, reverseRequest, providerFetcher);
          if (!reverse) return undefined;
          const forwardLoss = quoteLoss(forward, midenAsset, asset, prices.usdMicrosById);
          const reverseLoss = quoteLoss(reverse, asset, midenAsset, prices.usdMicrosById);
          if (forwardLoss + reverseLoss + midenFeeUsd + evmFeeUsd > MAINNET_ONE_CLICK_CAP_MICRO_USD) return undefined;
          const plan = planOneClickRoundTrip({
            routeId: `${asset.blockchain}:${asset.symbol}`,
            symbol: midenAsset.symbol,
            amountBaseUnits: amount,
            availableBaseUnits: maximumAmount,
            forward: { inputUsdMicros: 0n, minimumOutputUsdMicros: 0n, nativeFeeUsdMicros: midenFeeUsd },
            reverse: { inputUsdMicros: 0n, minimumOutputUsdMicros: 0n, nativeFeeUsdMicros: evmFeeUsd },
            providerFeesUsdMicros: forwardLoss + reverseLoss
          });
          return { forward, reverse, plan };
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No viable 1Click quote found')) continue;
      throw error;
    }
    if (!result) continue;
    assertMainnetEvmFunding(holding, 0n);
    const amountValue = tokenValueUsdMicro(result.amount, midenAsset.decimals, midenPrice, true);
    if (amountValue > MAX_PRINCIPAL_USD_MICROS) throw new Error('The planned 1Click principal exceeds the $10 search bound');
    candidates.push({
      asset,
      amount: result.amount,
      forward: result.quote.forward,
      reverse: result.quote.reverse,
      plan: result.quote.plan,
      holding
    });
  }

  const selectedRoute = chooseCheapestOneClickRoute(candidates.map(candidate => ({
    candidate,
    plan: candidate.plan,
    chainPriority: CHAIN_PRIORITY.findIndex(chain => chain === candidate.asset.blockchain)
  })));
  if (!selectedRoute) throw new Error('No funded 1Click route produced verified dry quotes within the $2.00 round-trip cap');
  const selected = selectedRoute.candidate;
  assertMainnetEvmFunding(selected.holding, 0n);
  if (nativeFaucet.toLowerCase() === midenFaucetId.toLowerCase()) {
    throw new Error('The active route uses its principal token for Miden gas, so principal loss and fee cost cannot be bounded separately');
  }
  const preSubmitPrices = await fetchMainnetOneClickUsdPrices(priceIds);
  const preSubmitForwardCost = quoteLoss(selected.forward, midenAsset, selected.asset, preSubmitPrices.usdMicrosById);
  const preSubmitReverseCost = quoteLoss(selected.reverse, selected.asset, midenAsset, preSubmitPrices.usdMicrosById);
  const preSubmitNativeFee = tokenValueUsdMicro(midenFeeReserveBase, nativeMetadata.decimals, priceMicros(preSubmitPrices.usdMicrosById, nativeMetadata.coingeckoId), true) +
    tokenValueUsdMicro(selected.holding.gasReserveWei, 18, priceMicros(preSubmitPrices.usdMicrosById, 'ethereum'), true);
  selected.plan = planOneClickRoundTrip({
    routeId: `${selected.asset.blockchain}:${selected.asset.symbol}`,
    symbol: midenAsset.symbol,
    amountBaseUnits: selected.amount,
    availableBaseUnits: maximumAmount,
    forward: { inputUsdMicros: 0n, minimumOutputUsdMicros: 0n, nativeFeeUsdMicros: 0n },
    reverse: { inputUsdMicros: 0n, minimumOutputUsdMicros: 0n, nativeFeeUsdMicros: preSubmitNativeFee },
    providerFeesUsdMicros: preSubmitForwardCost + preSubmitReverseCost
  });
  const selectedRouteId = `${selected.asset.blockchain}:${selected.asset.symbol}`;
  if (mode === 'preflight') {
    if (resumablePreflight && (resumablePreflight.routeId !== selectedRouteId ||
        resumablePreflight.principalBaseUnits !== selected.amount.toString())) {
      throw new Error('The revalidated route and principal differ from the saved read-only preflight');
    }
    saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
      version: 1,
      phase: 'preflight',
      routeId: selectedRouteId,
      symbol: midenAsset.symbol,
      principalBaseUnits: selected.amount.toString(),
      sourceRunId,
      realizedCostUsdMicros: selected.plan.worstCaseCostUsdMicros.toString(),
      updatedAt: new Date().toISOString(),
      note: `Read-only bounded quote plan; no transaction submitted. USD source ${MAINNET_ONE_CLICK_PRICE_SOURCE} at ${preSubmitPrices.fetchedAt}`
    });
    mkdirSync('test-results/mainnet-1click-preflight', { recursive: true });
    writeFileSync('test-results/mainnet-1click-preflight/summary.json', `${JSON.stringify({
      status: 'preflight-only',
      route: selectedRouteId,
      principalBaseUnits: selected.amount.toString(),
      worstCaseCostUsdMicros: selected.plan.worstCaseCostUsdMicros.toString(),
      priceSource: MAINNET_ONE_CLICK_PRICE_SOURCE,
      pricesFetchedAt: preSubmitPrices.fetchedAt,
      pricesUpdatedAt: preSubmitPrices.pricesUpdatedAt
    }, null, 2)}\n`);
    return;
  }
  if (checkpoint?.routeId !== selectedRouteId || checkpoint.principalBaseUnits !== selected.amount.toString()) {
    throw new Error('The revalidated route and principal differ from the uploaded preflight plan');
  }
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'preflight',
    routeId: selectedRouteId,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    sourceRunId,
    updatedAt: new Date().toISOString(),
    note: `Dry-quote preflight; USD source ${MAINNET_ONE_CLICK_PRICE_SOURCE} at ${prices.fetchedAt}`
  });

  const initialEvmBalance = selected.holding.balanceBaseUnits;
  const initialMidenBalance = principalAvailable;
  const routeOut = {
    payNetwork: 'miden',
    payAssetId: midenAsset.assetId,
    receiveNetwork: selected.asset.blockchain,
    receiveAssetId: selected.asset.assetId,
    amount: fromBaseUnits(selected.amount, midenAsset.decimals),
    externalAddress: evm.address
  };
  await walletB.navigateTo('/swap');
  const forwardWet = await actualReviewQuote(walletB, routeOut, {
    originAsset: midenAsset.assetId,
    destinationAsset: selected.asset.assetId,
    amount: selected.amount,
    refundTo: midenAddress,
    recipient: evm.address
  });
  const actualForwardCost = quoteLoss(forwardWet, midenAsset, selected.asset, preSubmitPrices.usdMicrosById);
  remainingOneClickCostBudget(actualForwardCost, preSubmitReverseCost + selected.plan.nativeFeesUsdMicros);
  expect(forwardWet.quote.amountIn).toBe(selected.amount.toString());
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'forward-submitted',
    routeId: `${selected.asset.blockchain}:${selected.asset.symbol}`,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    forwardCorrelationId: forwardWet.correlationId,
    realizedCostUsdMicros: actualForwardCost.toString(),
    updatedAt: new Date().toISOString()
  });
  await confirmMainnetOneClickReview(walletB.page);
  const forwardSendRow = await waitForSendRow(walletB.page, {
    recipient: forwardWet.quote.depositAddress ?? '',
    amountBaseUnits: selected.amount,
    status: TxStatus.Completed,
    requireTransactionId: true,
    timeoutMs: 900_000
  });
  if (!forwardSendRow.transactionId) throw new Error('The Guardian deposit row has no transaction id for recovery tracking');
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'forward-submitted',
    routeId: selectedRouteId,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    forwardCorrelationId: forwardWet.correlationId,
    forwardTransactionId: forwardSendRow.transactionId,
    realizedCostUsdMicros: actualForwardCost.toString(),
    updatedAt: new Date().toISOString()
  });
  await expect(walletB.page.getByTestId('one-click-deposit-instructions'))
    .toContainText('This route is saved in Activity', { timeout: 120_000 });
  await expect.poll(async () => {
    const current = await readMainnetEvmHolding(selected.asset, evm.address);
    return current.balanceBaseUnits - initialEvmBalance;
  }, { timeout: 900_000 }).toBeGreaterThanOrEqual(BigInt(forwardWet.quote.minAmountOut));
  const afterForward = await readMainnetEvmHolding(selected.asset, evm.address);
  const receivedBaseUnits = afterForward.balanceBaseUnits - initialEvmBalance;
  if (receivedBaseUnits < BigInt(forwardWet.quote.minAmountOut)) throw new Error('The first 1Click settlement returned less than its signed minimum');
  assertMainnetEvmFunding(afterForward, receivedBaseUnits);
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'miden-delivered',
    routeId: `${selected.asset.blockchain}:${selected.asset.symbol}`,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    forwardOutputBaseUnits: receivedBaseUnits.toString(),
    forwardCorrelationId: forwardWet.correlationId,
    forwardTransactionId: forwardSendRow.transactionId,
    realizedCostUsdMicros: actualForwardCost.toString(),
    updatedAt: new Date().toISOString()
  });

  const pendingMidenBeforeReverse = await pendingNoteTotal(walletB.page, midenAsset.symbol);
  await walletB.navigateTo('/swap');
  const routeBack = {
    payNetwork: selected.asset.blockchain,
    payAssetId: selected.asset.assetId,
    receiveNetwork: 'miden',
    receiveAssetId: midenAsset.assetId,
    amount: fromBaseUnits(receivedBaseUnits, selected.asset.decimals)
  };
  await selectMainnetOneClickAssets(walletB.page, routeBack);
  if (!selected.asset.chainId) throw new Error('The selected route has no verified EVM chain id');
  let evmSender: ReturnType<typeof createMainnetOneClickEvmSender> | undefined;
  const counterparty = new WcCounterparty({
    privateKey: evmSigner(),
    rpcUrl: mainnetRpc(selected.asset.chainId),
    chainId: selected.asset.chainId,
    sessionChainIds: Object.values(ONE_CLICK_EVM_CHAIN_IDS),
    send: (transaction, signal) => {
      if (!evmSender) throw new Error('The signed reverse 1Click quote has not been bound');
      return evmSender.send(transaction, signal);
    }
  });
  activeCounterparty = counterparty;
  await connectExternalWallet(walletB, counterparty);
  const reverseWet = await actualReviewQuote(walletB, routeBack, {
    originAsset: selected.asset.assetId,
    destinationAsset: midenAsset.assetId,
    amount: receivedBaseUnits,
    refundTo: evm.address,
    recipient: midenAddress
  }, true);
  if (!reverseWet.quote.depositAddress) throw new Error('The reverse quote has no EVM deposit address');
  const reversePrices = await fetchMainnetOneClickUsdPrices(priceIds);
  const actualForwardCostAtReversePrices = quoteLoss(forwardWet, midenAsset, selected.asset, reversePrices.usdMicrosById);
  const actualReverseCost = quoteLoss(reverseWet, selected.asset, midenAsset, reversePrices.usdMicrosById);
  const realizedCost = actualForwardCostAtReversePrices + actualReverseCost;
  const midenFeeBudgetUsd = tokenValueUsdMicro(
    midenFeeReserveBase,
    nativeMetadata.decimals,
    priceMicros(reversePrices.usdMicrosById, nativeMetadata.coingeckoId),
    true
  );
  const remainingGasBudgetUsd = remainingOneClickCostBudget(realizedCost, midenFeeBudgetUsd);
  const ethPriceMicros = priceMicros(reversePrices.usdMicrosById, 'ethereum');
  const gasBudgetByCapWei = (remainingGasBudgetUsd * 10n ** 18n) / ethPriceMicros;
  const gasBudgetWei = gasBudgetByCapWei < selected.holding.gasReserveWei
    ? gasBudgetByCapWei
    : selected.holding.gasReserveWei;
  if (gasBudgetWei <= 0n) throw new Error('No EVM gas budget remains under the hard round-trip cap');
  expect(reverseWet.quote.amountIn).toBe(receivedBaseUnits.toString());
  const reverseDeadline = reverseWet.quoteRequest.deadline;
  if (!reverseDeadline) throw new Error('The signed reverse quote has no expiry bound');
  const reverseRequest: OneClickQuoteRequest = {
    ...requestFor(selected.asset, midenAsset, receivedBaseUnits, evm.address, midenAddress),
    deadline: reverseDeadline,
    slippageTolerance: reverseWet.quoteRequest.slippageTolerance
  };
  const liveChain = mainnetChain(selected.asset.chainId);
  const signingClient = createWalletClient({ account: evm, chain: liveChain, transport: http(mainnetRpc(selected.asset.chainId)) });
  evmSender = createMainnetOneClickEvmSender({
    holding: selected.holding,
    account: evm.address,
    config: setup.config,
    gasBudgetWei,
    broadcast: transaction => signingClient.sendTransaction({ account: evm, chain: liveChain, ...transaction })
  });
  evmSender.bind(reverseRequest, reverseWet);
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'reverse-submitted',
    routeId: `${selected.asset.blockchain}:${selected.asset.symbol}`,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    forwardOutputBaseUnits: receivedBaseUnits.toString(),
    realizedCostUsdMicros: realizedCost.toString(),
    forwardCorrelationId: forwardWet.correlationId,
    reverseCorrelationId: reverseWet.correlationId,
    updatedAt: new Date().toISOString(),
    note: 'Reverse quote reviewed; awaiting the one-time EVM transfer confirmation.'
  });
  await confirmMainnetOneClickReview(walletB.page);
  await expect(walletB.page.getByTestId('one-click-deposit-instructions')).toBeVisible({ timeout: 120_000 });
  await expect(walletB.page.getByTestId('one-click-deposit-instructions'))
    .toContainText('This route is saved in Activity', { timeout: 120_000 });
  const reverseTransactionHash = counterparty.requests.find(request => request.method === 'eth_sendTransaction')?.result;
  if (evmSender.broadcastCount !== 1 || typeof reverseTransactionHash !== 'string' || !isHash(reverseTransactionHash)) {
    throw new Error('The WalletConnect counterparty did not record the reviewed reverse transfer hash');
  }
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'reverse-submitted',
    routeId: selectedRouteId,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    forwardOutputBaseUnits: receivedBaseUnits.toString(),
    realizedCostUsdMicros: realizedCost.toString(),
    forwardCorrelationId: forwardWet.correlationId,
    reverseCorrelationId: reverseWet.correlationId,
    reverseEvmTransactionHash: reverseTransactionHash,
    updatedAt: new Date().toISOString()
  });
  const actualEvmFeeWei = await evmSender.receiptFee(reverseTransactionHash, 900_000);
  const reverseReceipt = await selected.holding.client.waitForTransactionReceipt({ hash: reverseTransactionHash, timeout: 900_000 });
  expect(reverseReceipt.status).toBe('success');
  await walletB.triggerSync(true);
  await expect.poll(async () => {
    const pendingAfterReverse = await pendingNoteTotal(walletB.page, midenAsset.symbol);
    return pendingAfterReverse >= pendingMidenBeforeReverse ? pendingAfterReverse - pendingMidenBeforeReverse : 0n;
  }, { timeout: 900_000 })
    .toBeGreaterThanOrEqual(BigInt(reverseWet.quote.minAmountOut));
  await walletB.claimAllNotes();
  const expectedPreReturn = initialMidenBalance - selected.amount;
  await expect.poll(async () => vaultBalanceByFaucetId(walletB.page, midenFaucetId), { timeout: 900_000 })
    .toBeGreaterThanOrEqual(expectedPreReturn + BigInt(reverseWet.quote.minAmountOut));
  const finalMidenBalance = await vaultBalanceByFaucetId(walletB.page, midenFaucetId);
  const returned = finalMidenBalance - expectedPreReturn;
  const finalNativeBalance = await vaultBalanceByFaucetId(walletB.page, nativeFaucet);
  if (finalNativeBalance >= nativeBalance) throw new Error('The Miden transaction fee spend could not be verified');
  const settlementPrices = await fetchMainnetOneClickUsdPrices(priceIds);
  const finalForwardQuoteLoss = quoteLoss(forwardWet, midenAsset, selected.asset, settlementPrices.usdMicrosById);
  const finalReverseQuoteLoss = quoteLoss(reverseWet, selected.asset, midenAsset, settlementPrices.usdMicrosById);
  const actualMidenFeeUsd = tokenValueUsdMicro(
    nativeBalance - finalNativeBalance,
    nativeMetadata.decimals,
    priceMicros(settlementPrices.usdMicrosById, nativeMetadata.coingeckoId),
    true
  );
  const actualEvmFeeUsd = tokenValueUsdMicro(actualEvmFeeWei, 18, priceMicros(settlementPrices.usdMicrosById, 'ethereum'), true);
  const finalCost = finalForwardQuoteLoss + finalReverseQuoteLoss + actualEvmFeeUsd + actualMidenFeeUsd;
  if (finalCost > 2_000_000n) {
    saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
      version: 1,
      phase: 'recovery-required',
      routeId: `${selected.asset.blockchain}:${selected.asset.symbol}`,
      symbol: midenAsset.symbol,
      principalBaseUnits: selected.amount.toString(),
      forwardOutputBaseUnits: receivedBaseUnits.toString(),
      reverseOutputBaseUnits: returned.toString(),
      realizedCostUsdMicros: finalCost.toString(),
      forwardCorrelationId: forwardWet.correlationId,
      reverseCorrelationId: reverseWet.correlationId,
      reverseEvmTransactionHash: reverseTransactionHash,
      updatedAt: new Date().toISOString(),
      note: 'Settlement returned; observed cost exceeded the hard cap, no further transactions are authorized.'
    });
    throw new Error('The completed 1Click round trip exceeded the $2.00 realized-cost cap; the returned balance is visible in the checkpoint');
  }
  saveMainnetOneClickCheckpoint(CHECKPOINT_PATH, {
    version: 1,
    phase: 'complete',
    routeId: `${selected.asset.blockchain}:${selected.asset.symbol}`,
    symbol: midenAsset.symbol,
    principalBaseUnits: selected.amount.toString(),
    forwardOutputBaseUnits: receivedBaseUnits.toString(),
    reverseOutputBaseUnits: returned.toString(),
    realizedCostUsdMicros: finalCost.toString(),
    forwardCorrelationId: forwardWet.correlationId,
    reverseCorrelationId: reverseWet.correlationId,
    reverseEvmTransactionHash: reverseTransactionHash,
    updatedAt: new Date().toISOString(),
    note: `Completed with ${MAINNET_ONE_CLICK_PRICE_SOURCE} at ${settlementPrices.fetchedAt}`
  });
  expect(returned).toBeGreaterThanOrEqual(BigInt(reverseWet.quote.minAmountOut));
  await counterparty.stop();
  mkdirSync('test-results/mainnet-1click-execute', { recursive: true });
  writeFileSync('test-results/mainnet-1click-execute/summary.json', `${JSON.stringify({
    status: 'complete',
    route: `${selected.asset.blockchain}:${selected.asset.symbol}`,
    principalBaseUnits: selected.amount.toString(),
    midenBalanceBeforeBaseUnits: initialMidenBalance.toString(),
    midenBalanceAfterBaseUnits: finalMidenBalance.toString(),
    evmBalanceBeforeBaseUnits: initialEvmBalance.toString(),
    evmBalanceAfterForwardBaseUnits: afterForward.balanceBaseUnits.toString(),
    returnedMidenBaseUnits: returned.toString(),
    nativeFeeReserveBaseUnits: midenFeeReserveBase.toString(),
    plannedMaximumCostUsdMicros: selected.plan.worstCaseCostUsdMicros.toString(),
    actualMidenFeeUsdMicros: actualMidenFeeUsd.toString(),
    actualEvmFeeUsdMicros: actualEvmFeeUsd.toString(),
    realizedCostUsdMicros: finalCost.toString(),
    evmTransactionHash: reverseTransactionHash,
    priceSource: MAINNET_ONE_CLICK_PRICE_SOURCE,
    pricesFetchedAt: settlementPrices.fetchedAt,
    pricesUpdatedAt: settlementPrices.pricesUpdatedAt
  }, null, 2)}\n`);
});
