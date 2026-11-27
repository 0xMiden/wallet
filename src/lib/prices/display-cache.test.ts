import { createElement, type ReactNode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { fetchFromStorage } from 'lib/miden/front/storage';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import type { TokenPriceInfo } from './binance';
import {
  primeCachedDisplayQuotes,
  readCachedDisplayQuotes,
  selectDisplayQuotes,
  useCachedDisplayQuotes
} from './display-cache';
import { _resetDisplayFeedForTest, peekPriceListKey } from './display-feed';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn() }));
// The network and list revision a mounted reader subscribes to.
let mockNetwork = 'mainnet';
let mockListKey: string | undefined = '';
const mockBridgeListeners = new Set<() => void>();
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/remote-config/runtime', () => ({
  subscribeBridgeConfig: (listener: () => void) => {
    mockBridgeListeners.add(listener);
    return () => mockBridgeListeners.delete(listener);
  }
}));
jest.mock('lib/token-list/useLoadedList', () => ({ useLoadedList: () => mockListKey }));
const mockPriceAssets = new Map([['mtst1blue', 'BLUEDW']]);
jest.mock('lib/token-list/runtime', () => ({
  peekTokenPriceAssets: () => mockPriceAssets,
  peekTokenBaskets: () => null,
  peekTokenDecimals: () => null,
  peekTokenSymbols: () => null,
  loadTokenPriceAssets: async () => mockPriceAssets
}));

beforeEach(() => {
  mockNetwork = 'mainnet';
  mockListKey = '';
  _resetDisplayFeedForTest();
});

it('returns cached market prices up to a day old without inventing a daily change', async () => {
  const now = 1_000_000;
  jest.mocked(fetchFromStorage).mockResolvedValue({
    ETH: { priceMicro: '2501000000', fetchedAt: now - 10 },
    // Past the spend cache's 10 minutes, still a last-known price to show.
    SOL: { priceMicro: '190000000', fetchedAt: now - 3_600 },
    OLD: { priceMicro: '1000000', fetchedAt: now - 86_401 },
    BTC: { priceMicro: '90000000000', fetchedAt: now + 1 },
    BAD: { priceMicro: '-2', fetchedAt: now - 10 }
  });
  expect(await readCachedDisplayQuotes(now)).toEqual({
    ETH: { price: 2501, observedAt: (now - 10) * 1000, kind: 'market', change24h: NaN, percentageChange24h: NaN },
    SOL: { price: 190, observedAt: (now - 3_600) * 1000, kind: 'market', change24h: NaN, percentageChange24h: NaN }
  });
});

const quote = (price: number, observedAt: number, kind: TokenPriceInfo['kind'], change24h = 1): TokenPriceInfo => ({
  price,
  observedAt,
  kind,
  change24h,
  percentageChange24h: change24h
});

it('keeps the winning quote object, including a cached NaN change', () => {
  const now = 1_700_000_000_000;
  const stale = quote(2, now - 16 * 60_000, 'market', 4);
  const cached = quote(9, now - 1_000, 'market', Number.NaN);
  cached.percentageChange24h = Number.NaN;
  const fresh = quote(3, now, 'market', 1);
  const liveMap = { ETH: stale, BTC: fresh };
  expect(selectDisplayQuotes(liveMap, undefined, now)).toBe(liveMap);

  const selected = selectDisplayQuotes(liveMap, { ETH: cached }, now);
  expect(selected.ETH).toBe(cached);
  expect(selected.ETH?.change24h).toBeNaN();
  expect(selected.ETH?.percentageChange24h).toBeNaN();
  expect(selected.BTC).toBe(fresh);

  const tied = quote(8, cached.observedAt ?? now, 'basket', 2);
  expect(selectDisplayQuotes({ ETH: tied }, { ETH: cached }, now).ETH).toBe(tied);

  const nominal = quote(1, now, 'nominal', 0);
  expect(selectDisplayQuotes({ ETH: nominal }, { ETH: cached }, now).ETH).toBe(cached);
  const unusableCache = quote(8, now - 25 * 60 * 60_000, 'market', 3);
  const unchanged = { ETH: nominal, BTC: fresh };
  expect(selectDisplayQuotes(unchanged, { ETH: unusableCache }, now)).toBe(unchanged);
  expect(selectDisplayQuotes({ BTC: fresh }, { ETH: quote(8, now - 25 * 60 * 60_000, 'market', 3) }, now)).toEqual({
    BTC: fresh
  });
  expect(selectDisplayQuotes({ SOL: quote(4, now + 60_000, 'market', 1) }, { SOL: cached }, now).SOL).toBe(cached);
});

it('shows a cached quote an hour old when nothing live replaces it', () => {
  const now = 1_700_000_000_000;
  const hourOld = quote(5, now - 60 * 60_000, 'market', Number.NaN);
  expect(selectDisplayQuotes({}, { ETH: hourOld }, now).ETH).toBe(hourOld);
});

