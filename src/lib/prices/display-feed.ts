import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { isRecord } from 'lib/update/guards';

import type { TokenPrices } from './binance';

/**
 * How old a remembered feed answer may be and still show a last-known balance while the live feed loads or is
 * unreachable. Display only: a spend reads the 10-minute `usd_price_cache` rule, and the portfolio history records
 * live quotes alone.
 */
export const DISPLAY_QUOTE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * What the last full feed run on a network answered that the spend cache cannot hold: each basket's value, and the
 * assets every market source ruled out (Gamecoin on mainnet). Never read by spend valuation, which would count a
 * ruled-out asset as worth nothing.
 */
interface DisplayFeed {
  fetchedAt: number;
  baskets: Record<string, number>;
  unquoted: string[];
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
    unquoted: value.unquoted.filter((symbol): symbol is string => typeof symbol === 'string')
  };
}

const fresh = (feed: DisplayFeed | undefined, now: number): feed is DisplayFeed =>
  feed !== undefined && feed.fetchedAt <= now && now - feed.fetchedAt <= DISPLAY_QUOTE_MAX_AGE_MS;

/** Reads `network`'s stored answers into this realm, so `feedFoundNoQuote` answers from them. */
export async function readDisplayFeed(network: string, now = Date.now()): Promise<TokenPrices> {
  try {
    const feed = parseDisplayFeed(await fetchFromStorage<unknown>(displayFeedKey(network)));
    if (feed && (remembered.get(network)?.fetchedAt ?? -1) <= feed.fetchedAt) remembered.set(network, feed);
  } catch {
    // An unreadable record leaves what this realm already knows.
  }
  const feed = remembered.get(network);
  if (!fresh(feed, now)) return {};
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
  fetchedAt = Date.now()
): Promise<void> {
  const baskets: Record<string, number> = {};
  for (const [symbol, quote] of Object.entries(prices)) {
    if (quote.kind === 'basket' && Number.isFinite(quote.price) && quote.price > 0) baskets[symbol] = quote.price;
  }
  const feed = { fetchedAt, baskets, unquoted: unquoted.filter(symbol => !(symbol in prices)) };
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
