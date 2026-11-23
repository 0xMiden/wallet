import { fetchKrakenKlineData, fetchKrakenPrices, findKrakenUsdMarket, krakenCandleMs } from './kraken';
import { asMarketQuotes, type MarketVerdict, type PriceSource } from './source';

const markets = new Map<string, string | null>();
const pendingMarkets = new Map<string, Promise<string | null>>();

async function resolveMarket(symbol: string): Promise<string | null> {
  if (markets.has(symbol)) return markets.get(symbol) ?? null;
  const pending = pendingMarkets.get(symbol);
  if (pending) return pending;
  const request = findKrakenUsdMarket(symbol).then(pair => {
    markets.set(symbol, pair);
    return pair;
  });
  pendingMarkets.set(symbol, request);
  try {
    return await request;
  } finally {
    pendingMarkets.delete(symbol);
  }
}

export const krakenSource: PriceSource = {
  id: 'kraken',
  kind: 'market',
  serves: symbol => /^[A-Z0-9]{1,30}$/.test(symbol),

  async resolve(symbols) {
    const queue = [...symbols];
    const resolveNext = async (): Promise<void> => {
      for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
        try {
          await resolveMarket(symbol);
        } catch {
          // Retry failed market checks on the next price refresh.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, resolveNext));
  },

  verdictOf(symbol): MarketVerdict | undefined {
    const pair = markets.get(symbol);
    return pair === undefined ? undefined : { state: pair === null ? 'unlisted' : 'listed' };
  },

  async fetchQuotes(symbols) {
    const pairs = new Map<string, string>();
    for (const symbol of symbols) {
      const pair = markets.get(symbol);
      if (pair) pairs.set(symbol, pair);
    }
    if (pairs.size === 0) return {};
    try {
      return asMarketQuotes(await fetchKrakenPrices(pairs));
    } catch {
      return {};
    }
  },

  async fetchHistory(symbol, timeframe) {
    const stepMs = krakenCandleMs(timeframe);
    try {
      const pair = await resolveMarket(symbol);
      return { points: pair ? await fetchKrakenKlineData(pair, timeframe) : [], stepMs };
    } catch {
      return { points: [], stepMs };
    }
  }
};
