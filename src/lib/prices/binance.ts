import axios from 'axios';

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';

/**
 * Map of wallet token symbols to Binance trading pair symbols.
 * Only tokens listed here will have real price data fetched.
 * All other tokens default to $1 USD.
 */
export const KNOWN_SYMBOLS: Record<string, string> = {
  ETH: 'ETHUSD',
  BTC: 'BTCUSD',
  USDC: 'USDCUSD'
};

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
  console.log('Fetching token prices from Binance for symbols:', Object.keys(KNOWN_SYMBOLS));
  const entries = Object.entries(KNOWN_SYMBOLS);
  if (entries.length === 0) return {};

  const binanceSymbols = entries.map(([, pair]) => pair);
  console.log('Binance API request symbols:', binanceSymbols);
  try {
    console.log(`Making request to Binance API: ${BINANCE_API_BASE}/ticker/24hr with symbols:`, binanceSymbols);
    const { data } = await axios.get<BinanceTicker24hr[]>(`${BINANCE_API_BASE}/ticker/24hr`, {
      params: {
        symbols: JSON.stringify(binanceSymbols),
        type: 'FULL'
      }
    });
    console.log('Received price data from Binance:', data);

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
    console.warn('Error fetching prices from Binance:', error);
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
