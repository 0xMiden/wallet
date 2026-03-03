import axios from 'axios';

import { KNOWN_SYMBOLS } from './constant';

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';

/**
 * Map of wallet token symbols to Binance trading pair symbols.
 * Only tokens listed here will have real price data fetched.
 * All other tokens default to $1 USD.
 */

export interface TokenPriceInfo {
  price: number;
  change24h: number;
}

export type TokenPrices = Record<string, TokenPriceInfo>;

export const DEFAULT_PRICE: TokenPriceInfo = { price: 1, change24h: 0 };

interface BinanceTicker24hr {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
}

/**
 * Fetch token prices and 24hr change from Binance API.
 * Returns a map of wallet symbol -> { price, change24h }.
 * On any error, returns an empty object (callers should default to $1).
 */
export async function fetchTokenPrices(): Promise<TokenPrices> {
  const entries = Object.entries(KNOWN_SYMBOLS);
  if (entries.length === 0) return {};

  const binanceSymbols = entries.map(([, pair]) => pair);
  try {
    const { data } = await axios.get<BinanceTicker24hr[]>(`${BINANCE_API_BASE}/ticker/24hr`, {
      params: {
        symbols: JSON.stringify(binanceSymbols),
        type: 'FULL'
      }
    });

    // Build reverse map: Binance pair -> wallet symbol
    const pairToSymbol: Record<string, string> = {};
    for (const [walletSymbol, binancePair] of entries) {
      pairToSymbol[binancePair] = walletSymbol;
    }

    const prices: TokenPrices = {};
    for (const ticker of data) {
      const walletSymbol = pairToSymbol[ticker.symbol];
      if (!walletSymbol) continue;

      const price = parseFloat(ticker.lastPrice);
      const change24h = parseFloat(ticker.priceChangePercent);

      if (!isNaN(price) && !isNaN(change24h)) {
        prices[walletSymbol] = { price, change24h };
      }
    }

    return prices;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      const { code, msg } = error.response.data;
      console.warn(`[Binance] API error (code: ${code}): ${msg}`);
    } else {
      console.warn('[Binance] Failed to fetch prices:', error);
    }
    return {};
  }
}

/**
 * Get price info for a token symbol, defaulting to $1 / 0% if not found.
 */
export function getTokenPrice(prices: TokenPrices, symbol: string): TokenPriceInfo {
  return prices[symbol] ?? DEFAULT_PRICE;
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

  let interval: string;
  if (daysElapsed <= 90) {
    interval = '6h';
  } else if (daysElapsed <= 180) {
    interval = '12h';
  } else {
    interval = '1d';
  }

  const limit = Math.min(daysElapsed, 1000);
  return { interval, limit, startTime };
}

/**
 * Fetch kline (candlestick) data from Binance for charting.
 * Returns close prices as KlinePoint[]. Empty array if symbol is unknown or on error.
 */
export async function fetchKlineData(walletSymbol: string, timeframe: Timeframe): Promise<KlinePoint[]> {
  const binancePair = KNOWN_SYMBOLS[walletSymbol];
  if (!binancePair) return [];

  try {
    const params: Record<string, string | number> = { symbol: binancePair };

    if (timeframe === 'YTD') {
      const ytd = getYtdConfig();
      params.interval = ytd.interval;
      params.limit = ytd.limit;
      params.startTime = ytd.startTime;
    } else {
      const config = TIMEFRAME_CONFIGS[timeframe];
      params.interval = config.interval;
      params.limit = config.limit;
    }

    const { data } = await axios.get<(string | number)[][]>(`${BINANCE_API_BASE}/uiKlines`, { params });

    return data.map(kline => ({
      time: kline[0] as number,
      value: parseFloat(kline[4] as string)
    }));
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      const { code, msg } = error.response.data;
      console.warn(`[Binance] Kline API error (code: ${code}): ${msg}`);
    } else {
      console.warn('[Binance] Failed to fetch kline data:', error);
    }
    return [];
  }
}
