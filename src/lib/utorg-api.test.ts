import axios from 'axios';

import {
  createOrder,
  convertFiatAmountToXtz,
  getExchangeRate,
  getCurrenciesInfo,
  getMinMaxExchangeValue,
  getAvailableFiatCurrencies
} from './utorg-api';

// `utorg-api` calls `axios.create(...)` at module-import time and then uses the
// returned instance's `.post`. An auto-mock can't help here because the create
// call happens before any `beforeEach` runs, so we give `create` a factory that
// returns a stable instance whose `post` is a shared jest.fn we can drive.
jest.mock('axios', () => {
  const post = jest.fn();
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => ({ post }))
    }
  };
});

// The factory's `create` always returns an object referencing the same `post`,
// so this is the exact jest.fn the module's `api` instance uses.
const mockPost = (axios as unknown as { create: () => { post: jest.Mock } }).create().post;

// A representative currency-settings payload covering both a FIAT and a CRYPTO
// entry, plus the XTZ entry `getMinMaxExchangeValue` looks up.
const CURRENCIES = [
  {
    currency: 'USD',
    symbol: '$',
    chain: '',
    display: 'US Dollar',
    caption: '',
    explorerTx: '',
    explorerAddr: '',
    type: 'FIAT',
    enabled: true,
    depositMin: 1,
    depositMax: 1000,
    withdrawalMin: 5,
    withdrawalMax: 500,
    addressValidator: '',
    precision: 2,
    allowTag: false
  },
  {
    currency: 'EUR',
    symbol: '€',
    chain: '',
    display: 'Euro',
    caption: '',
    explorerTx: '',
    explorerAddr: '',
    type: 'FIAT',
    enabled: true,
    depositMin: 1,
    depositMax: 900,
    withdrawalMin: 4,
    withdrawalMax: 450,
    addressValidator: '',
    precision: 2,
    allowTag: false
  },
  {
    currency: 'XTZ',
    symbol: 'ꜩ',
    chain: 'tezos',
    display: 'Tezos',
    caption: '',
    explorerTx: '',
    explorerAddr: '',
    type: 'CRYPTO',
    enabled: true,
    depositMin: 0.1,
    depositMax: 10000,
    withdrawalMin: 1.5,
    withdrawalMax: 7500,
    addressValidator: '',
    precision: 6,
    allowTag: false
  }
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('utorg-api', () => {
  describe('createOrder', () => {
    it('posts a FIAT_TO_CRYPTO order and returns the payment url', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: { url: 'https://pay.utorg.pro/abc' } } });

      const url = await createOrder(120, 'USD', 'tz1abc');

      expect(url).toBe('https://pay.utorg.pro/abc');
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(
        '/order/init',
        expect.objectContaining({
          type: 'FIAT_TO_CRYPTO',
          currency: 'XTZ',
          amount: 120,
          paymentCurrency: 'USD',
          address: 'tz1abc',
          externalId: expect.stringContaining('USD')
        })
      );
      // externalId is `<date>USD<amount>` — assert the amount tail too.
      const externalId = mockPost.mock.calls[0]![1].externalId;
      expect(externalId).toContain('120');
    });

    it('propagates rejections from the underlying request', async () => {
      mockPost.mockRejectedValueOnce(new Error('order failed'));
      await expect(createOrder(1, 'USD', 'tz1abc')).rejects.toThrow('order failed');
    });
  });

  describe('convertFiatAmountToXtz', () => {
    it('posts the conversion request and returns the numeric amount', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: 42.5 } });

      const result = await convertFiatAmountToXtz(100, 'USD');

      expect(result).toBe(42.5);
      expect(mockPost).toHaveBeenCalledWith('/tools/convert', {
        fromCurrency: 'USD',
        paymentAmount: 100,
        toCurrency: 'XTZ'
      });
    });
  });

  describe('getExchangeRate', () => {
    it('substitutes 1 when the payment amount is 0 and returns the per-unit rate', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: 3 } });

      const rate = await getExchangeRate(0, 'USD');

      // finalPaymentAmount === 1, res === 3 -> round(3/1 * 10000)/10000 === 3
      expect(rate).toBe(3);
      expect(mockPost).toHaveBeenCalledWith('/tools/convert', {
        fromCurrency: 'USD',
        paymentAmount: 1,
        toCurrency: 'XTZ'
      });
    });

    it('divides by the payment amount and rounds to 4 decimals for a non-zero amount', async () => {
      // res / finalPaymentAmount = 5 / 3 = 1.6666... -> rounded to 1.6667
      mockPost.mockResolvedValueOnce({ data: { data: 5 } });

      const rate = await getExchangeRate(3, 'EUR');

      expect(rate).toBe(1.6667);
      expect(mockPost).toHaveBeenCalledWith('/tools/convert', {
        fromCurrency: 'EUR',
        paymentAmount: 3,
        toCurrency: 'XTZ'
      });
    });
  });

  describe('getCurrenciesInfo', () => {
    it('posts to the settings endpoint and returns the currency array', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: CURRENCIES } });

      const result = await getCurrenciesInfo();

      expect(result).toEqual(CURRENCIES);
      expect(mockPost).toHaveBeenCalledWith('/settings/currency');
    });
  });

  describe('getMinMaxExchangeValue', () => {
    it('returns the withdrawal min/max of the XTZ entry', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: CURRENCIES } });

      const result = await getMinMaxExchangeValue();

      expect(result).toEqual({ minAmount: 1.5, maxAmount: 7500 });
    });
  });

  describe('getAvailableFiatCurrencies', () => {
    it('returns only the currencies whose type is FIAT', async () => {
      mockPost.mockResolvedValueOnce({ data: { data: CURRENCIES } });

      const result = await getAvailableFiatCurrencies();

      // USD and EUR are FIAT; XTZ is CRYPTO and must be filtered out.
      expect(result).toEqual(['USD', 'EUR']);
      expect(result).not.toContain('XTZ');
    });

    it('returns an empty array when no FIAT currencies are present', async () => {
      mockPost.mockResolvedValueOnce({
        data: { data: CURRENCIES.filter(c => c.type !== 'FIAT') }
      });

      const result = await getAvailableFiatCurrencies();

      expect(result).toEqual([]);
    });
  });
});

