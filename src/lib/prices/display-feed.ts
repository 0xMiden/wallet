import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import {
  loadTokenPriceAssets,
  peekTokenBaskets,
  peekTokenDecimals,
  peekTokenPriceAssets,
  peekTokenSymbols
} from 'lib/token-list/runtime';
import { isRecord } from 'lib/update/guards';

import type { TokenPrices } from './binance';

/**
 * How old a remembered feed answer may be and still show a last-known balance while the live feed loads or is
 * unreachable. Display only: a spend reads the 10-minute `usd_price_cache` rule, and the portfolio history records
 * live quotes alone.
 */
export const DISPLAY_QUOTE_MAX_AGE_MS = 24 * 60 * 60_000;

function entries<T>(map: Map<string, T> | null | undefined): [string, T][] | null | undefined {
  return map ? Array.from(map) : map;
}

/**
 * Everything the price fetch reads from the loaded list (price assets, baskets, decimals and token symbols), as one
 * string, or undefined before the first load. A refresh that changes any of them changes this key, so the fetch runs
 * again.
 */
export function peekPriceListKey(network: string): string | undefined {
  const assets = peekTokenPriceAssets(network);
  if (assets === undefined) return undefined;
  return JSON.stringify([
    entries(assets),
    entries(peekTokenBaskets(network)),
    entries(peekTokenDecimals(network)),
    entries(peekTokenSymbols(network))
  ]);
}

export async function loadPriceListKey(network: string): Promise<string | undefined> {
  await loadTokenPriceAssets(network);
  return peekPriceListKey(network);
}

/**
 * What the last full feed run on a network answered that the spend cache cannot hold: each basket's value, and the
 * assets every market source ruled out (Gamecoin on mainnet). Never read by spend valuation, which would count a
 * ruled-out asset as worth nothing. `listKey` is the list revision the baskets were valued under; the unquoted verdicts
 * are the markets' and hold under any revision.
 */
interface DisplayFeed {
  fetchedAt: number;
  baskets: Record<string, number>;
  unquoted: string[];
  listKey?: string;
}

const displayFeedKey = (network: string) => `display_feed_v1:${network}`;
const remembered = new Map<string, DisplayFeed>();

function parseDisplayFeed(value: unknown): DisplayFeed | undefined {
  if (!isRecord(value) || !isRecord(value.baskets) || !Array.isArray(value.unquoted)) return undefined;
  const { fetchedAt } = value;
  if (typeof fetchedAt !== 'number' || !Number.isSafeInteger(fetchedAt)) return undefined;
  const baskets: Record<string, number> = {};
  for (const [symbol, price] of Object.entries(value.baskets)) {
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) baskets[symbol] = price;
  }
  return {
    fetchedAt,
    baskets,
    unquoted: value.unquoted.filter((symbol): symbol is string => typeof symbol === 'string'),
    ...(typeof value.listKey === 'string' ? { listKey: value.listKey } : {})
  };
}

const fresh = (feed: DisplayFeed | undefined, now: number): feed is DisplayFeed =>
  feed !== undefined && feed.fetchedAt <= now && now - feed.fetchedAt <= DISPLAY_QUOTE_MAX_AGE_MS;

/**
 * Reads `network`'s stored answers into this realm, so `feedFoundNoQuote` answers from them. Returns the basket values
 * only when they were computed under `listKey`.
 */
export async function readDisplayFeed(network: string, now: number, listKey: string): Promise<TokenPrices> {
  try {
    const feed = parseDisplayFeed(await fetchFromStorage<unknown>(displayFeedKey(network)));
    if (feed && (remembered.get(network)?.fetchedAt ?? -1) <= feed.fetchedAt) remembered.set(network, feed);
  } catch {
    // An unreadable record leaves what this realm already knows.
  }
  const feed = remembered.get(network);
  if (!fresh(feed, now) || feed.listKey !== listKey) return {};
  return Object.fromEntries(
    Object.entries(feed.baskets).map(([symbol, price]) => [
      symbol,
      { price, observedAt: feed.fetchedAt, kind: 'basket' as const, change24h: NaN, percentageChange24h: NaN }
    ])
  );
}

/** Records a finished feed run: `prices` is what it returned, `unquoted` what every market source ruled out. */
export async function writeDisplayFeed(
  network: string,
  prices: TokenPrices,
  unquoted: readonly string[],
  listKey?: string,
  fetchedAt = Date.now()
): Promise<void> {
  const baskets: Record<string, number> = {};
  for (const [symbol, quote] of Object.entries(prices)) {
    if (quote.kind === 'basket' && Number.isFinite(quote.price) && quote.price > 0) baskets[symbol] = quote.price;
  }
  const feed: DisplayFeed = {
    fetchedAt,
    baskets,
    unquoted: unquoted.filter(symbol => !(symbol in prices)),
    ...(listKey !== undefined ? { listKey } : {})
  };
  remembered.set(network, feed);
  await putToStorage(displayFeedKey(network), feed).catch(() => undefined);
}

/** True when this network's last feed run, within the display window, found no market for `symbol` anywhere. */
export function feedFoundNoQuote(network: string, symbol: string, now = Date.now()): boolean {
  const feed = remembered.get(network);
  return fresh(feed, now) && feed.unquoted.includes(symbol);
}

export function _resetDisplayFeedForTest(): void {
  remembered.clear();
}
