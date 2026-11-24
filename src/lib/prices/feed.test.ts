import * as binance from './binance';
import { fetchKlineData, fetchKlineSeries, fetchTokenPrices, hasNoUsdMarket, usdMarketPending } from './feed';
import * as kraken from './kraken';

jest.mock('./binance');
jest.mock('./kraken');

const primary = jest.mocked(binance);
const fallback = jest.mocked(kraken);
const mockPriceNow = 1800000000000;
jest.spyOn(Date, 'now').mockReturnValue(mockPriceNow);
const dollars = { observedAt: mockPriceNow, price: 1, change24h: 0, percentageChange24h: 0, kind: 'market' as const };

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(mockPriceNow);
  primary.fetchTokenPrices.mockResolvedValue({ USDT: dollars, USDC: dollars });
  primary.fetchKlineSeries.mockResolvedValue({ points: [], stepMs: NaN });
  primary.isListedSymbol.mockReturnValue(true);
  fallback.findKrakenUsdMarket.mockResolvedValue(null);
  fallback.fetchKrakenPrices.mockResolvedValue({});
  fallback.fetchKrakenKlineData.mockResolvedValue([]);
});

it('keeps Binance bulk requests and does not query Kraken for supported assets', async () => {
  primary.fetchTokenPrices.mockResolvedValueOnce({ SOL: dollars });
  expect(await fetchTokenPrices(['SOL'])).toEqual({ SOL: dollars });
  expect(primary.fetchTokenPrices).toHaveBeenCalledWith(['SOL']);
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
  expect(fallback.fetchKrakenPrices).not.toHaveBeenCalled();
});

it('batches Kraken USD markets after Binance confirms they are absent', async () => {
  primary.isListedSymbol.mockImplementation(symbol => symbol === 'SOL');
  fallback.findKrakenUsdMarket.mockImplementation(async symbol => `${symbol}USD`);
  fallback.fetchKrakenPrices.mockResolvedValue({ PYUSD: dollars, FALLBACK: dollars });
  expect(await fetchTokenPrices(['PYUSD', 'FALLBACK', 'PYUSD', 'SOL'])).toEqual({
    USDT: dollars,
    USDC: dollars,
    PYUSD: dollars,
    FALLBACK: dollars
  });
  expect(fallback.findKrakenUsdMarket).toHaveBeenCalledTimes(2);
  expect(fallback.fetchKrakenPrices).toHaveBeenCalledWith(
    new Map([
      ['PYUSD', 'PYUSDUSD'],
      ['FALLBACK', 'FALLBACKUSD']
    ])
  );
  await fetchTokenPrices(['PYUSD']);
  expect(fallback.findKrakenUsdMarket).toHaveBeenCalledTimes(2);
});

it('does not use Kraken after a transient Binance failure', async () => {
  primary.fetchTokenPrices.mockResolvedValueOnce({});
  primary.isListedSymbol.mockReturnValue(true);
  expect(await fetchTokenPrices(['PRIMARYRETRY'])).toEqual({});
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
});

it('caches an unsupported market but retries a failed Kraken lookup', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
  await fetchTokenPrices(['ABSENT', 'RETRY']);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('RETRYUSD');
  fallback.fetchKrakenPrices.mockResolvedValueOnce({ RETRY: dollars });
  expect((await fetchTokenPrices(['ABSENT', 'RETRY'])).RETRY).toEqual(dollars);
  expect(fallback.findKrakenUsdMarket.mock.calls.map(([symbol]) => symbol)).toEqual(['ABSENT', 'RETRY', 'RETRY']);
});

it('keeps Binance quotes when Kraken fails', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('FAILUREUSD');
  fallback.fetchKrakenPrices.mockRejectedValueOnce(new Error('offline'));
  expect(await fetchTokenPrices(['FAILURE'])).toEqual({ USDT: dollars, USDC: dollars });
});

it('ignores invalid price symbols', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  await fetchTokenPrices(['', 'constructor', 'BAD/PAIR']);
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
});

it('uses Kraken direct USD history when Binance has no market', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('HISTORYUSD');
  fallback.fetchKrakenKlineData.mockResolvedValueOnce([{ time: 1, value: 0.9999 }]);
  expect(await fetchKlineData('HISTORY', '1D')).toEqual([{ time: 1, value: 0.9999 }]);
  expect(fallback.fetchKrakenKlineData).toHaveBeenCalledWith('HISTORYUSD', '1D');
});

