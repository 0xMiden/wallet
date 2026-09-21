import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { fetchTokenPrices, TokenPrices } from './binance';
import { KNOWN_SYMBOLS } from './constant';

/** One US dollar in the fixed-point unit every spending limit is denominated in. */
export const USD_SCALE = 1_000_000n;

/**
 * How old a cached price may be and still govern a spend.
 *
 * Twice `PriceProvider`'s five-minute refresh, so an open wallet window keeps the cache warm and
 * the backend only reaches the network when nothing else has.
 */
export const PRICE_MAX_AGE_SECONDS = 600;

const PRICE_CACHE_STORAGE_KEY = 'usd_price_cache';
const CANONICAL_PRICE = /^(0|[1-9]\d*)$/;

interface CachedUsdPrice {
  priceMicro: string;
  fetchedAt: number;
}

type UsdPriceCache = Record<string, CachedUsdPrice>;

/**
 * Whether the feed can price this symbol at all.
 *
 * Indexed rather than `in` or `hasOwnProperty` so an inherited member such as `toString` cannot
 * read as covered: the value test is what decides, and a function is not a trading pair.
 */
export const isCoveredSymbol = (symbol: string): boolean => typeof KNOWN_SYMBOLS[symbol] === 'string';

export const toPriceMicro = (price: number): bigint | undefined => {
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const micro = BigInt(Math.round(price * Number(USD_SCALE)));
  return micro > 0n ? micro : undefined;
};

const readCache = async (): Promise<UsdPriceCache> => {
  try {
    return (await fetchFromStorage<UsdPriceCache>(PRICE_CACHE_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
};

const mergeIntoCache = async (prices: TokenPrices, now: number): Promise<UsdPriceCache> => {
  const cache = await readCache();
  for (const [symbol, info] of Object.entries(prices)) {
    if (!isCoveredSymbol(symbol)) continue;
    const priceMicro = toPriceMicro(info.price);
    if (priceMicro === undefined) continue;
    cache[symbol] = { priceMicro: priceMicro.toString(), fetchedAt: now };
  }
  try {
    await putToStorage(PRICE_CACHE_STORAGE_KEY, cache);
  } catch {
    // A cache that cannot be written is a slower next read, never a wrong verdict.
  }
  return cache;
};

/** Write-through used by the foreground provider so the backend rarely has to fetch. */
export const writeUsdPriceCache = async (
  prices: TokenPrices,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  await mergeIntoCache(prices, now);
};

const cachedPriceMicro = (cache: UsdPriceCache, symbol: string, now: number): bigint | undefined => {
  const entry = cache[symbol];
  if (entry === undefined) return undefined;
  if (typeof entry.priceMicro !== 'string' || !CANONICAL_PRICE.test(entry.priceMicro)) return undefined;
  if (!Number.isSafeInteger(entry.fetchedAt) || entry.fetchedAt < 0) return undefined;
  // A future-dated entry is a skewed clock, not evidence of freshness.
  if (entry.fetchedAt > now || now - entry.fetchedAt > PRICE_MAX_AGE_SECONDS) return undefined;
  const price = BigInt(entry.priceMicro);
  return price > 0n ? price : undefined;
};

// One refresh serves every caller that arrives while it is in flight. A transaction moving three
// assets must not open three connections to answer one question.
let inFlightRefresh: Promise<UsdPriceCache> | undefined;

const refresh = async (now: number): Promise<UsdPriceCache> => {
  if (inFlightRefresh === undefined) {
    inFlightRefresh = (async () => {
      try {
        return await mergeIntoCache(await fetchTokenPrices(), now);
      } catch {
        return await readCache();
      } finally {
        inFlightRefresh = undefined;
      }
    })();
  }
  return inFlightRefresh;
};

/**
 * The price of one whole unit of `symbol` in micro-dollars, or `undefined` when the symbol is
 * covered by the feed but no fresh price can be produced.
 *
 * Callers must ask `isCoveredSymbol` first: this function cannot tell "nobody prices this asset"
 * from "the price is missing right now", and those two cases have opposite consequences.
 */
export const getPriceMicro = async (
  symbol: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<bigint | undefined> => {
  const cached = cachedPriceMicro(await readCache(), symbol, now);
  if (cached !== undefined) return cached;
  return cachedPriceMicro(await refresh(now), symbol, now);
};

/** Test seam: the single-flight handle is module state and would leak between cases. */
export const __resetUsdPriceCacheForTests = (): void => {
  inFlightRefresh = undefined;
};
