import axios from 'axios';

import { hasUnquotedDefaultPrice } from 'lib/prices/unquoted-default';

import {
  fetchKlineData,
  fetchTokenPrices,
  isNominalQuote,
  listedFiatValue,
  listedPrice,
  pricesLoaded,
  quotedPrice,
  Timeframe
} from './binance';

jest.mock('axios');
// The quote rules under test are the default ones, no figure without a quote; pinned here against
// Developer Settings' nominal $1 switch (lib/prices/unquoted-default). The nominal cases flip it.
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));
const mockedHasUnquotedDefaultPrice = jest.mocked(hasUnquotedDefaultPrice);

const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  jest.clearAllMocks();
  // axios.isAxiosError is called in error branches — default it to a simple
  // predicate that matches objects with a `response` field.
  (mockedAxios as any).isAxiosError = (e: any): e is any => !!e && !!e.response;
});

describe('binance', () => {
  describe('fetchTokenPrices', () => {
    it('returns a map keyed by wallet symbol on success', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [
          { symbol: 'ETHUSD', lastPrice: '3000.5', priceChange: '10.5', priceChangePercent: '0.35' },
          { symbol: 'BTCUSD', lastPrice: '65000', priceChange: '-250', priceChangePercent: '-0.38' },
          { symbol: 'USDCUSD', lastPrice: '1.0001', priceChange: '0.0001', priceChangePercent: '0.01' }
        ]
      } as any);

      const result = await fetchTokenPrices();
      expect(result).toEqual({
        ETH: { price: 3000.5, change24h: 10.5, percentageChange24h: 0.35 },
        BTC: { price: 65000, change24h: -250, percentageChange24h: -0.38 },
        USDC: { price: 1.0001, change24h: 0.0001, percentageChange24h: 0.01 }
      });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/v3/ticker/24hr'),
        expect.objectContaining({
          params: expect.objectContaining({ type: 'FULL' })
        })
      );
    });

    it('skips tickers whose price parses to NaN', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [
          { symbol: 'ETHUSD', lastPrice: 'not-a-number', priceChange: '0', priceChangePercent: '0' },
          { symbol: 'BTCUSD', lastPrice: '50000', priceChange: '0', priceChangePercent: '0' }
        ]
      } as any);

      const result = await fetchTokenPrices();
      expect(result).toEqual({
        BTC: { price: 50000, change24h: 0, percentageChange24h: 0 }
      });
    });

    it('ignores tickers that do not map to a known wallet symbol', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [
          { symbol: 'DOGEUSD', lastPrice: '0.1', priceChange: '0', priceChangePercent: '0' },
          { symbol: 'ETHUSD', lastPrice: '3000', priceChange: '0', priceChangePercent: '0' }
        ]
      } as any);
      const result = await fetchTokenPrices();
      expect(result).toEqual({
        ETH: { price: 3000, change24h: 0, percentageChange24h: 0 }
      });
    });

    it('returns {} and logs a Binance API error when response has code/msg', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockedAxios.get.mockRejectedValueOnce({
        response: { data: { code: -1121, msg: 'Invalid symbol' } }
      });
      const result = await fetchTokenPrices();
      expect(result).toEqual({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('-1121'));
      warn.mockRestore();
    });

    it('returns {} and logs a generic error when axios throws without response data', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockedAxios.get.mockRejectedValueOnce(new Error('network down'));
      const result = await fetchTokenPrices();
      expect(result).toEqual({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'), expect.any(Error));
      warn.mockRestore();
    });
  });

  describe('fetchKlineData', () => {
    it('returns [] immediately for an unknown wallet symbol', async () => {
      const result = await fetchKlineData('NOPE', '1H');
      expect(result).toEqual([]);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it.each<[Timeframe, string, number]>([
      ['1H', '1m', 60],
      ['1D', '5m', 288],
      ['1W', '1h', 168],
      ['1M', '6h', 120]
    ])('uses the correct params for %s timeframe', async (timeframe, interval, limit) => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [[1700000000000, '0', '0', '0', '3000.5', '0']]
      } as any);
      const result = await fetchKlineData('ETH', timeframe);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/v3/uiKlines'),
        expect.objectContaining({
          params: expect.objectContaining({ symbol: 'ETHUSD', interval, limit })
        })
      );
      expect(result).toEqual([{ time: 1700000000000, value: 3000.5 }]);
    });

    it('passes YTD params with a startTime field', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: [] } as any);
      await fetchKlineData('BTC', 'YTD');
      const call = mockedAxios.get.mock.calls[0];
      expect(call![0]).toContain('/api/v3/uiKlines');
      const params = (call![1] as any).params;
      expect(params.symbol).toBe('BTCUSD');
      expect(params.interval).toMatch(/^(6h|12h|1d)$/);
      expect(typeof params.startTime).toBe('number');
      expect(typeof params.limit).toBe('number');
    });

    it('returns [] and logs an error on Binance API failure', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockedAxios.get.mockRejectedValueOnce({
        response: { data: { code: -1120, msg: 'Invalid interval' } }
      });
      const result = await fetchKlineData('ETH', '1H');
      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('-1120'));
      warn.mockRestore();
    });

    it('uses 6h interval for YTD when less than 90 days have elapsed', async () => {
      const realDate = global.Date;
      // January 15 = 15 days elapsed
      const fakeNow = new realDate(2026, 0, 15).getTime();
      jest.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
        if (args.length === 0) return new realDate(fakeNow);
        return new (realDate as any)(...args);
      });
      (global.Date as any).now = () => fakeNow;
      (global.Date as any).UTC = realDate.UTC;

      mockedAxios.get.mockResolvedValueOnce({ data: [] } as any);
      await fetchKlineData('BTC', 'YTD');
      const params = (mockedAxios.get.mock.calls[0]![1] as any).params;
      expect(params.interval).toBe('6h');
      jest.restoreAllMocks();
    });

    it('uses 1d interval for YTD when more than 180 days have elapsed', async () => {
      const realDate = global.Date;
      // August 1 = ~213 days elapsed
      const fakeNow = new realDate(2026, 7, 1).getTime();
      jest.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
        if (args.length === 0) return new realDate(fakeNow);
        return new (realDate as any)(...args);
      });
      (global.Date as any).now = () => fakeNow;
      (global.Date as any).UTC = realDate.UTC;

      mockedAxios.get.mockResolvedValueOnce({ data: [] } as any);
      await fetchKlineData('BTC', 'YTD');
      const params = (mockedAxios.get.mock.calls[0]![1] as any).params;
      expect(params.interval).toBe('1d');
      jest.restoreAllMocks();
    });

    it('returns [] and logs a generic error on non-axios failure', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockedAxios.get.mockRejectedValueOnce(new Error('oops'));
      const result = await fetchKlineData('ETH', '1H');
      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch kline'), expect.any(Error));
      warn.mockRestore();
    });
  });
});