it('gives the candle length of the provider that served the history', async () => {
  fallback.krakenCandleMs.mockReturnValue(14_400_000);
  primary.fetchKlineSeries.mockResolvedValueOnce({ points: [{ time: 1, value: 2 }], stepMs: 21_600_000 });
  expect(await fetchKlineSeries('SOL', '1M')).toEqual({ points: [{ time: 1, value: 2 }], stepMs: 21_600_000 });

  primary.isListedSymbol.mockReturnValue(false);
  fallback.findKrakenUsdMarket.mockResolvedValueOnce('HISTORYUSD');
  fallback.fetchKrakenKlineData.mockResolvedValueOnce([{ time: 3, value: 0.5 }]);
  expect(await fetchKlineSeries('HISTORY', '1M')).toEqual({ points: [{ time: 3, value: 0.5 }], stepMs: 14_400_000 });
  expect(fallback.krakenCandleMs).toHaveBeenCalledWith('1M');

  fallback.findKrakenUsdMarket.mockRejectedValueOnce(new Error('rate limit'));
  expect(await fetchKlineSeries('HISTORYRETRY', '1M')).toEqual({ points: [], stepMs: 14_400_000 });
});

it('keeps Binance history and does not mask a failed Binance history request with another provider', async () => {
  primary.fetchKlineSeries.mockResolvedValueOnce({ points: [{ time: 1, value: 2 }], stepMs: 60_000 });
  expect(await fetchKlineData('SOL', '1H')).toEqual([{ time: 1, value: 2 }]);
  expect(await fetchKlineData('SOL', '1H')).toEqual([]);
  expect(fallback.findKrakenUsdMarket).not.toHaveBeenCalled();
});

it('returns no history for an absent market or failed Kraken lookup', async () => {
  primary.isListedSymbol.mockReturnValue(false);
  expect(await fetchKlineData('NOHISTORY', '1D')).toEqual([]);
  fallback.findKrakenUsdMarket.mockRejectedValueOnce(new Error('rate limit'));
  expect(await fetchKlineData('HISTORYRETRY', '1D')).toEqual([]);
});

describe('hasNoUsdMarket', () => {
  it('is true only after Binance and Kraken both complete without a market', async () => {
    primary.isListedSymbol.mockImplementation(symbol => symbol !== 'NOMARKET');
    expect(hasNoUsdMarket('NOMARKET')).toBe(false);
    await fetchTokenPrices(['NOMARKET']);
    expect(hasNoUsdMarket('NOMARKET')).toBe(true);
  });

  it('is false while Binance has not proved the market absent', async () => {
    primary.isListedSymbol.mockReturnValue(true);
    await fetchTokenPrices(['BINANCERETRY']);
    expect(hasNoUsdMarket('BINANCERETRY')).toBe(false);
  });

  it('stays false after a failed Kraken lookup until a later lookup completes', async () => {
    primary.isListedSymbol.mockReturnValue(false);
    fallback.findKrakenUsdMarket.mockRejectedValueOnce(new Error('offline'));
    await fetchTokenPrices(['KRAKENRETRY']);
    expect(hasNoUsdMarket('KRAKENRETRY')).toBe(false);
    await fetchTokenPrices(['KRAKENRETRY']);
    expect(hasNoUsdMarket('KRAKENRETRY')).toBe(true);
  });
});

describe('usdMarketPending', () => {
  it('is true until Binance and Kraken have both ruled the market out', async () => {
    primary.isListedSymbol.mockReturnValue(true);
    expect(usdMarketPending('PENDINGBOTH')).toBe(true);
    primary.isListedSymbol.mockReturnValue(false);
    expect(usdMarketPending('PENDINGBOTH')).toBe(true);
    await fetchTokenPrices(['PENDINGBOTH']);
    expect(usdMarketPending('PENDINGBOTH')).toBe(false);
  });

  it('stays true while Kraken lists the market or its lookup failed', async () => {
    primary.isListedSymbol.mockReturnValue(false);
    fallback.findKrakenUsdMarket.mockResolvedValueOnce('KRAKENLISTEDUSD').mockRejectedValueOnce(new Error('offline'));
    await fetchTokenPrices(['KRAKENLISTED', 'KRAKENFAILED']);
    expect(usdMarketPending('KRAKENLISTED')).toBe(true);
    expect(usdMarketPending('KRAKENFAILED')).toBe(true);
  });

  it('waits on Binance alone for a symbol the feed never sends to Kraken, and on nothing without a symbol', () => {
    primary.isListedSymbol.mockReturnValue(true);
    expect(usdMarketPending('bad/pair')).toBe(true);
    primary.isListedSymbol.mockReturnValue(false);
    expect(usdMarketPending('bad/pair')).toBe(false);
    expect(usdMarketPending(undefined)).toBe(false);
  });
});

