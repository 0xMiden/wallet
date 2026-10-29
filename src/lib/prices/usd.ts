import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { getPriceSymbols } from 'lib/miden/swap/tokens';

import type { TokenPrices } from './binance';
import { isE2eFixtureSymbol, KNOWN_SYMBOLS } from './constant';
import { fetchTokenPrices } from './feed';
import { fixedQuote } from './fixed';

/** One US dollar in the fixed-point unit every spending limit is denominated in. */
export const USD_SCALE = 1_000_000n;

/**
 * How old a cached price may be and still govern a spend.
 *
 * Twice `PriceProvider`'s five-minute refresh, so an open wallet window keeps the cache warm and
 * the backend only reaches the network when nothing else has.
 */
export const PRICE_MAX_AGE_SECONDS = 600;

export const PRICE_CACHE_MAX_ENTRIES = 256;
export const PRICE_CACHE_MAX_BYTES = 65_536;
const encoder = new TextEncoder();

const PRICE_CACHE_STORAGE_KEY = 'usd_price_cache';
const CANONICAL_PRICE = /^(0|[1-9]\d*)$/;

interface CachedUsdPrice {
  priceMicro: string;
  fetchedAt: number;
}

type UsdPriceCache = Record<string, CachedUsdPrice>;

/** Accept fixed quotes, fixture quotes, existing feed assets, and assets from verified faucet mappings. */
export const isCoveredSymbol = (symbol: string): boolean =>
  typeof KNOWN_SYMBOLS[symbol] === 'string' ||
  fixedQuote(symbol) !== undefined ||
  isE2eFixtureSymbol(symbol) ||
  getPriceSymbols().includes(symbol);

export const toPriceMicro = (price: number): bigint | undefined => {
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const micro = BigInt(Math.round(price * Number(USD_SCALE)));
  return micro > 0n ? micro : undefined;
};

const readCacheState = async (): Promise<{ cache: UsdPriceCache; present: boolean }> => {
  try {
    const cache = await fetchFromStorage<UsdPriceCache>(PRICE_CACHE_STORAGE_KEY);
    if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) return { cache: {}, present: false };
    return { cache, present: true };
  } catch {
    return { cache: {}, present: false };
  }
};

const readCache = async (): Promise<UsdPriceCache> => (await readCacheState()).cache;

const stablePrices = (cache: UsdPriceCache): string =>
  JSON.stringify(
    Object.entries(cache)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([symbol, entry]) => [
        symbol,
        entry &&
          Object.entries(entry)
            .filter(([, value]) => value !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
      ])
  );

const boundedPrices = (cache: UsdPriceCache, now: number, preferred: ReadonlySet<string>): UsdPriceCache => {
  const entries = Object.entries(cache)
    .filter(([symbol]) => cachedPriceMicro(cache, symbol, now) !== undefined)
    .sort(
      ([leftSymbol, left], [rightSymbol, right]) =>
        Number(preferred.has(rightSymbol)) - Number(preferred.has(leftSymbol)) || right.fetchedAt - left.fetchedAt
    );
  const retained: [string, CachedUsdPrice][] = [];
  let bytes = 2;
  for (const [symbol, entry] of entries) {
    const value = { priceMicro: entry.priceMicro, fetchedAt: entry.fetchedAt };
    const nextBytes =
      bytes + encoder.encode(JSON.stringify({ [symbol]: value })).byteLength - 2 + (retained.length > 0 ? 1 : 0);
    if (nextBytes > PRICE_CACHE_MAX_BYTES) continue;
    retained.push([symbol, value]);
    bytes = nextBytes;
    if (retained.length === PRICE_CACHE_MAX_ENTRIES) break;
  }
  return Object.fromEntries(retained);
};

let cacheWrite: Promise<UsdPriceCache> = Promise.resolve({});

// `requested` are symbols whose coverage the caller already decided, possibly for another network.
const mergeIntoCache = (
  prices: TokenPrices,
  now: number,
  requested: readonly string[] = []
): Promise<UsdPriceCache> => {
  const run = () => mergePrices(prices, now, requested);
  cacheWrite = cacheWrite.then(run, run);
  return cacheWrite;
};

