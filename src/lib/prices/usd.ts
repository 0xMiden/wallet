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
 * The E2E harness's own fixture faucet symbol, and the exact dollar rate it prices at.
 *
 * The live feed can never price a symbol the harness invents on the fly for a throwaway devnet
 * faucet, so without this an E2E spending-limit cap could never be breached - every spend of the
 * fixture token would count as zero, no matter what the suite configured, and the enforcement
 * path this exists to test would be permanently unverifiable end to end. $1.00 per whole unit is
 * arbitrary but exact, so a spec's existing native-unit figures convert to identical dollar
 * figures with no rescaling. Confined to `MIDEN_E2E_TEST` builds - no App Store or Play Store
 * submission is built with it, though `store-listing:capture:build` (package.json) does build
 * real mobile and Chrome bundles with the flag set, for store-screenshot capture only.
 *
 * Deliberately narrow: this shortcuts only `isCoveredSymbol`/`getPriceMicro` for the one fixture
 * symbol, so `readCache`, the freshness window and a covered asset's
 * `SpendingLimitPriceUnavailableError` refusal stay entirely unexercised by an E2E run. Widening
 * it to cover those too would mean seeding the price cache across realms (a frontend write the
 * backend reads) instead of a same-process short-circuit, and that seeded entry would go stale at
 * `PRICE_MAX_AGE_SECONDS` (600s) partway through a long journey - trading this gap for a flakier
 * one.
 */
const E2E_FIXTURE_SYMBOL = 'TST';
const isE2eFixtureSymbol = (symbol: string): boolean =>
  process.env.MIDEN_E2E_TEST === 'true' && symbol === E2E_FIXTURE_SYMBOL;

/**
 * Whether the feed can price this symbol at all.
 *
 * Indexed rather than `in` or `hasOwnProperty` so an inherited member such as `toString` cannot
 * read as covered: the value test is what decides, and a function is not a trading pair.
 */
export const isCoveredSymbol = (symbol: string): boolean =>
  typeof KNOWN_SYMBOLS[symbol] === 'string' || isE2eFixtureSymbol(symbol);

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
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined;
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
  if (isE2eFixtureSymbol(symbol)) return USD_SCALE;
  const cached = cachedPriceMicro(await readCache(), symbol, now);
  if (cached !== undefined) return cached;
  return cachedPriceMicro(await refresh(now), symbol, now);
};

/** Test seam: the single-flight handle is module state and would leak between cases. */
export const __resetUsdPriceCacheForTests = (): void => {
  inFlightRefresh = undefined;
};
