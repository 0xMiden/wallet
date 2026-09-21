import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { fetchTokenPrices } from './binance';
import { getPriceMicro, isCoveredSymbol, toPriceMicro, writeUsdPriceCache, __resetUsdPriceCacheForTests } from './usd';

jest.mock('./binance', () => ({ fetchTokenPrices: jest.fn() }));
jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn(), putToStorage: jest.fn() }));

const mockedFetch = jest.mocked(fetchTokenPrices);
const mockedRead = jest.mocked(fetchFromStorage);
const mockedWrite = jest.mocked(putToStorage);

beforeEach(() => {
  jest.clearAllMocks();
  __resetUsdPriceCacheForTests();
  mockedRead.mockResolvedValue(null);
  mockedWrite.mockResolvedValue(undefined);
  mockedFetch.mockResolvedValue({});
});

describe('coverage', () => {
  it('covers exactly the feed symbols', () => {
    expect(isCoveredSymbol('ETH')).toBe(true);
    expect(isCoveredSymbol('USDC')).toBe(true);
    expect(isCoveredSymbol('MIDEN')).toBe(false);
  });

  it('does not treat inherited object properties as covered', () => {
    expect(isCoveredSymbol('toString')).toBe(false);
    expect(isCoveredSymbol('constructor')).toBe(false);
  });

  it('covers the E2E fixture symbol only inside an E2E build', () => {
    expect(isCoveredSymbol('TST')).toBe(false);
    process.env.MIDEN_E2E_TEST = 'true';
    try {
      expect(isCoveredSymbol('TST')).toBe(true);
    } finally {
      delete process.env.MIDEN_E2E_TEST;
    }
  });
});

describe('toPriceMicro', () => {
  it('scales a price to micro-dollars', () => {
    expect(toPriceMicro(4321.55)).toBe(4_321_550_000n);
  });

  it('rejects a price that is not a usable number', () => {
    expect(toPriceMicro(0)).toBeUndefined();
    expect(toPriceMicro(-1)).toBeUndefined();
    expect(toPriceMicro(Number.NaN)).toBeUndefined();
    expect(toPriceMicro(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('getPriceMicro', () => {
  it('returns a fresh cached price without fetching', async () => {
    mockedRead.mockResolvedValue({ ETH: { priceMicro: '4000000000', fetchedAt: 1_000 } });

    await expect(getPriceMicro('ETH', 1_100)).resolves.toBe(4_000_000_000n);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('refetches when the cached entry is older than the freshness bound', async () => {
    mockedRead.mockResolvedValue({ ETH: { priceMicro: '4000000000', fetchedAt: 1_000 } });
    mockedFetch.mockResolvedValue({ ETH: { price: 4100, change24h: 0, percentageChange24h: 0 } });

    await expect(getPriceMicro('ETH', 1_000 + 601)).resolves.toBe(4_100_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable when the feed answers with nothing', async () => {
    mockedFetch.mockResolvedValue({});

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBeUndefined();
  });

  it('reports unavailable when the feed throws', async () => {
    mockedFetch.mockRejectedValue(new Error('offline'));

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBeUndefined();
  });

  it('shares one refresh across concurrent callers', async () => {
    mockedFetch.mockResolvedValue({
      ETH: { price: 4100, change24h: 0, percentageChange24h: 0 },
      BTC: { price: 90000, change24h: 0, percentageChange24h: 0 }
    });

    const [eth, btc] = await Promise.all([getPriceMicro('ETH', 1_000), getPriceMicro('BTC', 1_000)]);

    expect(eth).toBe(4_100_000_000n);
    expect(btc).toBe(90_000_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('persists a refreshed price for the other realm to read', async () => {
    mockedFetch.mockResolvedValue({ ETH: { price: 4100, change24h: 0, percentageChange24h: 0 } });

    await getPriceMicro('ETH', 1_000);

    expect(mockedWrite).toHaveBeenCalledWith('usd_price_cache', {
      ETH: { priceMicro: '4100000000', fetchedAt: 1_000 }
    });
  });

  it('ignores a malformed cache entry rather than trusting it', async () => {
    mockedRead.mockResolvedValue({ ETH: { priceMicro: '4000.5', fetchedAt: 1_000 } });

    await expect(getPriceMicro('ETH', 1_050)).resolves.toBeUndefined();
  });

  it('ignores a null cache entry rather than crashing', async () => {
    mockedRead.mockResolvedValue({ ETH: null });

    await expect(getPriceMicro('ETH', 1_050)).resolves.toBeUndefined();
  });

  it('prices the E2E fixture symbol at exactly one dollar, reading neither the cache nor the feed', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    try {
      await expect(getPriceMicro('TST', 1_000)).resolves.toBe(1_000_000n);
    } finally {
      delete process.env.MIDEN_E2E_TEST;
    }
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('leaves the fixture symbol unpriced outside an E2E build', async () => {
    await expect(getPriceMicro('TST', 1_000)).resolves.toBeUndefined();
  });
});

describe('writeUsdPriceCache', () => {
  it('merges into the stored cache rather than replacing it', async () => {
    mockedRead.mockResolvedValue({ BTC: { priceMicro: '1', fetchedAt: 10 } });

    await writeUsdPriceCache({ ETH: { price: 2, change24h: 0, percentageChange24h: 0 } }, 20);

    expect(mockedWrite).toHaveBeenCalledWith('usd_price_cache', {
      BTC: { priceMicro: '1', fetchedAt: 10 },
      ETH: { priceMicro: '2000000', fetchedAt: 20 }
    });
  });

  it('drops an uncovered symbol the feed volunteered', async () => {
    await writeUsdPriceCache({ DOGE: { price: 1, change24h: 0, percentageChange24h: 0 } }, 20);

    expect(mockedWrite).toHaveBeenCalledWith('usd_price_cache', {});
  });
});