const mergePrices = async (prices: TokenPrices, now: number, requested: readonly string[]): Promise<UsdPriceCache> => {
  const stored = await readCacheState();
  const cache = { ...stored.cache };
  const accepted = new Set<string>();
  for (const [symbol, info] of Object.entries(prices)) {
    if (!requested.includes(symbol) && !isCoveredSymbol(symbol)) continue;
    const priceMicro = toPriceMicro(info.price);
    if (priceMicro === undefined) continue;
    cache[symbol] = { priceMicro: priceMicro.toString(), fetchedAt: now };
    accepted.add(symbol);
  }
  const bounded = boundedPrices(cache, now, accepted);
  if (stored.present && stablePrices(stored.cache) === stablePrices(bounded)) return bounded;
  try {
    await putToStorage(PRICE_CACHE_STORAGE_KEY, bounded);
  } catch {
    // A cache that cannot be written is a slower next read, never a wrong verdict.
  }
  return bounded;
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
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined;
  if (typeof entry.priceMicro !== 'string' || !CANONICAL_PRICE.test(entry.priceMicro)) return undefined;
  if (!Number.isSafeInteger(entry.fetchedAt) || entry.fetchedAt < 0) return undefined;
  // A future-dated entry is a skewed clock, not evidence of freshness.
  if (entry.fetchedAt > now || now - entry.fetchedAt > PRICE_MAX_AGE_SECONDS) return undefined;
  const price = BigInt(entry.priceMicro);
  return price > 0n ? price : undefined;
};

// A symbol in flight shares its request with every caller. Cache writes run in order across requests.
const inFlightRefresh = new Map<string, Promise<UsdPriceCache>>();

/** One request for the symbols not already in flight; resolves to the caches that hold `symbols`. */
const refresh = (now: number, symbols: readonly string[]): Promise<UsdPriceCache[]> => {
  const missing = [...new Set(symbols)].filter(symbol => !inFlightRefresh.has(symbol));
  if (missing.length > 0) {
    const pending = (async () => {
      try {
        return await mergeIntoCache(await fetchTokenPrices(missing), now, missing);
      } catch {
        return await readCache();
      } finally {
        for (const symbol of missing) inFlightRefresh.delete(symbol);
      }
    })();
    for (const symbol of missing) inFlightRefresh.set(symbol, pending);
  }
  return Promise.all(new Set(symbols.flatMap(symbol => inFlightRefresh.get(symbol) ?? [])));
};

const refreshedPriceMicro = (caches: readonly UsdPriceCache[], symbol: string, now: number): bigint | undefined => {
  for (const cache of caches) {
    const price = cachedPriceMicro(cache, symbol, now);
    if (price !== undefined) return price;
  }
  return undefined;
};

/** Refresh one valuation's cold symbols in a single feed request, so pricing several assets waits once. */
export const prefetchUsdPrices = async (
  symbols: readonly string[],
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  const cache = await readCache();
  const cold = symbols.filter(
    symbol =>
      fixedQuote(symbol) === undefined &&
      !isE2eFixtureSymbol(symbol) &&
      cachedPriceMicro(cache, symbol, now) === undefined
  );
  if (cold.length > 0) await refresh(now, cold);
};

/**
 * The price of one whole unit of `symbol` in micro-dollars, or `undefined` when the symbol is
 * covered by the feed but no fresh price can be produced.
 *
 * Callers decide coverage first (the spending cap by its faucet-id allowlist): this function cannot
 * tell "nobody prices this asset" from "the price is missing right now", and those two cases have
 * opposite consequences.
 */
export const getPriceMicro = async (
  symbol: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<bigint | undefined> => {
  const fixed = fixedQuote(symbol);
  if (fixed !== undefined) return toPriceMicro(fixed.price);
  if (isE2eFixtureSymbol(symbol)) return USD_SCALE;
  const cached = cachedPriceMicro(await readCache(), symbol, now);
  if (cached !== undefined) return cached;
  return refreshedPriceMicro(await refresh(now, [symbol]), symbol, now);
};

/** Test seam: the single-flight handle is module state and would leak between cases. */
export const __resetUsdPriceCacheForTests = (): void => {
  inFlightRefresh.clear();
  cacheWrite = Promise.resolve({});
};
