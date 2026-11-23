import type { KlinePoint, KlineSeries, Timeframe, TokenPriceInfo, TokenPrices } from './binance';
import { binanceSource } from './binance-source';
import { krakenSource } from './kraken-source';
import type { PriceSource } from './source';

/**
 * The feed's sources in order of priority. A source is asked only about a symbol every earlier source has ruled out,
 * and an earlier quote wins over a later one. Adding an exchange is one file and one entry here.
 */
const SOURCES: readonly PriceSource[] = [binanceSource, krakenSource];

const MARKETS = SOURCES.filter(source => source.kind === 'market');

const ruledOut = (source: PriceSource, symbol: string): boolean => source.verdictOf(symbol)?.state === 'unlisted';

/** True only after every market source answered and none lists the asset; a failed lookup proves nothing. */
export function hasNoUsdMarket(symbol: string): boolean {
  return MARKETS.every(source => ruledOut(source, symbol));
}

/**
 * True while a USD quote for `symbol` may still come: until every market source that can be asked about it has ruled
 * its market out. A symbol the feed never sends to Kraken waits on Binance's verdict alone, and no symbol waits on
 * nothing.
 */
export function usdMarketPending(symbol: string | undefined): boolean {
  if (symbol === undefined) return false;
  return !MARKETS.filter(source => source.serves(symbol)).every(source => ruledOut(source, symbol));
}

/** Ask each source in turn, then stamp every quote with one retrieval time. */
export async function fetchTokenPrices(symbols: readonly string[] = []): Promise<TokenPrices> {
  const prices = new Map<string, TokenPriceInfo>();
  const open = [...new Set(symbols)];
  const asked: PriceSource[] = [];
  for (const source of SOURCES) {
    // PYUSD has a Kraken USD market but no Binance USDT or USDC market.
    // Use this fallback only when every earlier market is absent, not when a request fails.
    const candidates = open.filter(
      symbol => source.serves(symbol) && !prices.has(symbol) && asked.every(earlier => ruledOut(earlier, symbol))
    );
    await source.resolve(candidates);
    for (const [symbol, quote] of Object.entries(await source.fetchQuotes(candidates))) {
      if (!prices.has(symbol)) prices.set(symbol, quote);
    }
    asked.push(source);
  }
  const observedAt = Date.now();
  return Object.fromEntries([...prices].map(([symbol, quote]) => [symbol, { ...quote, observedAt }]));
}

/** Use the same provider selection for chart history and current prices, with the candle length of that provider. */
export async function fetchKlineSeries(symbol: string, timeframe: Timeframe): Promise<KlineSeries> {
  let series: KlineSeries = { points: [], stepMs: Number.NaN };
  for (const source of SOURCES) {
    series = await source.fetchHistory(symbol, timeframe);
    if (!ruledOut(source, symbol)) break;
  }
  return series;
}

/** Use the same provider selection for chart history and current prices. */
export async function fetchKlineData(symbol: string, timeframe: Timeframe): Promise<KlinePoint[]> {
  return (await fetchKlineSeries(symbol, timeframe)).points;
}
