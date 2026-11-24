import { fetchKlineSeries, fetchTokenPrices, isListedSymbol } from './binance';
import { asMarketQuotes, type PriceSource } from './source';

/**
 * Binance resolves a market inside its price and history requests, so there is nothing to look up here: it reports
 * only what those requests have already ruled out. An unresolved symbol counts as listed, which is what keeps the feed
 * from asking another exchange after a failed Binance request.
 */
export const binanceSource: PriceSource = {
  id: 'binance',
  kind: 'market',
  serves: () => true,
  resolve: async () => undefined,
  verdictOf: symbol => ({ state: isListedSymbol(symbol) ? 'listed' : 'unlisted' }),
  fetchQuotes: async symbols => asMarketQuotes(await fetchTokenPrices(symbols)),
  fetchHistory: (symbol, timeframe) => fetchKlineSeries(symbol, timeframe)
};
