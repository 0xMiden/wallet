import { useSyncExternalStore } from 'react';

import { mutate } from 'swr';

import { fetchFromStorage } from 'lib/miden/front/storage';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { useRetryableSWR } from 'lib/swr';
import { useLoadedList } from 'lib/token-list/useLoadedList';

import type { TokenPriceInfo, TokenPrices } from './binance';
import { DISPLAY_QUOTE_MAX_AGE_MS, loadPriceListKey, peekPriceListKey, readDisplayFeed } from './display-feed';
import { PRICE_CACHE_STORAGE_KEY, USD_SCALE } from './usd';

const DISPLAY_CACHE_KEY = 'cached-display-market-quotes';
const displayCacheKey = (network: string, listKey: string) => [DISPLAY_CACHE_KEY, network, listKey];
const sameKey = (a: string | undefined, b: string | undefined): boolean => a === b;

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
  if (cachedAt === undefined) return liveQuote;
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

/**
 * A display-only view of the market cache and the last feed's basket values on `network` under list revision
 * `listKey`. It never authorizes a spend.
 */
export async function readCachedDisplayQuotes(
  now = Math.floor(Date.now() / 1000),
  network = getEffectiveNetworkName(),
  listKey = ''
): Promise<TokenPrices> {
  const [cache, baskets] = await Promise.all([
    fetchFromStorage<Record<string, { priceMicro: string; fetchedAt: number }>>(PRICE_CACHE_STORAGE_KEY),
    readDisplayFeed(network, now * 1000, listKey)
  ]);
  const quotes: TokenPrices = { ...baskets };
  for (const [symbol, entry] of Object.entries(cache ?? {})) {
    if (!/^[A-Z0-9]{1,30}$/.test(symbol) || !entry || !/^[1-9]\d{0,23}$/.test(entry.priceMicro)) continue;
    if (
      !Number.isSafeInteger(entry.fetchedAt) ||
      entry.fetchedAt > now ||
      (now - entry.fetchedAt) * 1000 > DISPLAY_QUOTE_MAX_AGE_MS ||
      // The market cache keeps every symbol it ever priced; a newer basket value for it is the later answer.
      (quotes[symbol]?.observedAt ?? -1) > entry.fetchedAt * 1000
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

/** Fills the key `useCachedDisplayQuotes` reads for the current network and its loaded list revision. */
export async function primeCachedDisplayQuotes(isCurrent: () => boolean): Promise<void> {
  const network = getEffectiveNetworkName();
  const listKey = (await loadPriceListKey(network)) ?? '';
  if (!isCurrent()) return;
  const quotes = await readCachedDisplayQuotes(undefined, network, listKey);
  if (isCurrent()) await mutate(displayCacheKey(network, listKey), quotes, { revalidate: false });
}

export function useCachedDisplayQuotes(): TokenPrices | undefined {
  const network = useSyncExternalStore(subscribeBridgeConfig, getEffectiveNetworkName);
  const listKey = useLoadedList(network, loadPriceListKey, peekPriceListKey, sameKey) ?? '';
  return useRetryableSWR(
    displayCacheKey(network, listKey),
    () => readCachedDisplayQuotes(undefined, network, listKey),
    {
      suspense: false,
      shouldRetryOnError: false,
      refreshInterval: 60_000,
      // A network or list change keeps the last quotes for the one storage read, rather than dropping every one.
      keepPreviousData: true
    }
  ).data;
}
