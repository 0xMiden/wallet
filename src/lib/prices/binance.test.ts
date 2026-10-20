import axios, { AxiosError } from 'axios';

import {
  fetchKlineData,
  fetchTokenPrices,
  isListedSymbol,
  isNominalQuote,
  listedFiatValue,
  listedPrice,
  pricesLoaded,
  quotedPrice,
  Timeframe
} from './binance';
import { hasUnquotedDefaultPrice } from './unquoted-default';

jest.mock('axios');
jest.mock('./unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));

const http = jest.mocked(axios);
const nominal = jest.mocked(hasUnquotedDefaultPrice);
const invalidSymbol = new AxiosError<{ code: number }>('Invalid symbol');
invalidSymbol.response = {
  data: { code: -1121 },
  status: 400,
  statusText: 'Bad Request',
  headers: {},
  config: { headers: new axios.AxiosHeaders() }
};

function market(symbol: string, quote = 'USDT', status = 'TRADING') {
  return { data: { symbols: [{ symbol: `${symbol}${quote}`, baseAsset: symbol, quoteAsset: quote, status }] } };
}

function ticker(symbol: string, price: string, change = '0') {
  return { symbol, lastPrice: price, priceChange: change };
}

beforeEach(() => {
  jest.clearAllMocks();
  http.isAxiosError.mockImplementation(error => error instanceof AxiosError);
  nominal.mockReturnValue(false);
});

it('fetches only both USD denominators when no assets are requested', async () => {
  http.get.mockResolvedValueOnce({ data: [ticker('USDTUSD', '0.99'), ticker('USDCUSD', '1.01')] });
  expect(await fetchTokenPrices()).toEqual({
    USDT: { price: 0.99, change24h: 0, percentageChange24h: 0 },
    USDC: { price: 1.01, change24h: 0, percentageChange24h: 0 }
  });
  expect(http.get).toHaveBeenCalledWith(
    expect.stringContaining('/ticker/24hr'),
    expect.objectContaining({ params: { symbols: '["USDTUSD","USDCUSD"]', type: 'FULL' } })
  );
});

it('uses USDT first, converts current and prior prices, and caches market resolution', async () => {
  http.get.mockResolvedValueOnce(market('AAA')).mockResolvedValue({
    data: [ticker('USDTUSD', '1.1', '0.1'), ticker('USDCUSD', '1'), ticker('AAAUSDT', '20', '10')]
  });
  const result = await fetchTokenPrices(['AAA', 'AAA']);
  expect(result.AAA).toEqual({ price: 22, change24h: 12, percentageChange24h: 120 });
  await fetchTokenPrices(['AAA']);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(1);
});

it('falls back to USDC only when the USDT market is absent or inactive', async () => {
  http.get
    .mockResolvedValueOnce(market('BBB', 'USDT', 'BREAK'))
    .mockResolvedValueOnce(market('BBB', 'USDC'))
    .mockResolvedValueOnce({ data: [ticker('USDTUSD', '1'), ticker('USDCUSD', '0.9'), ticker('BBBUSDC', '10')] });
  expect((await fetchTokenPrices(['BBB'])).BBB?.price).toBe(9);
});

it('isolates absent markets from the ticker batch and caches a final unpriced result', async () => {
  http.get
    .mockRejectedValueOnce(invalidSymbol)
    .mockRejectedValueOnce(invalidSymbol)
    .mockResolvedValue({ data: [ticker('USDTUSD', '1')] });
  await fetchTokenPrices(['ABSENT']);
  expect(isListedSymbol('ABSENT')).toBe(false);
  expect(pricesLoaded({}, ['ABSENT'])).toBe(true);
  nominal.mockReturnValue(true);
  expect(quotedPrice({}, 'ABSENT')).toBeUndefined();
  await fetchTokenPrices(['ABSENT']);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(2);
  expect(http.get).toHaveBeenLastCalledWith(
    expect.stringContaining('/ticker/24hr'),
    expect.objectContaining({ params: { symbols: '["USDTUSD","USDCUSD"]', type: 'FULL' } })
  );
});

it('does not treat a request failure as absence and retries market lookup', async () => {
  http.get.mockRejectedValueOnce(new Error('rate limit')).mockResolvedValueOnce({ data: [] });
  await fetchTokenPrices(['RETRY']);
  expect(isListedSymbol('RETRY')).toBe(true);
  nominal.mockReturnValue(true);
  expect(quotedPrice({}, 'RETRY')).toBeUndefined();
  http.get.mockResolvedValueOnce(market('RETRY')).mockResolvedValueOnce({ data: [] });
  await fetchTokenPrices(['RETRY']);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(2);
});

it('does not price an asset when its denominator is missing or invalid', async () => {
  http.get.mockResolvedValueOnce(market('CCC')).mockResolvedValueOnce({ data: [ticker('CCCUSDT', '50')] });
  expect(await fetchTokenPrices(['CCC'])).toEqual({});
  http.get.mockResolvedValueOnce({ data: [ticker('USDTUSD', 'NaN'), ticker('CCCUSDT', '50')] });
  expect(await fetchTokenPrices(['CCC'])).toEqual({});
});

it('returns an empty map when the ticker request fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  http.get.mockRejectedValueOnce(new Error('offline'));
  expect(await fetchTokenPrices()).toEqual({});
  warn.mockRestore();
});

