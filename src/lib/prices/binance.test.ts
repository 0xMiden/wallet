import axios, { AxiosError } from 'axios';

import type { Timeframe } from './binance';
import { hasUnquotedDefaultPrice } from './unquoted-default';

jest.mock('axios');
jest.mock('./unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));

let http = jest.mocked(axios);
let nominal = jest.mocked(hasUnquotedDefaultPrice);
let engine: typeof import('./binance');
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

beforeEach(async () => {
  jest.resetModules();
  http = jest.mocked((await import('axios')).default);
  nominal = jest.mocked((await import('./unquoted-default')).hasUnquotedDefaultPrice);
  engine = await import('./binance');
  http.get.mockReset();
  http.isAxiosError.mockImplementation(error => error instanceof AxiosError);
  nominal.mockReturnValue(false);
});

it('fetches only both USD denominators when no assets are requested', async () => {
  http.get.mockResolvedValueOnce({ data: [ticker('USDTUSD', '0.99'), ticker('USDCUSD', '1.01')] });
  expect(await engine.fetchTokenPrices()).toEqual({
    USDT: { price: 0.99, change24h: 0, percentageChange24h: 0 },
    USDC: { price: 1.01, change24h: 0, percentageChange24h: 0 }
  });
  expect(http.get).toHaveBeenCalledWith(
    expect.stringContaining('/ticker/24hr'),
    expect.objectContaining({ params: { symbols: '["USDTUSD","USDCUSD"]', type: 'FULL' } })
  );
});

it('uses USDT first, converts current and prior prices, and caches market resolution', async () => {
  http.get
    .mockResolvedValueOnce({
      data: { symbols: [...market('AAA', 'USDC').data.symbols, ...market('AAA').data.symbols] }
    })
    .mockResolvedValue({
      data: [
        ticker('USDTUSD', '1.1', '0.1'),
        ticker('USDCUSD', '1'),
        ticker('AAAUSDT', '20', '10'),
        ticker('AAAUSDC', '30', '0')
      ]
    });
  const result = await engine.fetchTokenPrices(['AAA', 'AAA']);
  expect(result.AAA).toEqual({ price: 22, change24h: 12, percentageChange24h: 120 });
  await engine.fetchTokenPrices(['AAA']);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(1);
});

it('gives a BTC quote whose change24h is in USD and whose percentageChange24h is a percent', async () => {
  // Realistic 24hr ticker figures: BTC down $335.30 from $82,735.30, USDT at a flat $0.99958.
  http.get.mockResolvedValueOnce(market('BTC')).mockResolvedValueOnce({
    data: [ticker('USDTUSD', '0.99958'), ticker('USDCUSD', '1'), ticker('BTCUSDT', '82400.00', '-335.30')]
  });
  const btc = (await engine.fetchTokenPrices(['BTC'])).BTC;
  expect(btc?.price).toBeCloseTo(82365.392, 3);
  // The USD change, scaled by the USDT rate exactly as the price is.
  expect(btc?.change24h).toBeCloseTo(-335.159, 3);
  // -335.30 / 82735.30: a fraction of a percent, never the USD figure.
  expect(btc?.percentageChange24h).toBeCloseTo(-0.40527, 4);
});

it('falls back to USDC only when the USDT market is absent or inactive', async () => {
  http.get
    .mockResolvedValueOnce({
      data: {
        symbols: [...market('BBB', 'USDT', 'BREAK').data.symbols, ...market('BBB', 'USDC').data.symbols]
      }
    })
    .mockResolvedValueOnce({ data: [ticker('USDTUSD', '1'), ticker('USDCUSD', '0.9'), ticker('BBBUSDC', '10')] });
  expect((await engine.fetchTokenPrices(['BBB'])).BBB?.price).toBe(9);
});

it('uses bulk metadata to isolate absent markets and cache a final unpriced result', async () => {
  http.get.mockResolvedValueOnce(market('OTHER')).mockResolvedValue({ data: [ticker('USDTUSD', '1')] });
  await engine.fetchTokenPrices(['ABSENT']);
  expect(engine.isListedSymbol('ABSENT')).toBe(false);
  expect(engine.pricesLoaded({}, ['ABSENT'])).toBe(true);
  nominal.mockReturnValue(true);
  expect(engine.quotedPrice({}, 'ABSENT')).toBeUndefined();
  const fallbackQuote = { price: 0.9999, change24h: 0, percentageChange24h: 0 };
  expect(engine.quotedPrice({ ABSENT: fallbackQuote }, 'ABSENT')).toEqual(fallbackQuote);
  await engine.fetchTokenPrices(['ABSENT']);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(1);
  expect(http.get).toHaveBeenLastCalledWith(
    expect.stringContaining('/ticker/24hr'),
    expect.objectContaining({ params: { symbols: '["USDTUSD","USDCUSD"]', type: 'FULL' } })
  );
});

it('does not treat a request failure as absence and retries market lookup', async () => {
  http.get.mockRejectedValueOnce(new Error('rate limit')).mockResolvedValueOnce({ data: [] });
  await engine.fetchTokenPrices(['RETRY']);
  expect(engine.isListedSymbol('RETRY')).toBe(true);
  nominal.mockReturnValue(true);
  expect(engine.quotedPrice({}, 'RETRY')).toBeUndefined();
  http.get.mockResolvedValueOnce(market('RETRY')).mockResolvedValueOnce({ data: [] });
  await engine.fetchTokenPrices(['RETRY']);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(2);
});

it('does not price an asset when its denominator is missing or invalid', async () => {
  http.get.mockResolvedValueOnce(market('CCC')).mockResolvedValueOnce({ data: [ticker('CCCUSDT', '50')] });
  expect(await engine.fetchTokenPrices(['CCC'])).toEqual({});
  http.get.mockResolvedValueOnce({ data: [ticker('USDTUSD', 'NaN'), ticker('CCCUSDT', '50')] });
  expect(await engine.fetchTokenPrices(['CCC'])).toEqual({});
});

it('returns an empty map when the ticker request fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  http.get.mockRejectedValueOnce(new Error('offline'));
  expect(await engine.fetchTokenPrices()).toEqual({});
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
  expect(await engine.fetchKlineData(`CHART${frame}`, frame)).toEqual([
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
  expect(await engine.fetchKlineData('USDC', '1D')).toEqual([{ time: 1, value: 0.95 }]);
  expect(http.get).toHaveBeenCalledTimes(1);
});

it('returns no history when market resolution or chart loading fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  http.get.mockRejectedValueOnce(new Error('offline'));
  expect(await engine.fetchKlineData('CHARTERROR', '1D')).toEqual([]);
  warn.mockRestore();
});

it('keeps the fixed USDCX rate and waits for unresolved market assets', () => {
  expect(engine.quotedPrice({}, 'USDCX')?.price).toBe(1);
  expect(engine.pricesLoaded({}, ['USDCX'])).toBe(true);
  expect(engine.pricesLoaded({}, ['USDCX', 'PENDING'])).toBe(false);
});

it.each<[string, string, number]>([
  ['2026-01-15T12:00:00', '6h', 60],
  ['2026-05-01T12:00:00', '12h', 242],
  ['2026-08-01T12:00:00', '1d', 213]
])('covers the elapsed YTD range at %s', async (date, interval, limit) => {
  jest.useFakeTimers().setSystemTime(new Date(date));
  http.get.mockResolvedValueOnce({ data: [] });
  await engine.fetchKlineData('USDT', 'YTD');
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
  expect((await engine.fetchTokenPrices(['REMOVED'])).REMOVED?.price).toBe(10);
  http.get
    .mockRejectedValueOnce(invalidSymbol)
    .mockResolvedValueOnce(market('REMOVED', 'USDC'))
    .mockResolvedValueOnce({ data: ticker('USDTUSD', '1') })
    .mockResolvedValueOnce({ data: ticker('USDCUSD', '0.9') })
    .mockRejectedValueOnce(invalidSymbol)
    .mockResolvedValueOnce({ data: ticker('REMOVEDUSDC', '20') });
  expect((await engine.fetchTokenPrices(['REMOVED'])).REMOVED?.price).toBe(18);
});

it('does not return infinite converted prices', async () => {
  http.get.mockResolvedValueOnce(market('HUGE')).mockResolvedValueOnce({
    data: [ticker('USDTUSD', '1e200'), ticker('HUGEUSDT', '1e200')]
  });
  expect((await engine.fetchTokenPrices(['HUGE'])).HUGE).toBeUndefined();
});

it('uses a nominal quote only when no price asset was supplied and the switch is on', () => {
  expect(engine.quotedPrice({}, undefined)).toBeUndefined();
  nominal.mockReturnValue(true);
  const quote = engine.quotedPrice({}, undefined);
  expect(quote).toEqual({ price: 1, change24h: 0, percentageChange24h: 0 });
  expect(engine.isNominalQuote(quote)).toBe(true);
  expect(engine.isNominalQuote({ price: 1, change24h: 0, percentageChange24h: 0 })).toBe(false);
  expect(engine.isNominalQuote(undefined)).toBe(false);
  expect(engine.pricesLoaded({}, [undefined])).toBe(true);
});

it('values known balances only with a positive price and known scale', () => {
  const prices = { VALUED: { price: 2, change24h: 0, percentageChange24h: 0 } };
  expect(engine.listedPrice(prices, 'VALUED')).toBe(2);
  expect(engine.listedFiatValue(prices, 'VALUED', 3, true)).toBe(6);
  expect(engine.listedFiatValue(prices, 'VALUED', 3, false)).toBeUndefined();
  expect(engine.listedFiatValue(prices, 'VALUED', 0, true)).toBe(0);
  expect(engine.listedFiatValue(prices, 'NOQUOTE', 3, true)).toBeUndefined();
  expect(engine.listedPrice({ VALUED: { price: 0, change24h: 0, percentageChange24h: 0 } }, 'VALUED')).toBe(0);
  expect(engine.pricesLoaded(prices, ['VALUED'])).toBe(true);
  expect(engine.pricesLoaded({}, [])).toBe(false);
});

it('omits fiat values for negative or non-finite balances', () => {
  const prices = { VALUED: { price: 2, change24h: 0, percentageChange24h: 0 } };
  expect(engine.listedFiatValue(prices, 'VALUED', -1, true)).toBeUndefined();
  expect(engine.listedFiatValue(prices, 'VALUED', Number.NaN, true)).toBeUndefined();
  expect(engine.listedFiatValue(prices, 'VALUED', Number.POSITIVE_INFINITY, true)).toBeUndefined();
  expect(engine.listedFiatValue(prices, 'VALUED', Number.MAX_VALUE, true)).toBeUndefined();
});

it('waits for a requested asset while only the conversion quotes have arrived', () => {
  const dollar = { price: 1, change24h: 0, percentageChange24h: 0 };
  const conversion = { USDT: dollar, USDC: dollar };
  expect(engine.pricesLoaded(conversion, ['PENDING'])).toBe(false);
  expect(engine.pricesLoaded(conversion, ['USDC'])).toBe(true);
  expect(engine.pricesLoaded({ ...conversion, BTC: dollar }, ['PENDING'])).toBe(true);
  expect(engine.pricesLoaded(conversion, new Set(['USDCX']).values())).toBe(true);
});

it('shares one successful bulk metadata request across assets and concurrent callers', async () => {
  http.get
    .mockResolvedValueOnce({
      data: { symbols: [...market('FIRST').data.symbols, ...market('SECOND').data.symbols] }
    })
    .mockResolvedValue({
      data: [ticker('USDTUSD', '1'), ticker('FIRSTUSDT', '10'), ticker('SECONDUSDT', '20')]
    });
  const [first, second] = await Promise.all([engine.fetchTokenPrices(['FIRST']), engine.fetchTokenPrices(['SECOND'])]);
  expect(first.FIRST?.price).toBe(10);
  expect(second.SECOND?.price).toBe(20);
  expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(1);
  expect(http.get).toHaveBeenCalledWith(expect.stringContaining('/exchangeInfo'), {
    params: { showPermissionSets: false },
    timeout: 10_000
  });
});

it.each([{}, { symbols: [] }, { symbols: [{ symbol: 'BROKENUSDT' }] }])(
  'does not cache malformed metadata as an absent market',
  async metadata => {
    http.get.mockResolvedValueOnce({ data: metadata }).mockResolvedValueOnce({ data: [] });
    await engine.fetchTokenPrices(['BROKEN']);
    expect(engine.isListedSymbol('BROKEN')).toBe(true);
    expect(engine.pricesLoaded({}, ['BROKEN'])).toBe(false);
    http.get.mockResolvedValueOnce(market('BROKEN')).mockResolvedValueOnce({
      data: [ticker('USDTUSD', '1'), ticker('BROKENUSDT', '10')]
    });
    expect((await engine.fetchTokenPrices(['BROKEN'])).BROKEN?.price).toBe(10);
    expect(http.get.mock.calls.filter(call => call[0].includes('/exchangeInfo'))).toHaveLength(2);
  }
);

it('allows unrelated non-ASCII asset listings in bulk metadata', async () => {
  http.get
    .mockResolvedValueOnce({
      data: {
        symbols: [
          { symbol: '币安人生USDT', baseAsset: '币安人生', quoteAsset: 'USDT', status: 'TRADING' },
          ...market('SOL').data.symbols
        ]
      }
    })
    .mockResolvedValueOnce({ data: [ticker('USDTUSD', '1'), ticker('SOLUSDT', '150')] });
  expect((await engine.fetchTokenPrices(['SOL'])).SOL?.price).toBe(150);
});
