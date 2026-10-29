import axios from 'axios';

import { fixedQuote } from './fixed';
import { hasUnquotedDefaultPrice } from './unquoted-default';

const BINANCE_API_BASE = 'https://data-api.binance.vision/api/v3';

export interface TokenPriceInfo {
  /** Retrieval time in milliseconds; missing timestamps cannot authorize USD entry. */
  observedAt?: number;
  price: number;
  change24h: number;
  percentageChange24h: number;
}

export type TokenPrices = Record<string, TokenPriceInfo>;

interface BinanceTicker24hr {
  symbol: string;
  lastPrice: string;
  priceChange: string;
}

interface BinanceMarket {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
}

interface ResolvedMarket {
  pair: string;
  denominator: 'USDT' | 'USDC';
}

const markets = new Map<string, ResolvedMarket | null>();
const pendingMarkets = new Map<string, Promise<ResolvedMarket | null>>();
let exchangeMarkets: ReadonlyMap<string, BinanceMarket> | undefined;
let pendingExchangeMarkets: Promise<ReadonlyMap<string, BinanceMarket>> | undefined;

function validSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{1,30}$/.test(symbol);
}

async function readExchangeMarkets(): Promise<ReadonlyMap<string, BinanceMarket>> {
  if (exchangeMarkets) return exchangeMarkets;
  if (pendingExchangeMarkets) return pendingExchangeMarkets;
  const request = async (): Promise<ReadonlyMap<string, BinanceMarket>> => {
    // A missing pair's HTTP error can omit CORS headers. Read successful bulk metadata instead.
    const { data } = await axios.get<{ symbols?: BinanceMarket[] }>(`${BINANCE_API_BASE}/exchangeInfo`, {
      params: { showPermissionSets: false },
      timeout: 10_000
    });
    if (
      !Array.isArray(data.symbols) ||
      data.symbols.length === 0 ||
      !data.symbols.every(
        market =>
          typeof market.symbol === 'string' &&
          market.symbol.length > 0 &&
          typeof market.status === 'string' &&
          market.status.length > 0 &&
          typeof market.baseAsset === 'string' &&
          market.baseAsset.length > 0 &&
          typeof market.quoteAsset === 'string' &&
          market.quoteAsset.length > 0
      )
    ) {
      throw new Error('Binance market metadata is invalid');
    }
    const result = new Map(data.symbols.map(market => [market.symbol, market]));
    exchangeMarkets = result;
    return result;
  };
  pendingExchangeMarkets = request();
  try {
    return await pendingExchangeMarkets;
  } finally {
    pendingExchangeMarkets = undefined;
  }
}

async function findMarket(symbol: string): Promise<ResolvedMarket | null> {
  const listings = await readExchangeMarkets();
  for (const denominator of ['USDT', 'USDC']) {
    const pair = `${symbol}${denominator}`;
    const market = listings.get(pair);
    if (market?.status === 'TRADING' && market.baseAsset === symbol && market.quoteAsset === denominator) {
      switch (denominator) {
        case 'USDT':
        case 'USDC':
          return { pair, denominator };
      }
    }
  }
  return null;
}

async function resolveMarket(symbol: string): Promise<ResolvedMarket | null> {
  if (!validSymbol(symbol)) {
    markets.set(symbol, null);
    return null;
  }
  if (markets.has(symbol)) return markets.get(symbol) ?? null;
  const pending = pendingMarkets.get(symbol);
  if (pending) return pending;
  const request = findMarket(symbol).then(market => {
    markets.set(symbol, market);
    return market;
  });
  pendingMarkets.set(symbol, request);
  try {
    return await request;
  } finally {
    pendingMarkets.delete(symbol);
  }
}

function tickerQuote(ticker: BinanceTicker24hr): TokenPriceInfo | undefined {
  const price = Number(ticker.lastPrice);
  const change24h = Number(ticker.priceChange);
  const previous = price - change24h;
  const percentageChange24h = (change24h / previous) * 100;
  if (
    !(price > 0) ||
    !(previous > 0) ||
    !Number.isFinite(price) ||
    !Number.isFinite(change24h) ||
    !Number.isFinite(previous) ||
    !Number.isFinite(percentageChange24h)
  ) {
    return undefined;
  }
  return { price, change24h, percentageChange24h };
}

