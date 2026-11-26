/**
 * The installed 1.18.2 state on a cold fullpage.html Command document: USDCx (fixed $1) beside MICO, which no mainnet
 * list prices, with a fresh balance proof and no cached quote for either. Real modules except the endpoints (mainnet),
 * the wallet context's ready flag, a loaded bridge config, and the network feed itself.
 */
import React, { useLayoutEffect } from 'react';

import { act, render, screen } from '@testing-library/react';

import { primeHiddenTokens, resetHiddenTokens } from 'app/hooks/useHiddenTokens';
import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { getStorageProvider, type StorageProvider } from 'lib/platform/storage-adapter';
import { PriceProvider } from 'lib/prices';
import type { TokenPrices } from 'lib/prices/binance';
import { primeCachedDisplayQuotes } from 'lib/prices/display-cache';
import { useWalletStore, withLandedBalances } from 'lib/store';
import { _resetTokenListForTest, loadTokenPriceAssets } from 'lib/token-list/runtime';

import { useCommandPortfolio } from './useCommandPortfolio';

const RPC = 'https://rpc.mainnet.miden.io';
const ACCOUNT = 'account-1';
const SCOPE = { accountId: ACCOUNT, network: 'mainnet', rpcUrl: RPC };
// USDCx is the published mainnet list's faucet; MICO is not in the list (placeholder id).
const USDCX_FAUCET = 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24';
const MICO_FAUCET = 'mm1aqmicoplaceholderfaucetnotlisted0';

const mockContext = { locked: false, ready: false };
const mockFeed: { resolve?: (prices: TokenPrices) => void; calls: number } = { calls: 0 };

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'mainnet',
  getEffectiveRpcUrl: () => 'https://rpc.mainnet.miden.io'
}));
jest.mock('lib/miden/front', () => ({
  ...jest.requireActual('lib/miden/front'),
  useMidenContext: () => mockContext
}));
jest.mock('lib/prices/feed', () => ({
  ...jest.requireActual('lib/prices/feed'),
  fetchTokenPrices: () => {
    mockFeed.calls++;
    return new Promise<TokenPrices>(resolve => {
      mockFeed.resolve = resolve;
    });
  }
}));
// Hydrated before Ready on the extension, so nothing the bridge allowlist could map is still pending.
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => TEST_BRIDGE_CONFIG_SNAPSHOT)
);
jest.mock('lib/prices/basket-nav', () => ({
  ...jest.requireActual('lib/prices/basket-nav'),
  fetchBasketPrices: async () => ({})
}));

// The published mainnet list (0xMiden/token-list main/mainnet.json, logos and descriptions dropped). No MICO.
const MAINNET_LIST = {
  name: 'Miden token list',
  timestamp: '2026-11-01T00:00:00Z',
  version: { major: 1, minor: 0, patch: 0 },
  keywords: [],
  tokens: [
    { network: 'mainnet', faucetId: USDCX_FAUCET, symbol: 'USDCX', name: 'USDCx', decimals: 6 },
    {
      network: 'mainnet',
      faucetId: 'mm1aq62x5gzzdfn75fwcj47x6a0ssyu9cxz',
      symbol: 'GC',
      name: 'Gamecoin',
      decimals: 6
    },
    {
      network: 'mainnet',
      faucetId: 'mm1aqcgf57r38kwe52lm2thp5vv3g4af6h4',
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
      binanceAsset: 'BTC'
    },
    {
      network: 'mainnet',
      faucetId: 'mm1ar608hfk0zvhsy2jy9jryzlyhcdy7fv7',
      symbol: 'SOL',
      name: 'Wrapped SOL',
      decimals: 8
    },
    { network: 'mainnet', faucetId: 'mm1ap0uegkszh85f52a5xnyr4xsdgtxucvm', symbol: 'NEAR', name: 'NEAR', decimals: 8 },
    {
      network: 'mainnet',
      faucetId: 'mm1aqjtjhhz4fwz45t8ngp3v93nw5my0ngd',
      symbol: 'PAXG',
      name: 'Pax Gold',
      decimals: 8
    },
    {
      network: 'mainnet',
      faucetId: 'mm1apwt08ff2p7n45tmkmwxqfu73y70hydp',
      symbol: 'USDT',
      name: 'Tether',
      decimals: 6
    },
    {
      network: 'mainnet',
      faucetId: 'mm1apu7sttfmxwe7yt0g094cp3uqsea655m',
      symbol: 'WBNB',
      name: 'Wrapped BNB',
      decimals: 8,
      binanceAsset: 'BNB'
    },
    {
      network: 'mainnet',
      faucetId: 'mm1ar45yekfgjfmpyfcpvjnf87a6vnu3arq',
      symbol: 'PYUSD',
      name: 'PYUSD',
      decimals: 6
    },
    { network: 'mainnet', faucetId: 'mm1apqelr6tlaeftyfj4f7w59dycysmtawe', symbol: 'ETH', name: 'Ether', decimals: 8 },
    { network: 'mainnet', faucetId: 'mm1ar7rgznnerajt52p9ul6rltd8g039qsa', symbol: 'USDG', name: 'USDG', decimals: 6 },
    { network: 'mainnet', faucetId: 'mm1azjm2663ak76y52vwyfcthr0xyuy7ll6', symbol: 'POL', name: 'POL', decimals: 8 }
  ]
};

