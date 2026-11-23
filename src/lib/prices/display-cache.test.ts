import { fetchFromStorage } from 'lib/miden/front/storage';

import type { TokenPriceInfo } from './binance';
import { readCachedDisplayQuotes, selectDisplayQuotes } from './display-cache';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn() }));

it('returns only fresh cached market prices without inventing a daily change', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue({
    ETH: { priceMicro: '2501000000', fetchedAt: 990 },
    SOL: { priceMicro: '190000000', fetchedAt: 399 },
    BTC: { priceMicro: '90000000000', fetchedAt: 1001 },
    BAD: { priceMicro: '-2', fetchedAt: 990 }
  });
  expect(await readCachedDisplayQuotes(1000)).toEqual({
    ETH: { price: 2501, observedAt: 990000, kind: 'market', change24h: NaN, percentageChange24h: NaN }
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
  const unusableCache = quote(8, now - 20 * 60_000, 'market', 3);
  const unchanged = { ETH: nominal, BTC: fresh };
  expect(selectDisplayQuotes(unchanged, { ETH: unusableCache }, now)).toBe(unchanged);
  expect(selectDisplayQuotes({ BTC: fresh }, { ETH: quote(8, now - 11 * 60_000, 'market', 3) }, now)).toEqual({
    BTC: fresh
  });
  expect(selectDisplayQuotes({ SOL: quote(4, now + 60_000, 'market', 1) }, { SOL: cached }, now).SOL).toBe(cached);
});
