import axios from 'axios';

import type { Timeframe } from './binance';

jest.mock('axios');

let engine: typeof import('./kraken');
let http = jest.mocked(axios);
const now = Math.floor(new Date('2026-10-20T12:02:00Z').getTime() / 1000);
const referenceTime = Math.floor((now - 86400) / 300) * 300 - 300;

function candle(time: number, close: string): [number, string, string, string, string, string, string, number] {
  return [time, close, close, close, close, close, '1', 1];
}

function history(pair: string, close = '1') {
  return { data: { error: [], result: { [pair]: [candle(referenceTime, close)], last: now } } };
}

beforeEach(async () => {
  jest.resetModules();
  http = jest.mocked((await import('axios')).default);
  engine = await import('./kraken');
  http.get.mockReset();
  jest.useFakeTimers().setSystemTime(now * 1000);
});

afterEach(() => {
  jest.useRealTimers();
});

it('validates the active direct USD market for PYUSD', async () => {
  http.get.mockResolvedValueOnce({
    data: {
      error: [],
      result: { PYUSDUSD: { wsname: 'PYUSD/USD', quote: 'ZUSD', status: 'online' } }
    }
  });
  expect(await engine.findKrakenUsdMarket('PYUSD')).toBe('PYUSDUSD');
  expect(http.get).toHaveBeenCalledWith('https://api.kraken.com/0/public/AssetPairs', {
    params: {},
    timeout: 10_000
  });
});

it.each([
  { wsname: 'PYUSD/USD', quote: 'ZUSD', status: 'cancel_only' },
  { wsname: 'OTHER/USD', quote: 'ZUSD', status: 'online' },
  { wsname: 'PYUSD/EUR', quote: 'ZEUR', status: 'online' }
])('rejects metadata that is not an active matching USD market', async market => {
  http.get.mockResolvedValueOnce({ data: { error: [], result: { PYUSDUSD: market } } });
  expect(await engine.findKrakenUsdMarket('PYUSD')).toBeNull();
});

it('finds no market from successful bulk metadata without a missing-pair request', async () => {
  http.get.mockResolvedValueOnce({
    data: { error: [], result: { PYUSDUSD: { wsname: 'PYUSD/USD', quote: 'ZUSD', status: 'online' } } }
  });
  expect(await engine.findKrakenUsdMarket('MISSING')).toBeNull();
  expect(await engine.findKrakenUsdMarket('bad/input')).toBeNull();
  expect(http.get).toHaveBeenCalledTimes(1);
});

it('throws request and API failures instead of treating them as absent markets', async () => {
  http.get.mockRejectedValueOnce(new Error('offline'));
  await expect(engine.findKrakenUsdMarket('PYUSD')).rejects.toThrow('offline');
  http.get.mockResolvedValueOnce({ data: { error: ['EAPI:Rate limit exceeded'], result: {} } });
  await expect(engine.findKrakenUsdMarket('PYUSD')).rejects.toThrow('Rate limit exceeded');
});

it('uses a completed five-minute close for rolling 24-hour movement, not the ticker midnight open', async () => {
  http.get
    .mockResolvedValueOnce({ data: { error: [], result: { PYUSDUSD: { c: ['1.02'], o: '99' } } } })
    .mockResolvedValueOnce(history('PYUSDUSD'));
  const prices = await engine.fetchKrakenPrices(new Map([['PYUSD', 'PYUSDUSD']]));
  expect(prices.PYUSD?.price).toBe(1.02);
  expect(prices.PYUSD?.change24h).toBeCloseTo(0.02);
  expect(prices.PYUSD?.percentageChange24h).toBeCloseTo(2);
  expect(http.get).toHaveBeenLastCalledWith('https://api.kraken.com/0/public/OHLC', {
    params: { pair: 'PYUSDUSD', interval: 5, since: referenceTime },
    timeout: 10_000
  });
});

it('omits a quote when the rolling 24-hour reference is missing or stale', async () => {
  http.get.mockResolvedValueOnce({ data: { error: [], result: { PYUSDUSD: { c: ['1'] } } } }).mockResolvedValueOnce({
    data: {
      error: [],
      result: { PYUSDUSD: [candle(referenceTime - 300, '1'), candle(now, '1')], last: now }
    }
  });
  expect(await engine.fetchKrakenPrices(new Map([['PYUSD', 'PYUSDUSD']]))).toEqual({});
});

it('isolates a removed market from the other ticker and history results', async () => {
  http.get
    .mockResolvedValueOnce({ data: { error: ['EQuery:Unknown asset pair'], result: {} } })
    .mockResolvedValueOnce({ data: { error: ['EQuery:Unknown asset pair'], result: {} } })
    .mockResolvedValueOnce({ data: { error: [], result: { PYUSDUSD: { c: ['1.01'] } } } })
    .mockResolvedValueOnce(history('PYUSDUSD'));
  const prices = await engine.fetchKrakenPrices(
    new Map([
      ['MISSING', 'MISSINGUSD'],
      ['PYUSD', 'PYUSDUSD']
    ])
  );
  expect(prices.MISSING).toBeUndefined();
  expect(prices.PYUSD?.price).toBe(1.01);
});

