import axios from 'axios';

import type { KlinePoint, Timeframe, TokenPriceInfo, TokenPrices } from './binance';

const KRAKEN_API_BASE = 'https://api.kraken.com/0/public';
const REQUEST_TIMEOUT = 10_000;

interface KrakenResponse<T> {
  error: string[];
  result: T;
}

interface KrakenMarket {
  wsname?: string;
  quote: string;
  status: string;
}

interface KrakenTicker {
  c: string[];
}

type KrakenCandle = [number, string, string, string, string, string, string, number];
type KrakenHistory = Record<string, KrakenCandle[] | number>;

class KrakenApiError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Kraken: ${errors.join(', ')}`);
  }
}

function hasUnknownPair(error: Error): boolean {
  return (
    error instanceof KrakenApiError &&
    error.errors.length > 0 &&
    error.errors.every(message => message === 'EQuery:Unknown asset pair')
  );
}

async function request<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  const { data } = await axios.get<KrakenResponse<T>>(`${KRAKEN_API_BASE}/${endpoint}`, {
    params,
    timeout: REQUEST_TIMEOUT
  });
  if (data.error.length > 0) throw new KrakenApiError(data.error);
  return data.result;
}

let usdMarkets: ReadonlyMap<string, KrakenMarket> | undefined;
let pendingUsdMarkets: Promise<ReadonlyMap<string, KrakenMarket>> | undefined;

async function readUsdMarkets(): Promise<ReadonlyMap<string, KrakenMarket>> {
  if (usdMarkets) return usdMarkets;
  if (pendingUsdMarkets) return pendingUsdMarkets;
  const read = async (): Promise<ReadonlyMap<string, KrakenMarket>> => {
    // Missing-pair errors can omit CORS headers. Read successful bulk metadata instead.
    const result = await request<Record<string, KrakenMarket>>('AssetPairs', {});
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new Error('Kraken market metadata is invalid');
    }
    const entries = Object.entries(result);
    if (
      entries.length === 0 ||
      !entries.every(
        ([pair, market]) =>
          pair.length > 0 &&
          typeof market === 'object' &&
          market !== null &&
          typeof market.status === 'string' &&
          market.status.length > 0 &&
          typeof market.quote === 'string' &&
          market.quote.length > 0 &&
          (market.wsname === undefined || typeof market.wsname === 'string')
      )
    ) {
      throw new Error('Kraken market metadata is invalid');
    }
    const markets = new Map(entries);
    usdMarkets = markets;
    return markets;
  };
  pendingUsdMarkets = read();
  try {
    return await pendingUsdMarkets;
  } finally {
    pendingUsdMarkets = undefined;
  }
}

/** Find an active direct USD market. A request failure does not prove that a market is absent. */
export async function findKrakenUsdMarket(symbol: string): Promise<string | null> {
  if (!/^[A-Z0-9]{1,30}$/.test(symbol)) return null;
  // PYUSD has a Kraken USD market, but Binance does not list PYUSD.
  const markets = await readUsdMarkets();
  for (const [pair, market] of markets) {
    if (
      market.status === 'online' &&
      (market.quote === 'ZUSD' || market.quote === 'USD') &&
      market.wsname === `${symbol}/USD`
    ) {
      return pair;
    }
  }
  return null;
}

async function readHistory(pair: string, interval: number, since: number): Promise<KrakenCandle[]> {
  const result = await request<KrakenHistory>('OHLC', { pair, interval, since });
  const rows = result[pair];
  if (Array.isArray(rows)) return rows;
  // Kraken can return a canonical pair name instead of the request's alias.
  const series = Object.values(result).filter(Array.isArray);
  return series.length === 1 ? (series[0] ?? []) : [];
}

async function quoteWithHistory(pair: string, ticker: KrakenTicker, now: number): Promise<TokenPriceInfo | undefined> {
  const price = Number(ticker.c[0]);
  if (!(price > 0) || !Number.isFinite(price)) return undefined;
  const target = now - 24 * 60 * 60;
  const interval = 5 * 60;
  const since = Math.floor(target / interval) * interval - interval;
  const rows = await readHistory(pair, 5, since);
  let previousTime = 0;
  let previous = 0;
  for (const row of rows) {
    const closeTime = row[0] + interval;
    const value = Number(row[4]);
    if (
      closeTime <= target &&
      closeTime > target - interval &&
      closeTime > previousTime &&
      value > 0 &&
      Number.isFinite(value)
    ) {
      previousTime = closeTime;
      previous = value;
    }
  }
  if (!(previous > 0)) return undefined;
  // The rolling 24-hour change uses a completed close with five-minute precision.
  // Kraken's ticker open is midnight UTC, so it is not a rolling 24-hour reference.
  const change24h = price - previous;
  const percentageChange24h = (change24h / previous) * 100;
  if (!Number.isFinite(change24h) || !Number.isFinite(percentageChange24h)) return undefined;
  return { price, change24h, percentageChange24h };
}

/** Fetch direct USD prices. Omit a quote when its 24-hour reference is unavailable. */
export async function fetchKrakenPrices(markets: ReadonlyMap<string, string>): Promise<TokenPrices> {
  if (markets.size === 0) return {};
  const tickers = new Map<string, KrakenTicker>();
  const pairs = [...new Set(markets.values())];
  for (let offset = 0; offset < pairs.length; offset += 50) {
    const batch = pairs.slice(offset, offset + 50);
    try {
      const result = await request<Record<string, KrakenTicker>>('Ticker', { pair: batch.join(',') });
      for (const [pair, ticker] of Object.entries(result)) tickers.set(pair, ticker);
    } catch (error) {
      if (!(error instanceof Error) || !hasUnknownPair(error)) continue;
      for (const pair of batch) {
        try {
          const result = await request<Record<string, KrakenTicker>>('Ticker', { pair });
          for (const [key, ticker] of Object.entries(result)) tickers.set(key, ticker);
        } catch {
          // One unavailable market must not stop quotes for the other assets.
        }
      }
    }
  }
  const prices: TokenPrices = {};
  const now = Math.floor(Date.now() / 1000);
  const queue = [...markets];
  const readNext = async (): Promise<void> => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const [symbol, pair] = entry;
      const ticker = tickers.get(pair);
      if (!ticker) continue;
      try {
        const quote = await quoteWithHistory(pair, ticker, now);
        if (quote) prices[symbol] = quote;
      } catch {
        // A failed history request has no usable 24-hour quote.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, readNext));
  return prices;
}

const HISTORY_CONFIGS: Record<Exclude<Timeframe, 'YTD'>, { interval: number; seconds: number }> = {
  '1H': { interval: 1, seconds: 60 * 60 },
  '1D': { interval: 5, seconds: 24 * 60 * 60 },
  '1W': { interval: 60, seconds: 7 * 24 * 60 * 60 },
  '1M': { interval: 240, seconds: 30 * 24 * 60 * 60 }
};

/** Fetch direct USD close prices within the requested time range. */
export async function fetchKrakenKlineData(pair: string, timeframe: Timeframe): Promise<KlinePoint[]> {
  const now = Math.floor(Date.now() / 1000);
  const config =
    timeframe === 'YTD'
      ? { interval: 1440, seconds: now - Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000) }
      : HISTORY_CONFIGS[timeframe];
  const since = now - config.seconds;
  try {
    const rows = await readHistory(pair, config.interval, since);
    return rows.flatMap(row => {
      const time = row[0];
      const value = Number(row[4]);
      return Number.isFinite(time) && time >= since && time <= now && value > 0 && Number.isFinite(value)
        ? [{ time: time * 1000, value }]
        : [];
    });
  } catch {
    return [];
  }
}