describe('feed output over a fixed symbol set', () => {
  const quote = (price: number) => ({ price, change24h: 0.1, percentageChange24h: 1, observedAt: 1 });
  const SYMBOLS = ['SOL', 'KPAIRA', 'KPAIRB', 'KABSENT', 'UNREACHABLE', 'bad/pair', 'SOL', 'USDT'];
  const BINANCE_LISTED = new Set(['SOL', 'UNREACHABLE', 'USDT']);
  const KRAKEN_PAIRS: Record<string, string | null> = { KPAIRA: 'KPAIRAUSD', KPAIRB: 'KPAIRBUSD', KABSENT: null };

  beforeEach(() => {
    primary.isListedSymbol.mockImplementation(symbol => symbol !== undefined && BINANCE_LISTED.has(symbol));
    primary.fetchTokenPrices.mockResolvedValue({ USDT: quote(1), USDC: quote(1), SOL: quote(150) });
    primary.fetchKlineSeries.mockImplementation(async symbol => ({
      points: [{ time: 1, value: symbol.length }],
      stepMs: 1
    }));
    fallback.findKrakenUsdMarket.mockImplementation(async symbol => KRAKEN_PAIRS[symbol] ?? null);
    fallback.fetchKrakenPrices.mockResolvedValue({ KPAIRA: quote(0.9998), KPAIRB: quote(2) });
    fallback.fetchKrakenKlineData.mockImplementation(async pair => [{ time: 2, value: pair.length }]);
    fallback.krakenCandleMs.mockReturnValue(14_400_000);
  });

  it('quotes each symbol from the first source that lists it, all stamped with one retrieval time', async () => {
    const prices = await fetchTokenPrices(SYMBOLS);
    const market = (price: number) => ({
      price,
      change24h: 0.1,
      percentageChange24h: 1,
      observedAt: mockPriceNow,
      kind: 'market'
    });
    expect(prices).toEqual({
      USDT: market(1),
      USDC: market(1),
      SOL: market(150),
      KPAIRA: market(0.9998),
      KPAIRB: market(2)
    });
    expect(Object.keys(prices)).toEqual(['USDT', 'USDC', 'SOL', 'KPAIRA', 'KPAIRB']);
    // Binance sees every symbol; Kraken only those Binance ruled out and the feed can send it, with a pair.
    expect(primary.fetchTokenPrices.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(SYMBOLS));
    expect(fallback.findKrakenUsdMarket.mock.calls.map(([symbol]) => symbol).sort()).toEqual([
      'KABSENT',
      'KPAIRA',
      'KPAIRB'
    ]);
    expect(fallback.fetchKrakenPrices).toHaveBeenCalledWith(
      new Map([
        ['KPAIRA', 'KPAIRAUSD'],
        ['KPAIRB', 'KPAIRBUSD']
      ])
    );
  });

  it('answers every verdict question the same way for each symbol', async () => {
    await fetchTokenPrices(SYMBOLS);
    const table = ['SOL', 'KPAIRA', 'KPAIRB', 'KABSENT', 'UNREACHABLE', 'bad/pair', 'NEVERASKED'].map(symbol => [
      symbol,
      hasNoUsdMarket(symbol),
      usdMarketPending(symbol)
    ]);
    expect(table).toEqual([
      ['SOL', false, true],
      ['KPAIRA', false, true],
      ['KPAIRB', false, true],
      ['KABSENT', true, false],
      ['UNREACHABLE', false, true],
      ['bad/pair', false, false],
      ['NEVERASKED', false, true]
    ]);
  });

  it('serves history from the first provider that has not ruled the symbol out', async () => {
    const history = await Promise.all(
      ['SOL', 'KPAIRA', 'KABSENT', 'bad/pair'].map(symbol => fetchKlineSeries(symbol, '1M'))
    );
    expect(history).toEqual([
      { points: [{ time: 1, value: 3 }], stepMs: 1 },
      { points: [{ time: 2, value: 9 }], stepMs: 14_400_000 },
      { points: [], stepMs: 14_400_000 },
      { points: [], stepMs: 14_400_000 }
    ]);
  });
});
