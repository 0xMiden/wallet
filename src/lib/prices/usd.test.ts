import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { assessSpendingLimit } from 'lib/miden/spending-limits/policy';
import type { SpendingLimitConfiguration } from 'lib/miden/spending-limits/types';

import type { TokenPrices } from './binance';
import { fetchTokenPrices } from './feed';
import {
  getPriceMicro,
  isCoveredSymbol,
  prefetchUsdPrices,
  toPriceMicro,
  writeUsdPriceCache,
  __resetUsdPriceCacheForTests
} from './usd';

jest.mock('lib/miden/swap/tokens', () => ({ getPriceSymbols: () => ['ARB'] }));
jest.mock('./feed', () => ({ fetchTokenPrices: jest.fn() }));
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

/**
 * Sets `MIDEN_E2E_TEST` to `'true'` for the duration of `fn`, then restores whatever value the
 * environment actually had before - never unconditionally deletes it. `dotenv/config` runs in
 * jest's `setupFiles`, so a developer whose own `.env` sets this flag would otherwise have it
 * silently stripped for the rest of the worker the first time a test here used `delete`.
 */
const withE2eFlagSet = async (fn: () => void | Promise<void>): Promise<void> => {
  const previous = process.env.MIDEN_E2E_TEST;
  process.env.MIDEN_E2E_TEST = 'true';
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.MIDEN_E2E_TEST;
    else process.env.MIDEN_E2E_TEST = previous;
  }
};

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

  it('covers the E2E fixture symbol only inside an E2E build', async () => {
    expect(isCoveredSymbol('TST')).toBe(false);
    await withE2eFlagSet(() => {
      expect(isCoveredSymbol('TST')).toBe(true);
    });
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

  it('rejects a positive price that rounds down to zero micro-dollars', () => {
    // Passes the `price <= 0` guard (0.0000001 is positive) but scales to 0.1 micro-dollars,
    // which rounds to 0 - the ternary's other branch, distinct from the guard above.
    expect(toPriceMicro(0.0000001)).toBeUndefined();
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

  it('fetches each requested asset across concurrent callers', async () => {
    mockedFetch.mockResolvedValue({
      ETH: { price: 4100, change24h: 0, percentageChange24h: 0 },
      BTC: { price: 90000, change24h: 0, percentageChange24h: 0 }
    });

    const [eth, btc] = await Promise.all([getPriceMicro('ETH', 1_000), getPriceMicro('BTC', 1_000)]);

    expect(eth).toBe(4_100_000_000n);
    expect(btc).toBe(90_000_000_000n);
    expect(mockedFetch).toHaveBeenCalledWith(['ETH']);
    expect(mockedFetch).toHaveBeenCalledWith(['BTC']);
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
    await withE2eFlagSet(async () => {
      await expect(getPriceMicro('TST', 1_000)).resolves.toBe(1_000_000n);
    });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('leaves the fixture symbol unpriced outside an E2E build', async () => {
    await expect(getPriceMicro('TST', 1_000)).resolves.toBeUndefined();
  });

  it('treats a cache read failure as empty rather than letting it crash the lookup', async () => {
    mockedRead.mockRejectedValue(new Error('storage offline'));
    mockedFetch.mockResolvedValue({ ETH: { price: 4100, change24h: 0, percentageChange24h: 0 } });

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBe(4_100_000_000n);
  });

  it('drops a covered symbol whose feed price cannot be converted, rather than caching garbage', async () => {
    mockedFetch.mockResolvedValue({ ETH: { price: 0, change24h: 0, percentageChange24h: 0 } });

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBeUndefined();
    expect(mockedWrite).toHaveBeenCalledWith('usd_price_cache', {});
  });

  it('treats a cache write failure as a slower next read, not a broken refresh', async () => {
    mockedWrite.mockRejectedValue(new Error('storage full'));
    mockedFetch.mockResolvedValue({ ETH: { price: 4100, change24h: 0, percentageChange24h: 0 } });

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBe(4_100_000_000n);
  });

  it('rejects a cached entry whose fetchedAt is not a safe integer', async () => {
    // 999.5 is inside the freshness window and not future-dated relative to now=1_000, so only the
    // safe-integer guard - not the staleness or future-dated checks - can be why this is discarded.
    mockedRead.mockResolvedValue({ ETH: { priceMicro: '4000000000', fetchedAt: 999.5 } });

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBeUndefined();
  });

  it('rejects a cached entry with a negative fetchedAt even inside the freshness window', async () => {
    // now=-1 keeps the entry inside the 600s window and not future-dated (fetchedAt < now), so only
    // the explicit `< 0` guard can be why this is discarded.
    mockedRead.mockResolvedValue({ ETH: { priceMicro: '4000000000', fetchedAt: -2 } });

    await expect(getPriceMicro('ETH', -1)).resolves.toBeUndefined();
  });

  it('rejects a cached entry whose price decodes to zero, refreshing instead of trusting it', async () => {
    mockedRead.mockResolvedValue({ ETH: { priceMicro: '0', fetchedAt: 1_000 } });
    mockedFetch.mockResolvedValue({ ETH: { price: 4100, change24h: 0, percentageChange24h: 0 } });

    await expect(getPriceMicro('ETH', 1_000)).resolves.toBe(4_100_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
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

describe('fixed USDCX micro-dollar price', () => {
  it('returns exactly one million micro-dollars without storage or market access', async () => {
    mockedRead.mockRejectedValue(new Error('storage unavailable'));
    mockedFetch.mockRejectedValue(new Error('feed unavailable'));
    await expect(getPriceMicro('USDCX', 1000)).resolves.toBe(1_000_000n);
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(isCoveredSymbol('USDCX')).toBe(true);
  });
});

it('fetches and caches a dynamic verified asset without a static feed entry', async () => {
  mockedFetch.mockResolvedValue({ ARB: { price: 0.75, change24h: 0, percentageChange24h: 0 } });
  await expect(getPriceMicro('ARB', 100)).resolves.toBe(750_000n);
  expect(mockedFetch).toHaveBeenCalledWith(['ARB']);
  expect(mockedWrite).toHaveBeenCalledWith('usd_price_cache', {
    ARB: { priceMicro: '750000', fetchedAt: 100 }
  });
});

it('allows a later cache write after an earlier write fails', async () => {
  await expect(
    writeUsdPriceCache({ ETH: { price: Number.MAX_VALUE, change24h: 0, percentageChange24h: 0 } }, 100)
  ).rejects.toBeInstanceOf(RangeError);
  await expect(
    writeUsdPriceCache({ ETH: { price: 1000, change24h: 0, percentageChange24h: 0 } }, 101)
  ).resolves.toBeUndefined();
  expect(mockedWrite).toHaveBeenCalledWith('usd_price_cache', {
    ETH: { priceMicro: '1000000000', fetchedAt: 101 }
  });
});

describe('prefetchUsdPrices', () => {
  const quote = (price: number) => ({ price, change24h: 0, percentageChange24h: 0 });

  it('fetches every cold covered symbol in one request and leaves them cached', async () => {
    let stored: unknown = null;
    mockedRead.mockImplementation(async () => stored);
    mockedWrite.mockImplementation(async (_key, value) => {
      stored = value;
    });
    mockedFetch.mockResolvedValue({ ETH: quote(4100), BTC: quote(90000) });

    await prefetchUsdPrices(['ETH', 'USDCX', 'BTC', 'ETH'], 1_000);

    expect(mockedFetch.mock.calls).toEqual([[['ETH', 'BTC']]]);
    await expect(getPriceMicro('ETH', 1_000)).resolves.toBe(4_100_000_000n);
    await expect(getPriceMicro('BTC', 1_000)).resolves.toBe(90_000_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('caches a requested symbol that the current network does not cover', async () => {
    let stored: unknown = null;
    mockedRead.mockImplementation(async () => stored);
    mockedWrite.mockImplementation(async (_key, value) => {
      stored = value;
    });
    mockedFetch.mockResolvedValue({ OP: quote(2), USDT: quote(1) });

    await prefetchUsdPrices(['OP'], 1_000);

    await expect(getPriceMicro('OP', 1_000)).resolves.toBe(2_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(stored).not.toHaveProperty('USDT');
    stored = null;
    await writeUsdPriceCache({ OP: quote(2) }, 1_000);
    expect(stored).toEqual({});
  });

  it('shares a symbol already in flight with an overlapping call', async () => {
    let release: (prices: TokenPrices) => void = () => undefined;
    mockedFetch.mockImplementationOnce(
      () =>
        new Promise<TokenPrices>(resolve => {
          release = resolve;
        })
    );
    const first = prefetchUsdPrices(['ETH', 'BTC'], 1_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    mockedFetch.mockResolvedValueOnce({ USDC: quote(1) });
    const second = prefetchUsdPrices(['BTC', 'USDC'], 1_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    release({ ETH: quote(4100), BTC: quote(90000) });
    await Promise.all([first, second]);

    expect(mockedFetch.mock.calls).toEqual([[['ETH', 'BTC']], [['USDC']]]);
  });
});

describe('Task5 cache USD', () => {
  const quote = (price: number) => ({ price, change24h: 0, percentageChange24h: 0 });
  const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let retained: unknown;

  beforeEach(() => {
    retained = {};
    mockedRead.mockImplementation(async () => retained);
    mockedWrite.mockImplementation(async (_key, value) => {
      retained = value;
    });
  });

  it.each([
    { label: 'expired', discarded: { priceMicro: '1000000', fetchedAt: 999 } },
    { label: 'future', discarded: { priceMicro: '1000000', fetchedAt: 1601 } },
    { label: 'malformed', discarded: { priceMicro: '1.5', fetchedAt: 1600 } }
  ])('prunes $label quotes while preserving the boundary and newly requested value', async ({ discarded }) => {
    retained = { ETH: { priceMicro: '1000000', fetchedAt: 1000 }, DISCARD: discarded };
    mockedFetch.mockResolvedValue({ OP: quote(2) });

    await prefetchUsdPrices(['OP'], 1600);

    expect(retained).not.toHaveProperty('DISCARD');
    expect(retained).toHaveProperty('ETH', { priceMicro: '1000000', fetchedAt: 1000 });
    await expect(getPriceMicro('OP', 1600)).resolves.toBe(2_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(['OP']);
  });

  it.each([
    { label: 'entry count', count: 256, prefix: 'old-' },
    { label: 'full UTF-8 value bytes', count: 32, prefix: '界'.repeat(800) }
  ])('bounds $label while retaining a new requested quote', async ({ count, prefix }) => {
    retained = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`${prefix}${index}`, { priceMicro: '1000000', fetchedAt: 1599 }])
    );
    mockedFetch.mockResolvedValue({ OP: quote(2) });

    await prefetchUsdPrices(['OP'], 1600);

    expect(typeof retained).toBe('object');
    expect(retained).not.toBeNull();
    if (typeof retained !== 'object' || retained === null) throw new Error('cache write was not an object');
    expect(Object.keys(retained).length).toBeLessThanOrEqual(256);
    expect(encodedBytes(retained)).toBeLessThanOrEqual(65_536);
    await expect(getPriceMicro('OP', 1600)).resolves.toBe(2_000_000n);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { age: 600, expected: 1_000_000n, fetches: 0 },
    { age: 601, expected: 1_500_000n, fetches: 1 }
  ])('keeps the existing quote freshness boundary at age $age', async ({ age, expected, fetches }) => {
    retained = { ETH: { priceMicro: '1000000', fetchedAt: 1000 } };
    mockedFetch.mockResolvedValue({ ETH: quote(1.5) });

    await expect(getPriceMicro('ETH', 1000 + age)).resolves.toBe(expected);

    expect(mockedFetch).toHaveBeenCalledTimes(fetches);
  });

  it('an equal price with the same fetchedAt queues no persistent write', async () => {
    retained = { ETH: { priceMicro: '2000000', fetchedAt: 1000 } };

    await writeUsdPriceCache({ ETH: quote(2) }, 1000);

    expect(mockedWrite).not.toHaveBeenCalled();
    expect(retained).toEqual({ ETH: { priceMicro: '2000000', fetchedAt: 1000 } });
  });

  it('an equal price with a later fetchedAt writes its genuine freshness update once', async () => {
    retained = { ETH: { priceMicro: '2000000', fetchedAt: 1000 } };

    await writeUsdPriceCache({ ETH: quote(2) }, 1001);

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(retained).toEqual({ ETH: { priceMicro: '2000000', fetchedAt: 1001 } });
    await expect(getPriceMicro('ETH', 1601)).resolves.toBe(2_000_000n);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('cache pruning and repricing preserve the frozen spending stamp in the real policy', async () => {
    const transaction: ITransaction = {
      id: 'frozen-spend',
      type: 'send',
      accountId: 'account-a',
      spentUsd: 90_000_000n,
      status: ITransactionStatus.Completed,
      initiatedAt: 1_999_990,
      displayIcon: 'SEND'
    };
    Object.freeze(transaction);
    const config: SpendingLimitConfiguration = {
      accountId: 'account-a',
      limit: 100_000_000n,
      revision: 'revision-1',
      createdAt: 1,
      updatedAt: 1
    };
    retained = { ETH: { priceMicro: '90000000', fetchedAt: 1_999_000 } };
    mockedFetch.mockResolvedValue({ ETH: quote(1) });

    await expect(getPriceMicro('ETH', 2_000_000)).resolves.toBe(1_000_000n);
    const assessment = assessSpendingLimit(config, [transaction], {
      accountId: 'account-a',
      usdAmount: 20_000_000n,
      now: 2_000_000
    });

    expect(transaction.spentUsd).toBe(90_000_000n);
    expect(assessment.breach).toMatchObject({
      spent: 90_000_000n,
      proposedTotal: 110_000_000n,
      overBy: 10_000_000n
    });
  });
});

describe('Task5 cache canonical equality', () => {
  it('persists pruning of oversized unrecognized quote fields even when the accepted price and stamp match', async () => {
    let retained: unknown = {
      ETH: { priceMicro: '2000000', fetchedAt: 1000, unused: '界'.repeat(30_000) }
    };
    mockedRead.mockImplementation(async () => retained);
    mockedWrite.mockImplementation(async (_key, value) => {
      retained = value;
    });
    await writeUsdPriceCache({ ETH: { price: 2, change24h: 0, percentageChange24h: 0 } }, 1000);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBeLessThanOrEqual(65_536);
    expect(retained).toEqual({ ETH: { priceMicro: '2000000', fetchedAt: 1000 } });
  });
});
