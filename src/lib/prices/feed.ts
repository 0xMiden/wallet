import {
  fetchKlineData as fetchBinanceKlineData,
  fetchTokenPrices as fetchBinancePrices,
  isListedSymbol
} from './binance';
import type { KlinePoint, Timeframe, TokenPrices } from './binance';
import { fetchKrakenKlineData, fetchKrakenPrices, findKrakenUsdMarket } from './kraken';

const krakenMarkets = new Map<string, string | null>();
const pendingMarkets = new Map<string, Promise<string | null>>();

async function resolveKrakenMarket(symbol: string): Promise<string | null> {
  if (krakenMarkets.has(symbol)) return krakenMarkets.get(symbol) ?? null;
  const pending = pendingMarkets.get(symbol);
  if (pending) return pending;
  const request = findKrakenUsdMarket(symbol).then(pair => {
    krakenMarkets.set(symbol, pair);
    return pair;
  });
  pendingMarkets.set(symbol, request);
  try {
    return await request;
  } finally {
    pendingMarkets.delete(symbol);
  }
}

/** True only after both providers answered and neither lists the asset; a failed lookup proves nothing. */
export function hasNoUsdMarket(symbol: string): boolean {
  return !isListedSymbol(symbol) && krakenMarkets.get(symbol) === null;
}

/** The symbols the feed asks Kraken about once Binance has ruled them out. */
function krakenSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{1,30}$/.test(symbol);
}

/**
 * True while a USD quote for `symbol` may still come: until the feed has ruled its market out at both providers. A
 * symbol the feed never sends to Kraken waits on Binance's verdict alone, and no symbol waits on nothing.
 */
export function usdMarketPending(symbol: string | undefined): boolean {
  if (symbol === undefined) return false;
  return krakenSymbol(symbol) ? !hasNoUsdMarket(symbol) : isListedSymbol(symbol);
}

/** Fetch Binance prices first, then direct USD prices for assets it does not list. */
function timestampPrices(prices: TokenPrices): TokenPrices {
  const observedAt = Date.now();
  return Object.fromEntries(Object.entries(prices).map(([symbol, quote]) => [symbol, { ...quote, observedAt }]));
}

export async function fetchTokenPrices(symbols: readonly string[] = []): Promise<TokenPrices> {
  const prices = await fetchBinancePrices(symbols);
  // PYUSD has a Kraken USD market but no Binance USDT or USDC market.
  // Use this fallback only when both Binance markets are absent, not when a request fails.
  const queue = [...new Set(symbols)].filter(symbol => krakenSymbol(symbol) && !isListedSymbol(symbol));
  const resolved = new Map<string, string>();
  const resolveNext = async (): Promise<void> => {
    for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
      try {
        const pair = await resolveKrakenMarket(symbol);
        if (pair) resolved.set(symbol, pair);
      } catch {
        // Retry failed market checks on the next price refresh.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, resolveNext));
  if (resolved.size === 0) return timestampPrices(prices);
  try {
    return timestampPrices({ ...prices, ...(await fetchKrakenPrices(resolved)) });
  } catch {
    return timestampPrices(prices);
  }
}

/** Use the same provider selection for chart history and current prices. */
export async function fetchKlineData(symbol: string, timeframe: Timeframe): Promise<KlinePoint[]> {
  const points = await fetchBinanceKlineData(symbol, timeframe);
  if (isListedSymbol(symbol)) return points;
  try {
    const pair = await resolveKrakenMarket(symbol);
    return pair ? await fetchKrakenKlineData(pair, timeframe) : [];
  } catch {
    return [];
  }
}
