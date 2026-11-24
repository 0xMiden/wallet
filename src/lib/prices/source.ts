import type { KlineSeries, MarketQuote, Timeframe, TokenPrices } from './binance';

/**
 * What produced a quote. Only `market` is an exchange price: it alone has a 24h move and a chart, and it alone may
 * value a spend. `fixed` is a constant (USDCX at $1), `nominal` the test-network display rate, and `basket` a net
 * asset value read from a vault, whose move and chart come from its constituents.
 */
export type PriceKind = 'market' | 'fixed' | 'nominal' | 'basket';

/**
 * A source's answer about one symbol. Only `unlisted` rules a market out: `listed` also covers a symbol the source has
 * not been able to rule out yet, and a failed lookup stays unresolved (no verdict at all), never `unlisted`.
 */
export type MarketVerdict = { state: 'listed' } | { state: 'unlisted' };

/** One feed of USD quotes. `feed.ts` holds the ordered list and is the only caller. */
export interface PriceSource {
  readonly id: string;
  readonly kind: PriceKind;

  /** False for a symbol that can never be asked of this source, whatever its verdict. */
  serves(symbol: string): boolean;

  /** Find which of the symbols this source lists and cache it. A failed lookup leaves that symbol unresolved. */
  resolve(symbols: readonly string[]): Promise<void>;

  /** The cached verdict, without a request. Undefined means no lookup has completed for the symbol. */
  verdictOf(symbol: string): MarketVerdict | undefined;

  /** Quotes for the symbols the source can price; a symbol it cannot price, or has ruled out, is left out. */
  fetchQuotes(symbols: readonly string[]): Promise<TokenPrices>;

  /** Close prices for the chart and the candle length, which an empty series still carries. */
  fetchHistory(symbol: string, timeframe: Timeframe): Promise<KlineSeries>;
}

/** The quotes a market fetcher returns, tagged as the market quotes they are. */
export function asMarketQuotes(quotes: Record<string, MarketQuote>): TokenPrices {
  return Object.fromEntries(Object.entries(quotes).map(([symbol, quote]) => [symbol, { ...quote, kind: 'market' }]));
}
