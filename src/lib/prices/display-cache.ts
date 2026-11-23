import { mutate } from 'swr';

import { fetchFromStorage } from 'lib/miden/front/storage';
import { useRetryableSWR } from 'lib/swr';

import type { TokenPriceInfo, TokenPrices } from './binance';
import { PRICE_CACHE_STORAGE_KEY, PRICE_MAX_AGE_SECONDS, USD_SCALE } from './usd';

const DISPLAY_CACHE_KEY = 'cached-display-market-quotes';
/** The same 15-minute window the portfolio uses before it will value a market or basket quote. */
const DISPLAY_QUOTE_MAX_AGE_MS = 15 * 60_000;

function usableObservedAt(quote: TokenPriceInfo, now: number): number | undefined {
  if (quote.kind !== 'market' && quote.kind !== 'basket') return undefined;
  const observedAt = quote.observedAt;
  if (observedAt === undefined || !Number.isFinite(observedAt) || observedAt > now) return undefined;
  if (now - observedAt > DISPLAY_QUOTE_MAX_AGE_MS) return undefined;
  return observedAt;
}

function chooseDisplayQuote(
  liveQuote: TokenPriceInfo | undefined,
  cachedQuote: TokenPriceInfo | undefined,
  now: number
): TokenPriceInfo | undefined {
  if (!cachedQuote) return liveQuote;
  const cachedAt = usableObservedAt(cachedQuote, now);
  if (cachedAt === undefined || now - cachedAt > PRICE_MAX_AGE_SECONDS * 1000) return liveQuote;
  if (!liveQuote) return cachedQuote;
  const liveAt = usableObservedAt(liveQuote, now);
  return liveAt === undefined || cachedAt > liveAt ? cachedQuote : liveQuote;
}

/** One existing quote object per symbol. An absent cache returns the live map unchanged. */
export function selectDisplayQuotes(live: TokenPrices, cached: TokenPrices | undefined, now = Date.now()): TokenPrices {
  if (!cached) return live;
  let selected: TokenPrices | undefined;
  for (const symbol of new Set([...Object.keys(live), ...Object.keys(cached)])) {
    const chosen = chooseDisplayQuote(live[symbol], cached[symbol], now);
    if (chosen === undefined || chosen === live[symbol]) continue;
    selected ??= { ...live };
    selected[symbol] = chosen;
  }
  return selected ?? live;
}

/** A display-only view of the existing market cache. It never authorizes a spend. */
export async function readCachedDisplayQuotes(now = Math.floor(Date.now() / 1000)): Promise<TokenPrices> {
  const cache =
    await fetchFromStorage<Record<string, { priceMicro: string; fetchedAt: number }>>(PRICE_CACHE_STORAGE_KEY);
  const quotes: TokenPrices = {};
  for (const [symbol, entry] of Object.entries(cache ?? {})) {
    if (!/^[A-Z0-9]{1,30}$/.test(symbol) || !entry || !/^[1-9]\d{0,23}$/.test(entry.priceMicro)) continue;
    if (
      !Number.isSafeInteger(entry.fetchedAt) ||
      entry.fetchedAt > now ||
      now - entry.fetchedAt > PRICE_MAX_AGE_SECONDS
    )
      continue;
    quotes[symbol] = {
      price: Number(entry.priceMicro) / Number(USD_SCALE),
      observedAt: entry.fetchedAt * 1000,
      kind: 'market',
      change24h: NaN,
      percentageChange24h: NaN
    };
  }
  return quotes;
}

export async function primeCachedDisplayQuotes(isCurrent: () => boolean): Promise<void> {
  const quotes = await readCachedDisplayQuotes();
  if (isCurrent()) await mutate(DISPLAY_CACHE_KEY, quotes, { revalidate: false });
}

export function useCachedDisplayQuotes(): TokenPrices | undefined {
  return useRetryableSWR(DISPLAY_CACHE_KEY, () => readCachedDisplayQuotes(), {
    suspense: false,
    shouldRetryOnError: false,
    refreshInterval: 60_000
  }).data;
}