/** Fetch USD prices for the requested assets and both quote currencies. */
export async function fetchTokenPrices(symbols: readonly string[] = []): Promise<TokenPrices> {
  const resolved = new Map<string, ResolvedMarket>();
  const queue = [...new Set(symbols)].filter(symbol => symbol !== 'USDT' && symbol !== 'USDC');
  const resolveNext = async (): Promise<void> => {
    for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
      try {
        const market = await resolveMarket(symbol);
        if (market) resolved.set(symbol, market);
      } catch {
        // A failed request does not prove that a market is absent.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, resolveNext));
  const pairs = ['USDTUSD', 'USDCUSD', ...[...resolved.values()].map(market => market.pair)];
  const prices: TokenPrices = {};
  const tickers = new Map<string, BinanceTicker24hr>();
  const uniquePairs = [...new Set(pairs)];
  for (let offset = 0; offset < uniquePairs.length; offset += 100) {
    try {
      const { data } = await axios.get<BinanceTicker24hr[]>(`${BINANCE_API_BASE}/ticker/24hr`, {
        params: { symbols: JSON.stringify(uniquePairs.slice(offset, offset + 100)), type: 'FULL' },
        timeout: 10_000
      });
      for (const ticker of data) tickers.set(ticker.symbol, ticker);
    } catch (error) {
      if (
        !axios.isAxiosError<{ code?: number }>(error) ||
        error.response?.status !== 400 ||
        error.response.data.code !== -1121
      ) {
        console.warn('[Binance] Failed to fetch prices:', error);
        continue;
      }
      // Refresh metadata once so a removed market cannot block all future batches.
      exchangeMarkets = undefined;
      markets.clear();
      let metadataAvailable = false;
      try {
        await readExchangeMarkets();
        metadataAvailable = true;
      } catch {
        // Keep the other ticker requests usable while metadata is unavailable.
      }
      // One removed market must not stop prices for the other assets.
      for (const pair of uniquePairs.slice(offset, offset + 100)) {
        try {
          const { data } = await axios.get<BinanceTicker24hr>(`${BINANCE_API_BASE}/ticker/24hr`, {
            params: { symbol: pair, type: 'FULL' },
            timeout: 10_000
          });
          tickers.set(data.symbol, data);
        } catch (pairError) {
          if (
            !axios.isAxiosError<{ code?: number }>(pairError) ||
            pairError.response?.status !== 400 ||
            pairError.response.data.code !== -1121
          ) {
            continue;
          }
          for (const [symbol, market] of [...resolved]) {
            if (market.pair !== pair) continue;
            markets.delete(symbol);
            resolved.delete(symbol);
            if (!metadataAvailable) continue;
            try {
              const replacement = await resolveMarket(symbol);
              if (!replacement) continue;
              resolved.set(symbol, replacement);
              if (replacement.pair === pair) continue;
              const { data } = await axios.get<BinanceTicker24hr>(`${BINANCE_API_BASE}/ticker/24hr`, {
                params: { symbol: replacement.pair, type: 'FULL' },
                timeout: 10_000
              });
              tickers.set(data.symbol, data);
            } catch {
              // Retry transient failures on the next refresh.
            }
          }
        }
      }
    }
  }
  for (const symbol of ['USDT', 'USDC']) {
    const ticker = tickers.get(`${symbol}USD`);
    const quote = ticker && tickerQuote(ticker);
    if (quote) prices[symbol] = quote;
  }
  for (const [symbol, market] of resolved) {
    const ticker = tickers.get(market.pair);
    const asset = ticker && tickerQuote(ticker);
    const denominator = prices[market.denominator];
    if (!asset || !denominator) continue;
    const price = asset.price * denominator.price;
    const previous = (asset.price - asset.change24h) * (denominator.price - denominator.change24h);
    if (!Number.isFinite(price) || !Number.isFinite(previous) || !(previous > 0)) continue;
    const change24h = price - previous;
    if (!Number.isFinite(change24h) || !Number.isFinite((change24h / previous) * 100)) continue;
    prices[symbol] = { price, change24h, percentageChange24h: (change24h / previous) * 100 };
  }
  return prices;
}

/** Return true until market lookup proves that the asset has no active market. */
export function isListedSymbol(symbol: string | undefined): boolean {
  return symbol !== undefined && validSymbol(symbol) && markets.get(symbol) !== null;
}

/** Return true when quotes are available or every requested asset has a final result. */
export function pricesLoaded(prices: TokenPrices, priceSymbols: Iterable<string | undefined>): boolean {
  const requested = [...priceSymbols];
  // USDT and USDC come back with every fetch as conversion rates, so alone they say nothing about an asset.
  const quoted = Object.keys(prices).some(
    symbol => (symbol !== 'USDT' && symbol !== 'USDC') || requested.includes(symbol)
  );
  if (quoted) return true;
  let settled = false;
  for (const symbol of requested) {
    if (fixedQuote(symbol) || (symbol !== undefined && markets.get(symbol) === null)) {
      settled = true;
      continue;
    }
    if (!hasUnquotedDefaultPrice() || isListedSymbol(symbol)) return false;
    settled = true;
  }
  return settled || hasUnquotedDefaultPrice();
}

/** Display rate for tokens without a price asset when the test-network switch is on. */
const TEST_NETWORK_UNQUOTED_PRICE: TokenPriceInfo = { price: 1, change24h: 0, percentageChange24h: 0 };

/** Identify the test-network display rate by reference. It is not a market price. */
export function isNominalQuote(quote: TokenPriceInfo | undefined): boolean {
  return quote === TEST_NETWORK_UNQUOTED_PRICE;
}

/** Return a USD quote. An absent market or a failed request has no quote. */
export function quotedPrice(prices: TokenPrices, symbol: string | undefined): TokenPriceInfo | undefined {
  const fixed = fixedQuote(symbol);
  if (fixed) return fixed;
  const quote = symbol === undefined ? undefined : prices[symbol];
  if (quote && quote.price > 0) return quote;
  if (symbol !== undefined && markets.get(symbol) === null) return undefined;
  return !isListedSymbol(symbol) && hasUnquotedDefaultPrice() ? TEST_NETWORK_UNQUOTED_PRICE : undefined;
}

/** Return the USD unit price, or zero when no quote is available. */
export function listedPrice(prices: TokenPrices, symbol: string | undefined): number {
  return quotedPrice(prices, symbol)?.price ?? 0;
}

/** Return the USD balance value only when the unit scale, balance, and price are valid. */
export function listedFiatValue(
  prices: TokenPrices,
  symbol: string | undefined,
  balance: number,
  scaleIsKnown: boolean
): number | undefined {
  const price = listedPrice(prices, symbol);
  if (!scaleIsKnown || !(price > 0) || !Number.isFinite(balance) || balance < 0) return undefined;
  return balance * price;
}

// --- Kline (candlestick) chart data ---

export type Timeframe = '1H' | '1D' | '1W' | '1M' | 'YTD';

export interface KlinePoint {
  time: number;
  value: number;
}

const TIMEFRAME_CONFIGS: Record<Exclude<Timeframe, 'YTD'>, { interval: string; limit: number }> = {
  '1H': { interval: '1m', limit: 60 },
  '1D': { interval: '5m', limit: 288 },
  '1W': { interval: '1h', limit: 168 },
  '1M': { interval: '6h', limit: 120 }
};

function getYtdConfig(): { interval: string; limit: number; startTime: number } {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const startTime = startOfYear.getTime();
  const daysElapsed = Math.ceil((now.getTime() - startTime) / (1000 * 60 * 60 * 24));

  const days = Math.max(1, daysElapsed);
  switch (true) {
    case days <= 90:
      return { interval: '6h', limit: Math.min(days * 4, 1000), startTime };
    case days <= 180:
      return { interval: '12h', limit: Math.min(days * 2, 1000), startTime };
    default:
      return { interval: '1d', limit: Math.min(days, 1000), startTime };
  }
}

/** Fetch USD close prices. Return no points if a market or its historical USD rate is unavailable. */
export async function fetchKlineData(walletSymbol: string, timeframe: Timeframe): Promise<KlinePoint[]> {
  try {
    const direct = walletSymbol === 'USDT' || walletSymbol === 'USDC';
    const market = direct ? null : await resolveMarket(walletSymbol);
    if (!direct && !market) return [];
    const binancePair = direct ? `${walletSymbol}USD` : market?.pair;
    if (!binancePair) return [];
    const params: Record<string, string | number> = { symbol: binancePair };
    const config = timeframe === 'YTD' ? getYtdConfig() : TIMEFRAME_CONFIGS[timeframe];
    Object.assign(params, config);
    const read = async (symbol: string): Promise<KlinePoint[]> => {
      const { data } = await axios.get<(string | number)[][]>(`${BINANCE_API_BASE}/uiKlines`, {
        params: { ...params, symbol },
        timeout: 10_000
      });
      return data.flatMap(row => {
        const time = row[0];
        const value = Number(row[4]);
        return typeof time === 'number' && Number.isFinite(time) && value > 0 && Number.isFinite(value)
          ? [{ time, value }]
          : [];
      });
    };
    if (!market) return await read(binancePair);
    const [asset, denominator] = await Promise.all([read(binancePair), read(`${market.denominator}USD`)]);
    const rates = new Map(denominator.map(point => [point.time, point.value]));
    return asset.flatMap(point => {
      const rate = rates.get(point.time);
      if (rate === undefined) return [];
      const value = point.value * rate;
      return Number.isFinite(value) && value > 0 ? [{ time: point.time, value }] : [];
    });
  } catch (error) {
    console.warn('[Binance] Failed to fetch kline data:', error);
    return [];
  }
}