afterEach(() => {
  mockedHasUnquotedDefaultPrice.mockReturnValue(false);
});

describe('pricesLoaded', () => {
  it('is false before the feed has delivered any quote', () => {
    expect(pricesLoaded({}, [])).toBe(false);
    expect(pricesLoaded({}, ['IMIDEN'])).toBe(false);
  });

  it('is true once any quote exists, whether or not a given symbol is among them', () => {
    expect(pricesLoaded({ BTC: { price: 60000, change24h: 0, percentageChange24h: 0 } }, ['ETH'])).toBe(true);
  });

  it('is true off mainnet before the feed has delivered when no symbol is one the feed lists', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(pricesLoaded({}, [undefined, 'IMIDEN'])).toBe(true);
    expect(pricesLoaded({}, [])).toBe(true);
  });

  // A listed symbol takes no nominal rate, so its figure still waits on the feed.
  it('is false off mainnet before the feed has delivered when any symbol is one the feed lists', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(pricesLoaded({}, ['ETH'])).toBe(false);
    expect(pricesLoaded({}, ['IMIDEN', 'BTC'])).toBe(false);
  });
});

describe('quotedPrice', () => {
  const eth = { price: 3000, change24h: 10, percentageChange24h: 0.1 };

  it('returns the feed quote of a listed symbol', () => {
    expect(quotedPrice({ ETH: eth }, 'ETH')).toEqual({ price: 3000, change24h: 10, percentageChange24h: 0.1 });
  });

  it('returns no quote for a symbol the feed does not list, never a $1 default', () => {
    expect(quotedPrice({ ETH: eth }, 'MIDEN')).toBeUndefined();
  });

  it('returns no quote for a zero price', () => {
    expect(quotedPrice({ ETH: { price: 0, change24h: 0, percentageChange24h: 0 } }, 'ETH')).toBeUndefined();
  });

  it('quotes a symbol the feed does not list, or no symbol, at $1 with no movement off mainnet', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    const nominal = { price: 1, change24h: 0, percentageChange24h: 0 };
    expect(quotedPrice({ ETH: eth }, 'MIDEN')).toEqual(nominal);
    expect(quotedPrice({ ETH: eth }, undefined)).toEqual(nominal);
    expect(quotedPrice({}, 'IMIDEN')).toEqual(nominal);
    expect(quotedPrice({}, undefined)).toEqual(nominal);
    expect(quotedPrice({}, 'toString')).toEqual(nominal);
  });

  // A listed symbol's missing quote is the feed loading or unreachable, not a token with no market,
  // so $1 would misprice a real asset (a whole ETH at a dollar).
  it.each(['ETH', 'BTC', 'USDC'])('gives the listed %s no quote off mainnet while the feed has none', symbol => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(quotedPrice({}, symbol)).toBeUndefined();
  });

  it('gives a listed symbol no quote for a zero price off mainnet, never the $1 default', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(quotedPrice({ ETH: { price: 0, change24h: 0, percentageChange24h: 0 } }, 'ETH')).toBeUndefined();
  });

  it('keeps the feed quote of a listed symbol off mainnet, never the $1 default', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(quotedPrice({ ETH: eth }, 'ETH')).toEqual(eth);
  });
});