it.each<[Timeframe, string, number]>([
  ['1H', '1m', 60],
  ['1D', '5m', 288],
  ['1W', '1h', 168],
  ['1M', '6h', 120]
])('converts %s chart points with the rate at each matching time', async (frame, interval, limit) => {
  http.get
    .mockResolvedValueOnce(market(`CHART${frame}`))
    .mockResolvedValueOnce({
      data: [
        [1, 0, 0, 0, '10'],
        [2, 0, 0, 0, '20'],
        [3, 0, 0, 0, '99']
      ]
    })
    .mockResolvedValueOnce({
      data: [
        [1, 0, 0, 0, '0.9'],
        [2, 0, 0, 0, '1.1']
      ]
    });
  expect(await fetchKlineData(`CHART${frame}`, frame)).toEqual([
    { time: 1, value: 9 },
    { time: 2, value: 22 }
  ]);
  expect(http.get).toHaveBeenLastCalledWith(
    expect.stringContaining('/uiKlines'),
    expect.objectContaining({ params: { symbol: 'USDTUSD', interval, limit } })
  );
});

it('fetches stablecoin USD history directly', async () => {
  http.get.mockResolvedValueOnce({ data: [[1, 0, 0, 0, '0.95']] });
  expect(await fetchKlineData('USDC', '1D')).toEqual([{ time: 1, value: 0.95 }]);
  expect(http.get).toHaveBeenCalledTimes(1);
});

it('returns no history when market resolution or chart loading fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  http.get.mockRejectedValueOnce(new Error('offline'));
  expect(await fetchKlineData('CHARTERROR', '1D')).toEqual([]);
  warn.mockRestore();
});

it('keeps the fixed USDCX rate and waits for unresolved market assets', () => {
  expect(quotedPrice({}, 'USDCX')?.price).toBe(1);
  expect(pricesLoaded({}, ['USDCX'])).toBe(true);
  expect(pricesLoaded({}, ['USDCX', 'PENDING'])).toBe(false);
});

it.each<[string, string, number]>([
  ['2026-01-15T12:00:00', '6h', 60],
  ['2026-05-01T12:00:00', '12h', 242],
  ['2026-08-01T12:00:00', '1d', 213]
])('covers the elapsed YTD range at %s', async (date, interval, limit) => {
  jest.useFakeTimers().setSystemTime(new Date(date));
  http.get.mockResolvedValueOnce({ data: [] });
  await fetchKlineData('USDT', 'YTD');
  expect(http.get).toHaveBeenCalledWith(
    expect.stringContaining('/uiKlines'),
    expect.objectContaining({
      params: expect.objectContaining({ interval, limit, startTime: new Date(2026, 0, 1).getTime() })
    })
  );
  jest.useRealTimers();
});

it('recovers other prices and resolves a new market when a cached market is removed', async () => {
  http.get.mockResolvedValueOnce(market('REMOVED')).mockResolvedValueOnce({
    data: [ticker('USDTUSD', '1'), ticker('USDCUSD', '1'), ticker('REMOVEDUSDT', '10')]
  });
  expect((await fetchTokenPrices(['REMOVED'])).REMOVED?.price).toBe(10);
  http.get
    .mockRejectedValueOnce(invalidSymbol)
    .mockResolvedValueOnce({ data: ticker('USDTUSD', '1') })
    .mockResolvedValueOnce({ data: ticker('USDCUSD', '0.9') })
    .mockRejectedValueOnce(invalidSymbol)
    .mockRejectedValueOnce(invalidSymbol)
    .mockResolvedValueOnce(market('REMOVED', 'USDC'))
    .mockResolvedValueOnce({ data: ticker('REMOVEDUSDC', '20') });
  expect((await fetchTokenPrices(['REMOVED'])).REMOVED?.price).toBe(18);
});

it('does not return infinite converted prices', async () => {
  http.get.mockResolvedValueOnce(market('HUGE')).mockResolvedValueOnce({
    data: [ticker('USDTUSD', '1e200'), ticker('HUGEUSDT', '1e200')]
  });
  expect((await fetchTokenPrices(['HUGE'])).HUGE).toBeUndefined();
});

it('uses a nominal quote only when no price asset was supplied and the switch is on', () => {
  expect(quotedPrice({}, undefined)).toBeUndefined();
  nominal.mockReturnValue(true);
  const quote = quotedPrice({}, undefined);
  expect(quote).toEqual({ price: 1, change24h: 0, percentageChange24h: 0 });
  expect(isNominalQuote(quote)).toBe(true);
  expect(isNominalQuote({ price: 1, change24h: 0, percentageChange24h: 0 })).toBe(false);
  expect(isNominalQuote(undefined)).toBe(false);
  expect(pricesLoaded({}, [undefined])).toBe(true);
});

it('values known balances only with a positive price and known scale', () => {
  const prices = { VALUED: { price: 2, change24h: 0, percentageChange24h: 0 } };
  expect(listedPrice(prices, 'VALUED')).toBe(2);
  expect(listedFiatValue(prices, 'VALUED', 3, true)).toBe(6);
  expect(listedFiatValue(prices, 'VALUED', 3, false)).toBeUndefined();
  expect(listedFiatValue(prices, 'VALUED', 0, true)).toBeUndefined();
  expect(listedFiatValue(prices, 'NOQUOTE', 3, true)).toBeUndefined();
  expect(listedPrice({ VALUED: { price: 0, change24h: 0, percentageChange24h: 0 } }, 'VALUED')).toBe(0);
  expect(pricesLoaded(prices, ['VALUED'])).toBe(true);
  expect(pricesLoaded({}, [])).toBe(false);
});
