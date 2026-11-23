import { mutate } from 'swr';

import { fetchFromStorage } from 'lib/miden/front/storage';
import { useRetryableSWR } from 'lib/swr';

import type { TokenPrices } from './binance';
import { PRICE_CACHE_STORAGE_KEY, PRICE_MAX_AGE_SECONDS, USD_SCALE } from './usd';

const DISPLAY_CACHE_KEY = 'cached-display-market-quotes';

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