it('does not return a quote when current price or reference is invalid', async () => {
  http.get.mockResolvedValueOnce({ data: { error: [], result: { PYUSDUSD: { c: ['Infinity'] } } } });
  expect(await engine.fetchKrakenPrices(new Map([['PYUSD', 'PYUSDUSD']]))).toEqual({});
  http.get
    .mockResolvedValueOnce({ data: { error: [], result: { PYUSDUSD: { c: ['1'] } } } })
    .mockResolvedValueOnce(history('PYUSDUSD', 'NaN'));
  expect(await engine.fetchKrakenPrices(new Map([['PYUSD', 'PYUSDUSD']]))).toEqual({});
});

it('returns partial prices when one history request fails', async () => {
  http.get
    .mockResolvedValueOnce({
      data: { error: [], result: { PYUSDUSD: { c: ['1.01'] }, OTHERUSD: { c: ['2'] } } }
    })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(history('OTHERUSD'));
  const prices = await engine.fetchKrakenPrices(
    new Map([
      ['PYUSD', 'PYUSDUSD'],
      ['OTHER', 'OTHERUSD']
    ])
  );
  expect(prices.PYUSD).toBeUndefined();
  expect(prices.OTHER?.price).toBe(2);
});

it('makes no request for an empty market map and does not repeat a failed ticker batch', async () => {
  expect(await engine.fetchKrakenPrices(new Map())).toEqual({});
  expect(http.get).not.toHaveBeenCalled();
  http.get.mockRejectedValueOnce(new Error('offline'));
  expect(await engine.fetchKrakenPrices(new Map([['PYUSD', 'PYUSDUSD']]))).toEqual({});
  expect(http.get).toHaveBeenCalledTimes(1);
});

it.each<[Timeframe, number, number]>([
  ['1H', 1, 3600],
  ['1D', 5, 86400],
  ['1W', 60, 7 * 86400],
  ['1M', 240, 30 * 86400]
])('uses the %s interval and filters points outside the requested range', async (frame, interval, seconds) => {
  http.get.mockResolvedValueOnce({
    data: {
      error: [],
      result: {
        PYUSDUSD: [candle(now - seconds - 1, '1'), candle(now - 60, '1.01'), candle(now + 1, '1')],
        last: now
      }
    }
  });
  expect(await engine.fetchKrakenKlineData('PYUSDUSD', frame)).toEqual([{ time: (now - 60) * 1000, value: 1.01 }]);
  expect(http.get).toHaveBeenLastCalledWith('https://api.kraken.com/0/public/OHLC', {
    params: { pair: 'PYUSDUSD', interval, since: now - seconds },
    timeout: 10_000
  });
});

it('uses daily OHLC points for YTD and accepts a canonical response pair', async () => {
  const start = Math.floor(new Date(2026, 0, 1).getTime() / 1000);
  http.get.mockResolvedValueOnce({
    data: { error: [], result: { CANONICAL: [candle(start, '1.01')], last: now } }
  });
  expect(await engine.fetchKrakenKlineData('ALIAS', 'YTD')).toEqual([{ time: start * 1000, value: 1.01 }]);
  expect(http.get).toHaveBeenLastCalledWith('https://api.kraken.com/0/public/OHLC', {
    params: { pair: 'ALIAS', interval: 1440, since: start },
    timeout: 10_000
  });
});

it('returns no chart points on a request failure', async () => {
  http.get.mockRejectedValueOnce(new Error('offline'));
  expect(await engine.fetchKrakenKlineData('PYUSDUSD', '1D')).toEqual([]);
});

it('shares bulk discovery across callers and accepts unrelated listings without a display name', async () => {
  http.get.mockResolvedValueOnce({
    data: {
      error: [],
      result: {
        PYUSDUSD: { wsname: 'PYUSD/USD', quote: 'ZUSD', status: 'online' },
        EXTRA: { quote: 'SPECIAL', status: 'online' }
      }
    }
  });
  expect(await Promise.all([engine.findKrakenUsdMarket('PYUSD'), engine.findKrakenUsdMarket('IETH')])).toEqual([
    'PYUSDUSD',
    null
  ]);
  expect(await engine.findKrakenUsdMarket('MISSING')).toBeNull();
  expect(http.get).toHaveBeenCalledTimes(1);
});

it.each([{}, null, { BROKEN: { wsname: 'PYUSD/USD' } }])(
  'does not cache malformed market metadata as absence',
  async result => {
    http.get.mockResolvedValueOnce({ data: { error: [], result } });
    await expect(engine.findKrakenUsdMarket('PYUSD')).rejects.toThrow('metadata is invalid');
    http.get.mockResolvedValueOnce({
      data: { error: [], result: { PYUSDUSD: { wsname: 'PYUSD/USD', quote: 'ZUSD', status: 'online' } } }
    });
    expect(await engine.findKrakenUsdMarket('PYUSD')).toBe('PYUSDUSD');
    expect(http.get).toHaveBeenCalledTimes(2);
  }
);