// The auth headers are wired into the axios instance at module-import time from
// `process.env.MIDEN_WALLET_UTORG_SID`, so exercising both branches requires
// re-importing the module in isolation with the env var toggled.
describe('utorg-api auth header configuration', () => {
  const ENV_KEY = 'MIDEN_WALLET_UTORG_SID';

  const importWithSid = (sid: string | undefined) => {
    const previous = process.env[ENV_KEY];
    if (sid === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = sid;
    }

    let capturedConfig: Record<string, unknown> = {};
    jest.resetModules();
    jest.doMock('axios', () => ({
      __esModule: true,
      default: {
        create: (config: Record<string, unknown>) => {
          capturedConfig = config;
          return { post: jest.fn() };
        }
      }
    }));

    jest.isolateModules(() => {
      require('./utorg-api');
    });

    jest.dontMock('axios');
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }

    return capturedConfig;
  };

  it('adds X-AUTH headers when a SID is configured', () => {
    const config = importWithSid('sid-123') as {
      baseURL: string;
      headers: Record<string, string>;
    };

    expect(config.baseURL).toBe('https://app.utorg.pro/api/merchant/v1');
    expect(config.headers).toEqual({
      'Content-Type': 'application/json',
      'X-AUTH-SID': 'sid-123',
      'X-AUTH-NONCE': expect.any(String)
    });
  });

  it('omits the headers entirely when no SID is configured', () => {
    const config = importWithSid(undefined) as {
      baseURL: string;
      headers?: unknown;
    };

    expect(config).toEqual({ baseURL: 'https://app.utorg.pro/api/merchant/v1' });
    expect(config.headers).toBeUndefined();
  });
});