describe('isNominalQuote', () => {
  it('is true for the nominal quote of a symbol the feed does not list', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(isNominalQuote(quotedPrice({}, 'IMIDEN'))).toBe(true);
  });

  // A stablecoin trading at par has the nominal quote's shape and is still a real-dollar figure.
  it('is false for a feed quote, even one at $1 with no movement', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    const par = { price: 1, change24h: 0, percentageChange24h: 0 };
    expect(isNominalQuote(quotedPrice({ USDC: par }, 'USDC'))).toBe(false);
    expect(isNominalQuote(par)).toBe(false);
  });

  it('is false for no quote', () => {
    expect(isNominalQuote(undefined)).toBe(false);
  });
});

describe('listedPrice', () => {
  const prices = { ETH: { price: 2, change24h: 0, percentageChange24h: 0 } };

  it('returns the feed price of a listed symbol', () => {
    expect(listedPrice(prices, 'ETH')).toBe(2);
  });

  it('returns 0 for a symbol the feed does not list, never the $1 default', () => {
    expect(listedPrice(prices, 'IMIDEN')).toBe(0);
  });

  it('returns 0 for a quote that is not a price, as quotedPrice does', () => {
    expect(listedPrice({ ETH: { price: -1, change24h: 0, percentageChange24h: 0 } }, 'ETH')).toBe(0);
  });

  it('returns the nominal $1 for a symbol the feed does not list with the nominal rate on, as quotedPrice does', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(listedPrice(prices, 'IMIDEN')).toBe(1);
  });
});

describe('listedFiatValue', () => {
  const prices = { ETH: { price: 2, change24h: 0, percentageChange24h: 0 } };

  it('values a listed symbol at its feed price', () => {
    expect(listedFiatValue(prices, 'ETH', 1.25, true)).toBe(2.5);
  });

  it('gives no figure for a symbol the feed does not list, never the $1 default', () => {
    expect(listedFiatValue(prices, 'IMIDEN', 3, true)).toBeUndefined();
  });

  it('gives no figure when the scale is unknown', () => {
    expect(listedFiatValue(prices, 'ETH', 1.25, false)).toBeUndefined();
  });

  it('gives no figure for a zero balance, never a zero figure', () => {
    expect(listedFiatValue(prices, 'ETH', 0, true)).toBeUndefined();
  });

  it('values a symbol the feed does not list at the nominal $1 with the nominal rate on', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    expect(listedFiatValue(prices, 'IMIDEN', 3, true)).toBe(3);
  });
});
