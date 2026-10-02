import axios from 'axios';

import { KNOWN_SYMBOLS } from './constant';
import { hasUnquotedDefaultPrice } from './unquoted-default';

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';

export interface TokenPriceInfo {
  price: number;
  change24h: number;
  percentageChange24h: number;
}

export type TokenPrices = Record<string, TokenPriceInfo>;

interface BinanceTicker24hr {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
}

/**
 * Fetch token prices and 24hr change from Binance API for the symbols in `KNOWN_SYMBOLS`.
 * Returns a map of wallet symbol -> { price, change24h }; a symbol missing from it has no price.
 * On any error, returns an empty object.
 */
export async function fetchTokenPrices(): Promise<TokenPrices> {
  const entries = Object.entries(KNOWN_SYMBOLS);
  /* c8 ignore next -- KNOWN_SYMBOLS is a compile-time constant, never empty */
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
      const change24h = parseFloat(ticker.priceChange);
      const percentageChange24h = parseFloat(ticker.priceChangePercent);

      if (!isNaN(price) && !isNaN(change24h) && !isNaN(percentageChange24h)) {
        prices[walletSymbol] = { price, change24h, percentageChange24h };
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
 * Whether a figure can be shown yet. An empty map is prices still loading, which a figure shows
 * as its placeholder, and a loaded map without a symbol is a token with no price. With the
 * nominal rate on (`hasUnquotedDefaultPrice`) every token has a price from the start (the feed's,
 * or the nominal rate), so a figure never waits on the feed: a test-network wallet that holds
 * only the native token would otherwise show its placeholder for as long as the feed is
 * unreachable.
 */
export function pricesLoaded(prices: TokenPrices): boolean {
  return hasUnquotedDefaultPrice() || Object.keys(prices).length > 0;
}

/**
 * The quote of a token the feed does not list where `hasUnquotedDefaultPrice` says so (the
 * Developer Settings switch, off mainnet): $1 per whole unit, with no movement.
 */
const TEST_NETWORK_UNQUOTED_PRICE: TokenPriceInfo = { price: 1, change24h: 0, percentageChange24h: 0 };

/**
 * The feed's quote for a price symbol, or none: an unquoted token has no fiat value, and a zero
 * price is not a quote, unless the nominal rate is on (`hasUnquotedDefaultPrice`), when an
 * unquoted token (a symbol the feed does not list, or no price symbol at all) is quoted at $1.
 * A held token is priced
 * through `tokenQuote` (lib/miden/swap/tokens), which resolves its price symbol first (IETH at
 * ETH); call this directly only with a symbol already resolved, as the sparkline and chart do.
 */
export function quotedPrice(prices: TokenPrices, symbol: string | undefined): TokenPriceInfo | undefined {
  const quote = symbol === undefined ? undefined : prices[symbol];
  if (quote && quote.price > 0) return quote;
  return hasUnquotedDefaultPrice() ? TEST_NETWORK_UNQUOTED_PRICE : undefined;
}

/**
 * The price `quotedPrice` gives a symbol, or 0 for none, which the token pickers
 * (`listedFiatValue`) read as no price. An unquoted token, as `quotedPrice` defines it, gets 0 and
 * so shows no fiat there, unless the nominal rate is on (`hasUnquotedDefaultPrice`), when it is
 * priced at $1 like every other fiat figure.
 */
export function listedPrice(prices: TokenPrices, symbol: string | undefined): number {
  return quotedPrice(prices, symbol)?.price ?? 0;
}

/**
 * The fiat value for a token picker's row, or none: only when the symbol has a price
 * (`listedPrice`), the balance's scale is known and there is a balance to value. An unquoted
 * token, as `quotedPrice` defines it (an absent symbol included), gets no figure rather than one
 * equal to its token count, unless the nominal rate is on (`hasUnquotedDefaultPrice`), when it is
 * valued at $1 like every other fiat figure. A number, so the row can count it (`AnimatedNumber`)
 * with a formatter bound to it.
 */
export function listedFiatValue(
  prices: TokenPrices,
  symbol: string | undefined,
  balance: number,
  scaleIsKnown: boolean
): number | undefined {
  const price = listedPrice(prices, symbol);
  if (!scaleIsKnown || !(price > 0) || !(balance > 0)) return undefined;
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