// usd_price_cache as found: these symbols only, fetched 280 s ago.
const CACHED_SYMBOLS = ['BNB', 'BTC', 'ETH', 'NEAR', 'PAXG', 'POL', 'PYUSD', 'SOL', 'USDC', 'USDG', 'USDT'];

function memoryStorage(): StorageProvider {
  const data: Record<string, unknown> = {};
  return {
    async get(keys) {
      return Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of keys) delete data[key];
    }
  };
}

const row = (tokenId: string, symbol: string, decimals: number, baseUnits: string): TokenBalanceData => ({
  tokenId,
  tokenSlug: symbol,
  metadata: { symbol, name: symbol, decimals },
  balance: Number(baseUnits) / 10 ** decimals,
  balanceBaseUnits: baseUnits,
  fiatPrice: 0,
  change24h: 0
});

async function landUserState(): Promise<void> {
  const now = Date.now();
  const listStorage = memoryStorage();
  _resetTokenListForTest({ storage: listStorage, fetch: () => Promise.reject(new Error('offline in test')) });
  await listStorage.set({ 'token_list_cache_v2:mainnet': { fetchedAt: now - 464_000, body: MAINNET_LIST } });
  const nowSeconds = Math.floor(now / 1000);
  await getStorageProvider().set({
    usd_price_cache: Object.fromEntries(
      CACHED_SYMBOLS.map(symbol => [symbol, { priceMicro: '2000000', fetchedAt: nowSeconds - 280 }])
    )
  });
  // What rehydrateBalancesFromStorage awaits before syncFromBackend: rows + proof, display quotes, hidden set, list.
  const snapshot: BalanceSnapshot = {
    network: 'override',
    selectedNetwork: 'mainnet',
    effectiveNetwork: 'mainnet',
    rpcUrl: RPC,
    accountNonce: '7',
    capturedAt: now - 36_000
  };
  const rows = [row(MICO_FAUCET, 'MICO', 4, '125000'), row(USDCX_FAUCET, 'USDCX', 6, '4250000')];
  useWalletStore.setState(state => withLandedBalances(state, ACCOUNT, rows, null, new Set(), snapshot));
  await Promise.all([
    primeCachedDisplayQuotes(() => true),
    primeHiddenTokens('mainnet', ACCOUNT),
    loadTokenPriceAssets('mainnet')
  ]);
}

const frames: { value: string | null; status: string; coverage: string }[] = [];
function Probe() {
  const portfolio = useCommandPortfolio(SCOPE);
  const status = useWalletStore(state => state.tokenPricesStatus);
  useLayoutEffect(() => {
    frames.push({ value: portfolio.value, status, coverage: portfolio.coverage });
  });
  return <output data-testid="balance">{portfolio.value === null ? '---' : `${portfolio.value} USD`}</output>;
}

beforeEach(async () => {
  frames.length = 0;
  mockContext.ready = false;
  mockFeed.calls = 0;
  mockFeed.resolve = undefined;
  resetHiddenTokens();
  useWalletStore.setState({ balances: {}, balancesLoading: {}, tokenPrices: {}, tokenPricesStatus: 'loading' });
  await landUserState();
});

it('values USDCx on every frame while the live feed is pending, failed or landed, and never prices MICO', async () => {
  render(<Probe />);
  await act(async () => {});
  for (const status of ['ready', 'error', 'loading'] as const) {
    act(() => useWalletStore.setState({ tokenPricesStatus: status }));
    expect(screen.getByTestId('balance').textContent).toBe('4.25 USD');
  }
  expect(frames.every(frame => frame.value === '4.25' && frame.coverage === 'partial')).toBe(true);
});

it('drives the real PriceProvider from a cold document without a dash on any committed frame', async () => {
  function Harness({ ready }: { ready: boolean }) {
    return (
      <>
        <PriceProvider />
        {ready && <Probe />}
      </>
    );
  }
  const view = render(<Harness ready={false} />);
  await act(async () => {});
  mockContext.ready = true;
  await act(async () => view.rerender(<Harness ready />));
  expect(mockFeed.calls).toBeGreaterThan(0);
  expect(screen.getByTestId('balance').textContent).toBe('4.25 USD');
  await act(async () =>
    mockFeed.resolve?.({
      USDT: { price: 1, change24h: 0, percentageChange24h: 0, observedAt: Date.now(), kind: 'market' }
    })
  );
  await act(async () => {});
  expect(screen.getByTestId('balance').textContent).toBe('4.25 USD');
  expect(frames.map(frame => frame.value)).not.toContain(null);
});