it('keeps the newer of a stored basket quote and a market-cache entry', async () => {
  const now = 1_000_000;
  const feedKey = `display_feed_v1:${getEffectiveNetworkName()}`;
  const read = (market: Record<string, { priceMicro: string; fetchedAt: number }>, basketAt: number) => {
    _resetDisplayFeedForTest();
    jest
      .mocked(fetchFromStorage)
      .mockImplementation(async key =>
        key === feedKey ? { fetchedAt: basketAt * 1000, baskets: { ETH: 2.5 }, unquoted: [], listKey: '' } : market
      );
    return readCachedDisplayQuotes(now);
  };
  const hourOld = { priceMicro: '100000000', fetchedAt: now - 3_600 };
  const sol = { priceMicro: '190000000', fetchedAt: now - 10 };
  const quotes = await read({ ETH: hourOld, SOL: sol }, now - 30);
  expect(quotes.ETH).toMatchObject({ price: 2.5, kind: 'basket', observedAt: (now - 30) * 1000 });
  expect(quotes.SOL).toMatchObject({ price: 190, kind: 'market' });
  expect((await read({ ETH: { ...hourOld, fetchedAt: now - 10 } }, now - 3_600)).ETH).toMatchObject({
    price: 100,
    kind: 'market'
  });
});

it('serves the basket stored for the subscribed network and list', async () => {
  // Seconds old: the reader compares against whole seconds.
  const fetchedAt = Date.now() - 5_000;
  const feeds: Record<string, unknown> = {
    'display_feed_v1:mainnet': { fetchedAt, baskets: { BLUEDW: 2 }, unquoted: [], listKey: 'list-a' },
    'display_feed_v1:testnet': { fetchedAt, baskets: { BLUEDW: 9 }, unquoted: [], listKey: 'list-a' }
  };
  jest.mocked(fetchFromStorage).mockImplementation(async key => feeds[key]);
  mockListKey = 'list-a';
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
  const { result, rerender } = renderHook(() => useCachedDisplayQuotes(), { wrapper });
  await waitFor(() => expect(result.current?.BLUEDW?.price).toBe(2));

  mockNetwork = 'testnet';
  act(() => mockBridgeListeners.forEach(listener => listener()));
  await waitFor(() => expect(result.current?.BLUEDW?.price).toBe(9));

  mockListKey = 'list-b';
  rerender();
  await waitFor(() => expect(result.current?.BLUEDW).toBeUndefined());
});

// A map read for another network or list revision while the new key loads (or after its read failed).
async function switchedAway(switchKey: () => void) {
  const fetchedAt = Date.now() - 5_000;
  const stored: Record<string, unknown> = {
    usd_price_cache: { ETH: { priceMicro: '2500000000', fetchedAt: Math.floor(fetchedAt / 1000) } },
    'display_feed_v1:mainnet': { fetchedAt, baskets: { BLUEDW: 2 }, unquoted: [], listKey: 'list-a' }
  };
  jest.mocked(fetchFromStorage).mockImplementation(async key => stored[key]);
  mockListKey = 'list-a';
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
  const { result, rerender } = renderHook(() => useCachedDisplayQuotes(), { wrapper });
  await waitFor(() => expect(result.current?.BLUEDW?.price).toBe(2));
  expect(result.current?.ETH?.kind).toBe('market');

  jest.mocked(fetchFromStorage).mockRejectedValue(new Error('storage unavailable'));
  act(() => switchKey());
  rerender();
  await act(async () => {});
  return result.current;
}

it('drops a basket from another network and keeps its market quote', async () => {
  const quotes = await switchedAway(() => {
    mockNetwork = 'testnet';
    mockBridgeListeners.forEach(listener => listener());
  });
  expect(quotes?.BLUEDW).toBeUndefined();
  expect(quotes?.ETH).toMatchObject({ price: 2500, kind: 'market' });
});

it('drops a basket from another list revision and keeps its market quote', async () => {
  const quotes = await switchedAway(() => {
    mockListKey = 'list-b';
  });
  expect(quotes?.BLUEDW).toBeUndefined();
  expect(quotes?.ETH).toMatchObject({ price: 2500, kind: 'market' });
});

it('primes the key a mounted reader reads, so its first frame has the stored quotes', async () => {
  const listKey = peekPriceListKey('mainnet') ?? '';
  mockListKey = listKey;
  const fetchedAt = Date.now() - 5_000;
  jest
    .mocked(fetchFromStorage)
    .mockImplementation(async key =>
      key === 'display_feed_v1:mainnet' ? { fetchedAt, baskets: { BLUEDW: 3 }, unquoted: [], listKey } : undefined
    );
  await primeCachedDisplayQuotes(() => true);
  jest.mocked(fetchFromStorage).mockImplementation(() => new Promise(() => {}));
  const { result } = renderHook(() => useCachedDisplayQuotes());
  expect(result.current?.BLUEDW?.price).toBe(3);
});
