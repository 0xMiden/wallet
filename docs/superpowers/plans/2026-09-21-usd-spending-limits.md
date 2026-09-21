# USD Spending Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-asset, native-unit spending limits with one account-scoped cap in US dollars over a rolling 24-hour window.

**Architecture:** A transaction's dollar value is resolved before the Dexie write lock opens, from the Binance feed the wallet already runs, cached in the same IndexedDB key-value store the metadata cache uses so the service-worker realm can read it. That value is stamped on the transaction row, and the rolling window sums stamped values. Assets the feed does not cover contribute zero; a covered asset with no fresh price fails closed and can be released by one exact step-up.

**Tech Stack:** TypeScript, React, Dexie (IndexedDB), Zustand, Jest + React Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-usd-spending-limits-design.md`

## Global Constraints

- All user-facing text goes through `t('key')` or `<T id="key" />`; new keys land in `public/_locales/en/en.json` (flat). `yarn lint:i18n` blocks literals.
- No `any`, no `as`. Concrete types only.
- Prettier: 120 columns, single quotes, semicolons, trailing commas. `yarn format` fixes.
- Commit messages are single-line and short. Never add a `Co-Authored-By` or any tool attribution, in commits or anywhere else.
- No em dash (U+2014) or en dash (U+2013) in any file this plan touches, including comments and locale strings. Use a plain hyphen.
- Never `git push` without being asked.
- USD is always micro-dollars as `bigint`: one dollar is `1_000_000n`. No `number` holds a dollar value anywhere in the policy, the row, or the authorization.
- `getTokenPrice` from `lib/prices` must not be imported by any file on the enforcement path. Its `DEFAULT_PRICE` is one dollar for unknown tokens and would silently charge arbitrary assets.
- The Dexie write transaction in `queueOutgoingTransaction` must contain no network call. Price resolution happens before it opens.
- Run `yarn test <path>` for the suite belonging to any file you change, before committing that file.

---

### Task 1: USD price coverage and cache

A realm-agnostic price lookup that reports absence out loud, cached where the service worker can read it.

**Files:**
- Create: `src/lib/prices/usd.ts`
- Create: `src/lib/prices/usd.test.ts`
- Modify: `src/lib/prices/index.ts:30-47` (PriceProvider writes through to the cache)

**Interfaces:**
- Consumes: `KNOWN_SYMBOLS` from `src/lib/prices/constant.ts`; `fetchTokenPrices`, `TokenPrices` from `src/lib/prices/binance.ts`; `fetchFromStorage`, `putToStorage` from `lib/miden/front/storage` (realm-agnostic despite the path, `metadata/fetch.ts:42` already reads it from the service worker).
- Produces:
  - `USD_SCALE: bigint` (`1_000_000n`)
  - `PRICE_MAX_AGE_SECONDS: number` (`600`)
  - `isCoveredSymbol(symbol: string): boolean`
  - `toPriceMicro(price: number): bigint | undefined`
  - `writeUsdPriceCache(prices: TokenPrices, now?: number): Promise<void>`
  - `getPriceMicro(symbol: string, now?: number): Promise<bigint | undefined>` - `undefined` means "covered but unavailable"; callers check `isCoveredSymbol` first.

- [ ] **Step 1: Write the failing test**

Create `src/lib/prices/usd.test.ts`:

```typescript
import { fetchTokenPrices } from './binance';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/prices/usd.test.ts`
Expected: FAIL, cannot find module `./usd`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/prices/usd.ts`:

```typescript
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { fetchTokenPrices, TokenPrices } from './binance';
import { KNOWN_SYMBOLS } from './constant';

/** One US dollar in the fixed-point unit every spending limit is denominated in. */
export const USD_SCALE = 1_000_000n;

/**
 * How old a cached price may be and still govern a spend.
 *
 * Twice `PriceProvider`'s five-minute refresh, so an open wallet window keeps the cache warm and
 * the backend only reaches the network when nothing else has.
 */
export const PRICE_MAX_AGE_SECONDS = 600;

const PRICE_CACHE_STORAGE_KEY = 'usd_price_cache';
const CANONICAL_PRICE = /^(0|[1-9]\d*)$/;

interface CachedUsdPrice {
  priceMicro: string;
  fetchedAt: number;
}

type UsdPriceCache = Record<string, CachedUsdPrice>;

/**
 * Whether the feed can price this symbol at all.
 *
 * Indexed rather than `in` or `hasOwnProperty` so an inherited member such as `toString` cannot
 * read as covered: the value test is what decides, and a function is not a trading pair.
 */
export const isCoveredSymbol = (symbol: string): boolean => typeof KNOWN_SYMBOLS[symbol] === 'string';

export const toPriceMicro = (price: number): bigint | undefined => {
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const micro = BigInt(Math.round(price * Number(USD_SCALE)));
  return micro > 0n ? micro : undefined;
};

const readCache = async (): Promise<UsdPriceCache> => {
  try {
    return (await fetchFromStorage<UsdPriceCache>(PRICE_CACHE_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
};

const mergeIntoCache = async (prices: TokenPrices, now: number): Promise<UsdPriceCache> => {
  const cache = await readCache();
  for (const [symbol, info] of Object.entries(prices)) {
    if (!isCoveredSymbol(symbol)) continue;
    const priceMicro = toPriceMicro(info.price);
    if (priceMicro === undefined) continue;
    cache[symbol] = { priceMicro: priceMicro.toString(), fetchedAt: now };
  }
  try {
    await putToStorage(PRICE_CACHE_STORAGE_KEY, cache);
  } catch {
    // A cache that cannot be written is a slower next read, never a wrong verdict.
  }
  return cache;
};

/** Write-through used by the foreground provider so the backend rarely has to fetch. */
export const writeUsdPriceCache = async (
  prices: TokenPrices,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  await mergeIntoCache(prices, now);
};

const cachedPriceMicro = (cache: UsdPriceCache, symbol: string, now: number): bigint | undefined => {
  const entry = cache[symbol];
  if (entry === undefined) return undefined;
  if (typeof entry.priceMicro !== 'string' || !CANONICAL_PRICE.test(entry.priceMicro)) return undefined;
  if (!Number.isSafeInteger(entry.fetchedAt) || entry.fetchedAt < 0) return undefined;
  // A future-dated entry is a skewed clock, not evidence of freshness.
  if (entry.fetchedAt > now || now - entry.fetchedAt > PRICE_MAX_AGE_SECONDS) return undefined;
  const price = BigInt(entry.priceMicro);
  return price > 0n ? price : undefined;
};

// One refresh serves every caller that arrives while it is in flight. A transaction moving three
// assets must not open three connections to answer one question.
let inFlightRefresh: Promise<UsdPriceCache> | undefined;

const refresh = async (now: number): Promise<UsdPriceCache> => {
  if (inFlightRefresh === undefined) {
    inFlightRefresh = (async () => {
      try {
        return await mergeIntoCache(await fetchTokenPrices(), now);
      } catch {
        return await readCache();
      } finally {
        inFlightRefresh = undefined;
      }
    })();
  }
  return inFlightRefresh;
};

/**
 * The price of one whole unit of `symbol` in micro-dollars, or `undefined` when the symbol is
 * covered by the feed but no fresh price can be produced.
 *
 * Callers must ask `isCoveredSymbol` first: this function cannot tell "nobody prices this asset"
 * from "the price is missing right now", and those two cases have opposite consequences.
 */
export const getPriceMicro = async (
  symbol: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<bigint | undefined> => {
  const cached = cachedPriceMicro(await readCache(), symbol, now);
  if (cached !== undefined) return cached;
  return cachedPriceMicro(await refresh(now), symbol, now);
};

/** Test seam: the single-flight handle is module state and would leak between cases. */
export const __resetUsdPriceCacheForTests = (): void => {
  inFlightRefresh = undefined;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/prices/usd.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Write through from the foreground provider**

In `src/lib/prices/index.ts`, import `writeUsdPriceCache` from `./usd` and extend the existing effect at lines 39-44 so a successful fetch also lands in the shared cache:

```typescript
  useEffect(() => {
    if (prices && Object.keys(prices).length > 0) {
      syncDone.current = true;
      setTokenPrices(prices);
      // The enforcement path runs in the backend realm and cannot see this store. Writing through
      // is what keeps the cache warm enough that the backend rarely fetches on the send path.
      void writeUsdPriceCache(prices);
    }
  }, [prices, setTokenPrices]);
```

- [ ] **Step 6: Run the provider suite**

Run: `yarn test src/lib/prices/index.test.tsx`
Expected: PASS. If a case asserts the effect's exact call list, extend it to expect the write-through rather than deleting the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/lib/prices/usd.ts src/lib/prices/usd.test.ts src/lib/prices/index.ts src/lib/prices/index.test.tsx
git commit -m "feat(prices): realm-agnostic USD price lookup with a shared cache"
```

---

### Task 2: Spend valuation

Turn a list of what a transaction sends into one micro-dollar figure, or refuse to guess.

**Files:**
- Create: `src/lib/miden/spending-limits/valuation.ts`
- Create: `src/lib/miden/spending-limits/valuation.test.ts`
- Modify: `src/lib/miden/spending-limits/types.ts` (add `SpendingLimitPriceUnavailableError`)

**Interfaces:**
- Consumes: `isCoveredSymbol`, `getPriceMicro`, `USD_SCALE` from Task 1; `fetchTokenMetadata` from `lib/miden/metadata` (backend-proven, `sync-manager.ts:530` calls it); `hasKnownScale` from `lib/miden/metadata/scale`; `IConsumedAssetTotal` from `../db/types`.
- Produces:
  - `usdMicroFromAmount(amount: bigint, decimals: number, priceMicro: bigint): bigint`
  - `resolveSpendsUsd(spends: readonly IConsumedAssetTotal[], now?: number): Promise<bigint>`
  - `SpendingLimitPriceUnavailableError` with `readonly code = 'SPENDING_LIMIT_PRICE_UNAVAILABLE'`

- [ ] **Step 1: Write the failing test**

Create `src/lib/miden/spending-limits/valuation.test.ts`:

```typescript
import { getPriceMicro } from 'lib/prices/usd';
import { fetchTokenMetadata } from '../metadata';
import { resolveSpendsUsd, usdMicroFromAmount } from './valuation';
import { SpendingLimitPriceUnavailableError } from './types';

jest.mock('lib/prices/usd', () => ({
  ...jest.requireActual('lib/prices/usd'),
  getPriceMicro: jest.fn()
}));
jest.mock('../metadata', () => ({ fetchTokenMetadata: jest.fn() }));

const mockedPrice = jest.mocked(getPriceMicro);
const mockedMetadata = jest.mocked(fetchTokenMetadata);

const base = (symbol: string, decimals: number, scaleIsUnknown?: boolean) => ({
  base: { symbol, decimals, name: symbol, ...(scaleIsUnknown !== undefined && { scaleIsUnknown }) },
  detailed: { symbol, decimals, name: symbol }
});

beforeEach(() => jest.clearAllMocks());

describe('usdMicroFromAmount', () => {
  it('converts whole units at the quoted price', () => {
    // 2 ETH at $4000 = $8000
    expect(usdMicroFromAmount(2_000_000_000_000_000_000n, 18, 4_000_000_000n)).toBe(8_000_000_000n);
  });

  it('rounds up so a charge is never understated', () => {
    // 1 base unit of an 18-decimal asset at $4000 is a vanishing fraction of a micro-dollar.
    expect(usdMicroFromAmount(1n, 18, 4_000_000_000n)).toBe(1n);
  });

  it('is exact when the division has no remainder', () => {
    expect(usdMicroFromAmount(1_000_000n, 6, 1_000_000n)).toBe(1_000_000n);
  });

  it('values nothing as nothing', () => {
    expect(usdMicroFromAmount(0n, 6, 1_000_000n)).toBe(0n);
  });

  it('rejects impossible inputs rather than producing a number', () => {
    expect(() => usdMicroFromAmount(-1n, 6, 1n)).toThrow(RangeError);
    expect(() => usdMicroFromAmount(1n, -1, 1n)).toThrow(RangeError);
    expect(() => usdMicroFromAmount(1n, 6, -1n)).toThrow(RangeError);
  });
});

describe('resolveSpendsUsd', () => {
  it('values a covered asset', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 25_000_000n }], 10)).resolves.toBe(25_000_000n);
  });

  it('counts an uncovered asset as nothing and never asks for its price', async () => {
    mockedMetadata.mockResolvedValue(base('MIDEN', 6));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 999_000_000n }], 10)).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('sums across several assets', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === 'eth' ? base('ETH', 18) : faucetId === 'usdc' ? base('USDC', 6) : base('MIDEN', 6)
    );
    mockedPrice.mockImplementation(async symbol => (symbol === 'ETH' ? 4_000_000_000n : 1_000_000n));

    const total = await resolveSpendsUsd(
      [
        { faucetId: 'eth', amount: 1_000_000_000_000_000_000n },
        { faucetId: 'usdc', amount: 10_000_000n },
        { faucetId: 'miden', amount: 500_000_000n }
      ],
      10
    );

    expect(total).toBe(4_010_000_000n);
  });

  it('fails closed when a covered asset has no fresh price', async () => {
    mockedMetadata.mockResolvedValue(base('ETH', 18));
    mockedPrice.mockResolvedValue(undefined);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('fails closed when a covered asset has untrustworthy decimals', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6, true));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('fails closed when the asset cannot be identified at all', async () => {
    mockedMetadata.mockRejectedValue(new Error('rpc down'));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('values an empty spend list as nothing', async () => {
    await expect(resolveSpendsUsd([], 10)).resolves.toBe(0n);
    expect(mockedMetadata).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/spending-limits/valuation.test.ts`
Expected: FAIL, cannot find module `./valuation`.

- [ ] **Step 3: Add the error type**

In `src/lib/miden/spending-limits/types.ts`, after `SpendingLimitAuthorizationRequiredError` (line 113):

```typescript
/**
 * A covered asset whose dollar value cannot be established right now.
 *
 * Distinct from `SpendingLimitPolicyUnavailableError`: nothing is corrupt, the wallet simply
 * cannot prove the cap is respected. Wallet-owned flows offer one exact step-up; dApp paths refuse.
 */
export class SpendingLimitPriceUnavailableError extends Error {
  readonly code = 'SPENDING_LIMIT_PRICE_UNAVAILABLE';

  constructor(readonly symbol: string) {
    super(`No current price is available for ${symbol}`);
    this.name = 'SpendingLimitPriceUnavailableError';
  }
}

/**
 * Recognise that refusal from either side of the intercom boundary.
 *
 * `instanceof` holds only inside the realm that threw. A frontend flow catching this error caught
 * it after serialization, where the prototype is gone and only the fields survive - which is why
 * `spendingLimitAssessmentFromError` beside this reads `code` rather than testing the class.
 */
export const isSpendingLimitPriceUnavailable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'SPENDING_LIMIT_PRICE_UNAVAILABLE';
```

This predicate is what every frontend catch uses. A `catch (e) { if (e instanceof SpendingLimitPriceUnavailableError) }` in a screen is always false, because the error crossed a port and arrived as a plain object.

- [ ] **Step 4: Write the implementation**

Create `src/lib/miden/spending-limits/valuation.ts`:

```typescript
import { getPriceMicro, isCoveredSymbol } from 'lib/prices/usd';

import { IConsumedAssetTotal } from '../db/types';
import { fetchTokenMetadata } from '../metadata';
import { hasKnownScale } from '../metadata/scale';
import { SpendingLimitPriceUnavailableError } from './types';

/**
 * The micro-dollar value of `amount` base units, rounded UP.
 *
 * Up, because this figure is charged against an allowance: a truncated charge understates what
 * left the account, and repeated truncation is a slow leak past the cap.
 */
export const usdMicroFromAmount = (amount: bigint, decimals: number, priceMicro: bigint): bigint => {
  if (typeof amount !== 'bigint' || amount < 0n) throw new RangeError('Invalid spend amount');
  if (typeof priceMicro !== 'bigint' || priceMicro < 0n) throw new RangeError('Invalid price');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('Invalid asset decimals');
  const scale = 10n ** BigInt(decimals);
  const product = amount * priceMicro;
  return (product + scale - 1n) / scale;
};

/**
 * What this transaction is worth, in micro-dollars.
 *
 * An asset the feed does not cover contributes nothing, which is the product decision: only priced
 * assets are capped. An asset it DOES cover must be valued or the transaction cannot be judged, so
 * a missing price, untrustworthy decimals, or an unidentifiable faucet all raise rather than
 * quietly counting as nothing - otherwise "make the price lookup fail" is the way past the cap.
 */
export const resolveSpendsUsd = async (
  spends: readonly IConsumedAssetTotal[],
  now?: number
): Promise<bigint> => {
  let total = 0n;
  for (const spend of spends) {
    let symbol: string;
    let decimals: number;
    let scaleKnown: boolean;
    try {
      const { base } = await fetchTokenMetadata(spend.faucetId);
      symbol = base.symbol;
      decimals = base.decimals;
      scaleKnown = hasKnownScale(base);
    } catch {
      throw new SpendingLimitPriceUnavailableError(spend.faucetId);
    }
    if (!isCoveredSymbol(symbol)) continue;
    if (!scaleKnown) throw new SpendingLimitPriceUnavailableError(symbol);
    const priceMicro = await getPriceMicro(symbol, now);
    if (priceMicro === undefined) throw new SpendingLimitPriceUnavailableError(symbol);
    total += usdMicroFromAmount(spend.amount, decimals, priceMicro);
  }
  return total;
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test src/lib/miden/spending-limits/valuation.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Pin that the one-dollar default is not on this path**

The spec calls for this assertion directly, because the defect it prevents is silent: `getTokenPrice`
returns `DEFAULT_PRICE` of one dollar for any symbol it does not know, so a valuation routed through
it would charge arbitrary assets at a dollar a unit and nothing would look wrong. Add to
`valuation.test.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

it('never reaches the one-dollar default', () => {
  const enforcementPath = [
    'src/lib/miden/spending-limits/valuation.ts',
    'src/lib/miden/spending-limits/queue.ts',
    'src/lib/miden/spending-limits/policy.ts',
    'src/lib/prices/usd.ts'
  ];

  for (const file of enforcementPath) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toContain('getTokenPrice');
    expect(source).not.toContain('DEFAULT_PRICE');
  }
});
```

- [ ] **Step 7: Prove the rounding test is not vacuous**

Predict first, in writing: changing `(product + scale - 1n) / scale` to `product / scale` should fail exactly "rounds up so a charge is never understated" and nothing else. Apply that mutation, run the suite, confirm the prediction, then restore.

Run: `yarn test src/lib/miden/spending-limits/valuation.test.ts`
Expected: exactly one failing test, the rounding one. If more fail, or that one passes, the prediction was wrong and the tests need work before moving on.

- [ ] **Step 8: Commit**

```bash
git add src/lib/miden/spending-limits/valuation.ts src/lib/miden/spending-limits/valuation.test.ts src/lib/miden/spending-limits/types.ts
git commit -m "feat(spending-limits): value a spend in micro-dollars or refuse"
```

---

### Task 3: Schema 1.8 and the stamped row value

**Files:**
- Modify: `src/lib/miden/repo.ts:137-156`
- Modify: `src/lib/miden/db/types.ts` (add `spentUsd` beside `spentAssetTotals`, around line 425)
- Test: `src/lib/miden/repo.test.ts`

**Interfaces:**
- Produces: `Repo.spendingLimits` re-typed as `db.table<PersistedSpendingLimit, string>` keyed by `accountId`; `ITransaction.spentUsd?: bigint`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/miden/repo.test.ts`:

```typescript
it('keys spending limits by account alone', async () => {
  await Repo.spendingLimits.put({
    accountId: 'acct-1',
    limit: '50000000',
    revision: 'rev-1',
    createdAt: 1,
    updatedAt: 1
  });

  await expect(Repo.spendingLimits.get('acct-1')).resolves.toMatchObject({ limit: '50000000' });
});

it('stores a stamped dollar value on a transaction row', async () => {
  await Repo.transactions.add({ ...outgoingRowFixture(), id: 'tx-usd', spentUsd: 1_500_000n });

  await expect(Repo.transactions.get('tx-usd')).resolves.toMatchObject({ spentUsd: 1_500_000n });
});
```

Use the file's existing row fixture helper; if none exists, build the row the way the neighbouring cases in that file do.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/repo.test.ts`
Expected: FAIL, the compound-key table rejects a string key.

- [ ] **Step 3: Bump the schema**

In `src/lib/miden/repo.ts`, after the `db.version(1.7)` block:

```typescript
// v1.8 - one USD cap per account replaces the per-asset caps. The table is RECREATED rather than
// migrated: a native-unit cap cannot be restated in dollars for an asset nobody prices, and the
// feature is days old, so the records are dropped and the screen asks for one number instead.
db.version(1.8)
  .stores({
    [Table.SpendingLimits]: indexes('accountId', 'revision')
  })
  .upgrade(async tx => {
    await tx.table(Table.SpendingLimits).clear();
  });
```

Then re-type the table export at line 156:

```typescript
export const spendingLimits = db.table<PersistedSpendingLimit, string>(Table.SpendingLimits);
```

- [ ] **Step 4: Add the row field**

In `src/lib/miden/db/types.ts`, directly after `spentAssetTotals?: IConsumedAssetTotal[];`:

```typescript
  /**
   * What this row sent, in micro-dollars, as valued when it was queued.
   *
   * Stamped once and never revalued: the rolling window sums these, so a price move must not
   * silently change what a past transaction consumed of the cap. Absent on rows written before
   * USD limits existed and on rows whose assets the price feed does not cover; both contribute
   * nothing, which is the same verdict the policy reaches for an uncovered asset today.
   */
  spentUsd?: bigint;
```

Add the same field to the `execute` row class around line 672 if that class re-declares `spentAssetTotals`; match whatever the neighbouring declaration does.

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test src/lib/miden/repo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/miden/repo.ts src/lib/miden/repo.test.ts src/lib/miden/db/types.ts
git commit -m "feat(store): account-keyed spending limits and a stamped row value"
```

---

### Task 4: Module core rewrite

Types, policy, change classification, config and queue move together. TypeScript will not compile a half-migrated module, so this is one commit.

**Files:**
- Modify: `src/lib/miden/spending-limits/types.ts`
- Modify: `src/lib/miden/spending-limits/policy.ts`
- Modify: `src/lib/miden/spending-limits/change.ts`
- Modify: `src/lib/miden/spending-limits/config.ts`
- Modify: `src/lib/miden/spending-limits/queue.ts`
- Test: the five existing suites beside them.

**Interfaces:**
- Consumes: `resolveSpendsUsd` (Task 2); `Repo.spendingLimits` keyed by account (Task 3).
- Produces:
  - `SpendingLimitConfiguration { accountId: string; limit: bigint; revision: string; createdAt: number; updatedAt: number }`
  - `SpendingLimitDraft { accountId: string; limit?: bigint }`
  - `PersistedSpendingLimit { accountId: string; limit: string; revision: string; createdAt: number; updatedAt: number }`
  - `SpendingLimitBreach { spent: bigint; proposedTotal: bigint; limit: bigint; overBy: bigint; resetAt: number | null }`
  - `SpendingLimitAssessment { accountId: string; usdAmount: bigint; revision: string; assessedAt: number; breach?: SpendingLimitBreach }`
  - `SpendingLimitAuthorization` as a discriminated union, see step 3
  - `assessSpendingLimit(config, rows, proposal: { accountId: string; usdAmount: bigint; now: number }): SpendingLimitAssessment`
  - `queueOutgoingTransaction(transaction: ITransaction, spends: readonly IConsumedAssetTotal[], authorization?: SpendingLimitAuthorization, now?: number): Promise<void>`
  - `spendsOf`, `hasSpendingLimits(accountId)`, `assessOutgoingSpendingLimitDetails` keep their names; `SpendingLimitAssessmentDetails` loses its `asset` field and becomes `{ assessment: SpendingLimitAssessment }`, so callers pass the assessment alone.
  - `MAX_WINDOW_SECONDS` becomes `DAY_SECONDS`.

- [ ] **Step 1: Write the failing tests**

Rewrite `policy.test.ts` around the single window and the stamped value. The cases that must exist, each named for what it pins:

```typescript
it('sums stamped dollar values inside the window', () => {
  const rows = [row({ initiatedAt: 1_000, spentUsd: 30_000_000n }), row({ initiatedAt: 1_500, spentUsd: 20_000_000n })];

  const assessment = assessSpendingLimit(config(100_000_000n), rows, {
    accountId: ACCOUNT,
    usdAmount: 60_000_000n,
    now: 2_000
  });

  expect(assessment.breach).toMatchObject({ spent: 50_000_000n, proposedTotal: 110_000_000n, overBy: 10_000_000n });
});

it('ignores a row that carries no stamped value', () => {
  const rows = [row({ initiatedAt: 1_000, spentUsd: undefined, amount: 999n, faucetId: 'eth' })];

  const assessment = assessSpendingLimit(config(100_000_000n), rows, {
    accountId: ACCOUNT,
    usdAmount: 1n,
    now: 2_000
  });

  expect(assessment.breach).toBeUndefined();
});

it('expires a row at the exact 24-hour boundary', () => {
  const rows = [row({ initiatedAt: 1_000, spentUsd: 100_000_000n })];

  const assessment = assessSpendingLimit(config(100_000_000n), rows, {
    accountId: ACCOUNT,
    usdAmount: 1n,
    now: 1_000 + 86_400
  });

  expect(assessment.breach).toBeUndefined();
});

it('reports when the window frees enough room', () => { /* resetAt is initiatedAt + 86400 */ });
it('reports no automatic reset when the proposal alone exceeds the cap', () => { /* resetAt null */ });
it('excludes rows restored from backup', () => { /* restoredFromBackup: true contributes nothing */ });
it('excludes incoming and structural types', () => { /* consume, earn-withdraw, switch-guardian */ });
it('includes queued, generating, completed and failed rows', () => { /* four statuses */ });
it('charges a future-dated row at now', () => { /* clamping survives */ });
it('throws on a row inside the window whose stamped value is not a bigint', () => { /* fail closed */ });
it('skips a malformed row older than the window', () => { /* asymmetry survives */ });
```

Update `queue.test.ts` so the multi-faucet refusal case is replaced by its successor: several assets sum into one figure and one authorization releases the total.

```typescript
it('sums several assets into one charge and accepts one authorization for the total', async () => {
  mockedResolve.mockResolvedValue(75_000_000n);
  await saveConfig({ accountId: ACCOUNT, limit: 50_000_000n, revision: 'rev-1' });

  await queueOutgoingTransaction(
    executeRow(),
    [
      { faucetId: 'eth', amount: 1n },
      { faucetId: 'usdc', amount: 2n }
    ],
    usdAuthorization({ accountId: ACCOUNT, usdAmount: 75_000_000n, revision: 'rev-1' }),
    NOW
  );

  await expect(Repo.transactions.get('tx-1')).resolves.toMatchObject({ spentUsd: 75_000_000n });
});

it('refuses a transaction whose price is unavailable when a limit exists', async () => {
  mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));
  await saveConfig({ accountId: ACCOUNT, limit: 50_000_000n, revision: 'rev-1' });

  await expect(queueOutgoingTransaction(sendRow(), [{ faucetId: 'eth', amount: 1n }], undefined, NOW)).rejects.toBeInstanceOf(
    SpendingLimitPriceUnavailableError
  );
  await expect(Repo.transactions.get('tx-1')).resolves.toBeUndefined();
});

it('does not resolve a price for an account with no limit', async () => {
  await queueOutgoingTransaction(sendRow(), [{ faucetId: 'eth', amount: 1n }], undefined, NOW);

  expect(mockedResolve).not.toHaveBeenCalled();
});

it('accepts an unpriced-kind authorization bound to exactly these spends', async () => {
  mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));
  await saveConfig({ accountId: ACCOUNT, limit: 50_000_000n, revision: 'rev-1' });
  const spends = [{ faucetId: 'eth', amount: 5n }];

  await queueOutgoingTransaction(sendRow(), spends, unpricedAuthorization(ACCOUNT, spends, 'rev-1'), NOW);

  await expect(Repo.transactions.get('tx-1')).resolves.toMatchObject({ spentUsd: undefined });
});

it('rejects an unpriced authorization minted for different spends', async () => {
  mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));
  await saveConfig({ accountId: ACCOUNT, limit: 50_000_000n, revision: 'rev-1' });

  await expect(
    queueOutgoingTransaction(
      sendRow(),
      [{ faucetId: 'eth', amount: 5n }],
      unpricedAuthorization(ACCOUNT, [{ faucetId: 'eth', amount: 4n }], 'rev-1'),
      NOW
    )
  ).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
});
```

Keep every existing case in `queue.test.ts` that pins atomicity, replay refusal, expiry, revision binding and the concurrent-race behaviour; only their units change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/lib/miden/spending-limits`
Expected: FAIL across the module, on the old per-faucet shapes.

- [ ] **Step 3: Rewrite `types.ts`**

Delete `SpendingLimitPeriod`, `SpendingLimitAssetSnapshot`, `SpendingLimitPeriods` and every `faucetId` and `asset` field. The parse-on-read discipline stays exactly as it is: the same `unavailable()` helper, the same `CANONICAL_AMOUNT` regex, the same `Reflect.get` field readers. Shapes become:

```typescript
export interface SpendingLimitDraft {
  accountId: string;
  limit?: bigint;
}

export interface SpendingLimitConfiguration {
  accountId: string;
  limit: bigint;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

/** IndexedDB shape. Decimal strings avoid browser-specific bigint serialization. */
export interface PersistedSpendingLimit {
  accountId: string;
  limit: string;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

export interface SpendingLimitBreach {
  spent: bigint;
  proposedTotal: bigint;
  limit: bigint;
  overBy: bigint;
  /** Null when the proposed transaction alone is larger than the cap. */
  resetAt: number | null;
}

export interface SpendingLimitAssessment {
  accountId: string;
  usdAmount: bigint;
  revision: string;
  assessedAt: number;
  breach?: SpendingLimitBreach;
}
```

The authorization becomes a discriminated union, because a transaction the wallet could not value still has to be releasable by step-up and still has to bind to one exact thing:

```typescript
/**
 * One-time authority for exactly one transaction.
 *
 * Two kinds, because there are two reasons a transaction can be stopped. A `usd` authorization
 * binds to the dollar figure the user was shown. An `unpriced` one covers a transaction whose
 * value could not be established at all: there is no figure to bind to, so it binds to the exact
 * assets and amounts instead. Neither is a cryptographic authorization - both exist to stop a
 * stale, mismatched or reused approval at the trusted wallet boundary.
 */
export type SpendingLimitAuthorization =
  | {
      kind: 'usd';
      id: string;
      accountId: string;
      usdAmount: bigint;
      revision: string;
      issuedAt: number;
      expiresAt: number;
    }
  | {
      kind: 'unpriced';
      id: string;
      accountId: string;
      spendsDigest: string;
      revision: string;
      issuedAt: number;
      expiresAt: number;
    };

/** Canonical, order-independent identity of what a transaction sends. */
export const spendsDigest = (spends: readonly { faucetId: string; amount: bigint }[]): string =>
  spends
    .map(spend => `${canonicalSpendingLimitIdentity(spend.faucetId)}:${spend.amount.toString()}`)
    .sort()
    .join('|');
```

This adds a `./identity` import to `types.ts`. There is no cycle: `identity.ts` imports only `../sdk/helpers` and never imports `types.ts`.

`validateAssessment` keeps its arithmetic invariants over the single optional breach:

```typescript
const validateAssessment = (assessment: SpendingLimitAssessment): SpendingLimitAssessment => {
  const breach = assessment.breach;
  if (breach === undefined) return assessment;
  if (
    breach.proposedTotal !== breach.spent + assessment.usdAmount ||
    breach.proposedTotal <= breach.limit ||
    breach.overBy !== breach.proposedTotal - breach.limit ||
    (breach.resetAt !== null && breach.resetAt <= assessment.assessedAt)
  ) {
    throw unavailable('breach values are inconsistent');
  }
  return assessment;
};
```

Serialized twins follow the same edit: `SerializedSpendingLimitDraft { accountId: string; limit?: string }`, `SerializedSpendingLimitBreach` without `period`, `SerializedSpendingLimitAssessment` with `usdAmount: string` and an optional `breach`.

- [ ] **Step 4: Rewrite `policy.ts`**

```typescript
const DAY_SECONDS = 24 * 60 * 60;

/** The only rolling window, and so the bound on the history read. */
export const MAX_WINDOW_SECONDS = DAY_SECONDS;

export interface ProposedSpend {
  accountId: string;
  usdAmount: bigint;
  now: number;
}
```

`OUTGOING_TYPES` and `INCLUDED_STATUSES` are unchanged. `rowSpendUnderFaucet` is replaced by:

```typescript
/**
 * What `row` contributed to the cap, in micro-dollars.
 *
 * A row with no stamped value contributes nothing: it predates USD limits, or every asset it moved
 * was one the feed cannot price. A row inside the window whose stamp is present but unusable stays
 * FATAL, for the same reason the per-faucet version did - a malformed value must not silently drop
 * spend out of the total.
 */
const rowSpendUsd = (row: ITransaction): { amount: unknown } | undefined =>
  row.spentUsd === undefined ? undefined : { amount: row.spentUsd };
```

`matchingSpendEntries` keeps its account filter, its type and restored-from-backup filters, its timestamp validation, the older-than-window skip, the status check and the future-date clamp, and swaps the faucet match for `rowSpendUsd(row)`. `validateProposal` drops the faucet comparison. `assessSpendingLimit` assesses one window and returns `{ accountId, usdAmount, revision, assessedAt, breach }`. Keep `resetAfterEnoughSpendExpires` and `assessWindow` as they are, minus the `period` field.

- [ ] **Step 5: Rewrite `change.ts`**

```typescript
export const classifySpendingLimitChange = (
  current: SpendingLimitConfiguration | undefined,
  next: SpendingLimitDraft
): SpendingLimitChangeClassification => {
  if (current === undefined) return next.limit === undefined ? 'safe' : 'strict-authentication';
  if (next.limit === undefined) return 'strict-authentication';
  return next.limit > current.limit ? 'strict-authentication' : 'safe';
};
```

- [ ] **Step 6: Rewrite `config.ts`**

`listSpendingLimits(accountId)` becomes `readSpendingLimit(accountId): Promise<SpendingLimitConfiguration | undefined>`, a single `spendingLimits.get(canonicalSpendingLimitIdentity(accountId))`. `saveSpendingLimit` keeps its revision-conflict check, its `strict-authentication` gate and its `rw` transaction; the delete branch triggers on `limit === undefined` alone and deletes by the account key.

- [ ] **Step 7: Rewrite `queue.ts`**

`readPolicy(accountId)` takes one key. `readHistory` is unchanged apart from now being bounded by 24 hours through `MAX_WINDOW_SECONDS`. `authorizationMatches` gains the kind check:

```typescript
const authorizationMatches = async (
  authorization: SpendingLimitAuthorization | undefined,
  expected: { accountId: string; usdAmount?: bigint; spendsDigest?: string },
  revision: string,
  now: number
): Promise<boolean> => {
  if (authorization === undefined) return false;
  if (
    authorization.id.trim().length === 0 ||
    !sameSpendingLimitIdentity(authorization.accountId, expected.accountId) ||
    authorization.revision !== revision ||
    !Number.isSafeInteger(authorization.issuedAt) ||
    !Number.isSafeInteger(authorization.expiresAt) ||
    authorization.issuedAt < 0 ||
    authorization.issuedAt > now ||
    authorization.expiresAt <= now ||
    authorization.expiresAt <= authorization.issuedAt ||
    authorization.expiresAt - authorization.issuedAt > MAX_AUTHORIZATION_LIFETIME_SECONDS
  ) {
    return false;
  }
  if (authorization.kind === 'usd') {
    if (expected.usdAmount === undefined || authorization.usdAmount !== expected.usdAmount) return false;
  } else {
    if (expected.spendsDigest === undefined || authorization.spendsDigest !== expected.spendsDigest) return false;
  }
  const uses = await Repo.transactions.where('spendingLimitAuthorizationId').equals(authorization.id).count();
  return uses === 0;
};
```

`queueOutgoingTransaction` gets the ordering the spec requires - policy first, then valuation outside the lock, then assess and insert inside it:

```typescript
export const queueOutgoingTransaction = async (
  transaction: ITransaction,
  spends: readonly IConsumedAssetTotal[],
  authorization?: SpendingLimitAuthorization,
  now: number = Math.floor(Date.now() / 1000)
): Promise<void> => {
  // An account with no cap must pay for neither a price lookup nor a window scan. This read is a
  // fast path only; the authoritative one happens inside the write transaction below.
  if ((await readPolicy(transaction.accountId)) === undefined) {
    await Repo.transactions.add(transaction);
    return;
  }

  // Outside the lock on purpose: resolution can reach the network, and a Dexie write transaction
  // that awaits a fetch is a write lock held across an unbounded wait.
  let spentUsd: bigint | undefined;
  let priceFailure: SpendingLimitPriceUnavailableError | undefined;
  try {
    spentUsd = await resolveSpendsUsd(spends, now);
  } catch (error) {
    if (!(error instanceof SpendingLimitPriceUnavailableError)) throw error;
    priceFailure = error;
  }

  await Repo.db.transaction('rw', Repo.spendingLimits, Repo.transactions, async () => {
    const persisted = await readPolicy(transaction.accountId);
    if (persisted === undefined) {
      await Repo.transactions.add(transaction);
      return;
    }
    const config = parsePersistedSpendingLimit(persisted);

    if (priceFailure !== undefined) {
      const digest = spendsDigest(spends);
      const matches = await authorizationMatches(
        authorization,
        { accountId: transaction.accountId, spendsDigest: digest },
        config.revision,
        now
      );
      if (!matches) throw priceFailure;
      await Repo.transactions.add({ ...transaction, spendingLimitAuthorizationId: authorization!.id });
      return;
    }

    const assessment = assessSpendingLimit(config, await readHistory(now), {
      accountId: transaction.accountId,
      usdAmount: spentUsd!,
      now
    });
    const stamped = { ...transaction, spentUsd: spentUsd! };
    if (assessment.breach === undefined) {
      await Repo.transactions.add(stamped);
      return;
    }
    const matches = await authorizationMatches(
      authorization,
      { accountId: transaction.accountId, usdAmount: spentUsd! },
      config.revision,
      now
    );
    if (!matches) throw new SpendingLimitAuthorizationRequiredError(assessment);
    await Repo.transactions.add({ ...stamped, spendingLimitAuthorizationId: authorization!.id });
  });
};
```

Note the unpriced branch stamps no `spentUsd`: the wallet does not know what the row was worth, and inventing a figure would be worse than leaving the row uncounted. Say so in a comment at that line.

`spendsOf` is unchanged. `hasSpendingLimits(accountId)` becomes a single `get` returning a boolean. `assessOutgoingSpendingLimitDetails` takes `{ accountId, spends, now? }`, resolves the value, and returns `{ assessment }` or `undefined` when no policy exists; it rethrows `SpendingLimitPriceUnavailableError` so callers can distinguish the two refusals.

- [ ] **Step 8: Update `authorization.ts`**

`createSpendingLimitAuthorization(assessment, issuedAt?, makeId?)` mints the `usd` kind from an assessment carrying a breach. Add `createUnpricedSpendingLimitAuthorization(accountId, spends, revision, issuedAt?, makeId?)` for the other kind. Both keep the two-minute lifetime and the empty-id guard.

- [ ] **Step 9: Run the module suites**

Run: `yarn test src/lib/miden/spending-limits`
Expected: PASS.

- [ ] **Step 10: Prove the new gate is not vacuous**

Predict first: deleting the `if (priceFailure !== undefined)` branch's `if (!matches) throw priceFailure;` should fail "refuses a transaction whose price is unavailable when a limit exists" and "rejects an unpriced authorization minted for different spends", and nothing else. Apply, run, confirm, restore.

- [ ] **Step 11: Commit**

```bash
git add src/lib/miden/spending-limits
git commit -m "feat(spending-limits): one account-scoped USD cap over a 24-hour window"
```

---

### Task 5: Backend actions, messages and store wiring

**Files:**
- Modify: `src/lib/miden/back/actions.ts:565-600`
- Modify: `src/lib/miden/back/main.ts:568-585`
- Modify: `src/lib/intercom/in-process-request-handler.ts:168-187`
- Modify: `src/lib/shared/types.ts:808-836`
- Modify: `src/lib/store/index.ts:389-420`, `src/lib/store/types.ts:182-192`
- Test: `src/lib/miden/back/actions.test.ts`, `src/lib/miden/back/main.test.ts`, `src/lib/store/index.test.ts`, `src/lib/intercom/{mobile,desktop}-adapter.test.ts`

**Interfaces:**
- Consumes: `readSpendingLimit`, `saveSpendingLimit`, `assessOutgoingSpendingLimitDetails` from Task 4.
- Produces:
  - `GetSpendingLimitsResponse.configuration?: PersistedSpendingLimit` (was `configurations: PersistedSpendingLimit[]`)
  - `AssessSpendingLimitRequest { accountId: string; spends: { faucetId: string; amount: string }[] }` (was `faucetId` + `amount`)
  - Store: `readSpendingLimit(accountId)`, `saveSpendingLimit(draft, observedRevision, strictlyAuthenticated)`, `assessSpendingLimit(accountId, spends)`.

- [ ] **Step 1: Write the failing test**

In `src/lib/miden/back/actions.test.ts`, replace the list-shaped cases:

```typescript
it('returns the one configuration for an account', async () => {
  await expect(Actions.getSpendingLimit(ACCOUNT)).resolves.toMatchObject({ limit: '50000000' });
});

it('assesses a multi-asset proposal as one dollar figure', async () => {
  const assessment = await Actions.assessOutgoingSpendingLimit(ACCOUNT, [
    { faucetId: 'eth', amount: '1000000000000000000' },
    { faucetId: 'usdc', amount: '10000000' }
  ]);

  expect(assessment?.usdAmount).toBe('4010000000');
});

it('surfaces a price failure as its own code rather than a policy failure', async () => {
  mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));

  await expect(Actions.assessOutgoingSpendingLimit(ACCOUNT, [{ faucetId: 'eth', amount: '1' }])).rejects.toMatchObject({
    code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE'
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/lib/miden/back/actions.test.ts`
Expected: FAIL on the changed signatures.

- [ ] **Step 3: Update the message payloads**

In `src/lib/shared/types.ts`, rename `GetSpendingLimitsRequest/Response` to `GetSpendingLimitRequest/Response` with `configuration?: PersistedSpendingLimit`, and change `AssessSpendingLimitRequest` to carry `spends: SerializedSpend[]` where `interface SerializedSpend { faucetId: string; amount: string }`. Update the two union lists at 1229-1231 and 1304-1306 and the `WalletMessageType` enum entries.

- [ ] **Step 4: Update the handlers**

`actions.ts`: `getSpendingLimit` returns one serialized record or `undefined`; `assessOutgoingSpendingLimit(accountId, spends)` maps each `amount` through `parseSerializedSpendingAmount` before calling the domain function. `main.ts` and `in-process-request-handler.ts` dispatch the renamed types with the new fields. Per CLAUDE.md, both switches must be updated together or mobile and desktop diverge from the extension.

- [ ] **Step 5: Update the store**

`src/lib/store/index.ts`: `listSpendingLimits` becomes `readSpendingLimit(accountId)` returning one configuration or `undefined`; `assessSpendingLimit(accountId, spends)` takes the spend list. Update `src/lib/store/types.ts:182-192` to match. Leave the two E2E hooks beside them (`__TEST_RUN_SPENDING_LIMIT_RACE__`, `__TEST_BUILD_CUSTOM_TRANSACTION_REQUEST__`) working; the race hook's two concurrent calls now pass a spend list.

- [ ] **Step 6: Run the suites**

Run: `yarn test src/lib/miden/back/actions.test.ts src/lib/miden/back/main.test.ts src/lib/store/index.test.ts src/lib/intercom`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/types.ts src/lib/miden/back/actions.ts src/lib/miden/back/main.ts src/lib/intercom src/lib/store
git commit -m "feat(spending-limits): carry one USD cap across the message layer"
```

---

### Task 6: Enforcement call sites

**Files:**
- Modify: `src/lib/miden/transaction/initiate.ts:65,417,475,513,545`
- Modify: `src/lib/miden/back/dapp.ts:1612-1650,1823-1932,2055-2112,2136-2164`
- Test: `src/lib/miden/transaction/initiate.custom-spending-limit.test.ts`, `src/lib/miden/back/dapp.branches.test.ts`, `dapp.confirm-internals.test.ts`, `dapp.extension.test.ts`, `dapp.send-preview.test.ts`

**Interfaces:**
- Consumes: everything Task 4 produces.
- Produces: no new exports. `customSpendingLimitState(accountId, outgoing)` keeps its name and its `{ totals, details }` shape.

- [ ] **Step 1: Write the failing test**

In `src/lib/miden/back/dapp.branches.test.ts`:

```typescript
it('no longer refuses a custom request that moves two capped assets', async () => {
  mockedResolve.mockResolvedValue(75_000_000n);

  const state = await customSpendingLimitState(ACCOUNT, [
    { faucetId: 'eth', amount: 1n },
    { faucetId: 'usdc', amount: 2n }
  ]);

  expect(state.details?.assessment.usdAmount).toBe(75_000_000n);
});

it('still refuses a custom request whose outgoing value is unknown', async () => {
  await expect(customSpendingLimitState(ACCOUNT, undefined)).rejects.toThrow(MidenDAppErrorType.NotGranted);
});

it('refuses a dApp request when a covered asset has no price', async () => {
  mockedResolve.mockRejectedValue(new SpendingLimitPriceUnavailableError('ETH'));

  await expect(customSpendingLimitState(ACCOUNT, [{ faucetId: 'eth', amount: 1n }])).rejects.toThrow(
    MidenDAppErrorType.NotGranted
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/lib/miden/back/dapp.branches.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `initiate.ts`**

All five call sites keep their shape; only the authorization type changes, so most lines are untouched. At line 65 the custom path already passes `spentAssetTotals` as both the row field and the spend list; leave that, since `spentAssetTotals` remains the audit record of what was priced.

- [ ] **Step 4: Update `dapp.ts`**

`customSpendingLimitState` loses its per-faucet loop and its multi-breach refusal, and gains the price refusal:

```typescript
const customSpendingLimitState = async (
  accountId: string,
  outgoing: IConsumedAssetTotal[] | undefined
): Promise<{ totals: IConsumedAssetTotal[]; details?: SpendingLimitAssessmentDetails }> => {
  if (outgoing === undefined) {
    if (await hasSpendingLimits(accountId)) throw new Error(MidenDAppErrorType.NotGranted);
    return { totals: [] };
  }
  try {
    const details = await assessOutgoingSpendingLimitDetails({ accountId, spends: outgoing });
    return { totals: outgoing, details: details?.assessment.breach === undefined ? undefined : details };
  } catch (error) {
    // A value the wallet cannot establish is the same answer as a value it cannot see: an
    // untrusted page does not get to spend against a cap nobody can check.
    if (error instanceof SpendingLimitPriceUnavailableError) throw new Error(MidenDAppErrorType.NotGranted);
    throw error;
  }
};
```

`dappSendFailure` (line 1669) additionally maps `SPENDING_LIMIT_PRICE_UNAVAILABLE` to the existing `DAPP_SPENDING_LIMIT_RETRY` message. The send pre-assessment at 2055 passes `spends: [{ faucetId, amount }]`. `authorizationForDappSend` reads `details.assessment.breach !== undefined` instead of the array length. The four confirm-flow wiring points at 1823-1932 pass the assessment alone, with no asset snapshot.

- [ ] **Step 5: Run the suites**

Run: `yarn test src/lib/miden/back src/lib/miden/transaction`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/miden/transaction/initiate.ts src/lib/miden/back/dapp.ts
git commit -m "feat(spending-limits): enforce the USD cap on every outgoing path"
```

---

### Task 7: Settings screen

**Files:**
- Modify: `src/app/templates/SpendingLimits.tsx` (342 lines become roughly 170)
- Test: `src/app/templates/SpendingLimits.test.tsx`

**Interfaces:**
- Consumes: store `readSpendingLimit`, `saveSpendingLimit`; `classifySpendingLimitChange`; `StrictActionAuthentication`.
- Produces: `MAX_SPENDING_LIMIT`, `parseUsdLimitInput(value: string): bigint | undefined`, `formatUsdLimitInput(value: bigint): string`, default-exported `SpendingLimits`.

- [ ] **Step 1: Write the failing test**

```typescript
it('renders one dollar input, not a row per asset', async () => {
  renderScreen();

  expect(await screen.findByLabelText('spendingLimitUsdCap')).toBeInTheDocument();
  expect(screen.queryByText('ETH')).not.toBeInTheDocument();
});

it('states that unpriced assets are not covered', async () => {
  renderScreen();

  expect(await screen.findByText('spendingLimitCoverage')).toBeInTheDocument();
});

it('requires strict authentication to raise the cap', async () => { /* enter a larger number, expect the auth component */ });
it('saves a lowered cap without authentication', async () => { /* enter a smaller number, expect onSave with strictlyAuthenticated false */ });
it('rejects an amount with more than two decimal places', async () => { /* expect spendingLimitInvalidAmount */ });
it('clears the cap when the field is emptied, behind authentication', async () => { /* delete branch */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/app/templates/SpendingLimits.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Rewrite the component**

Delete `mergeAssets`, `SpendingLimitAsset`, `SpendingLimitRow` and the `TokenBalanceData` / `hasKnownScale` imports; the screen no longer enumerates assets, so it no longer needs balances at all. Keep `MAX_SPENDING_LIMIT` and rename the codec pair, fixing the scale at two decimals for entry and storing micro-dollars:

```typescript
/** Dollars carry two decimal places on screen and six in storage. */
const USD_INPUT_DECIMALS = 2;
const USD_STORAGE_DECIMALS = 6;

export function parseUsdLimitInput(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new RangeError('Invalid spending limit');
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  if (fraction.length > USD_INPUT_DECIMALS) throw new RangeError('Spending limit exceeds cent precision');
  const scale = 10n ** BigInt(USD_STORAGE_DECIMALS);
  const amount = BigInt(integer) * scale + BigInt(fraction.padEnd(USD_STORAGE_DECIMALS, '0') || '0');
  if (amount <= 0n || amount > MAX_SPENDING_LIMIT) throw new RangeError('Spending limit is out of range');
  return amount;
}
```

Keep the comment explaining why this codec is not routed through `lib/i18n/numbers` verbatim from lines 79-88; the auto-mock reason is unchanged and the next reader will ask again. `formatUsdLimitInput` mirrors it, trimming to at most two decimals.

The screen keeps its load generation guard, its `isCurrent` recheck, its error and loading states, its save flow and the two disclosure paragraphs, and adds a third for coverage. It renders one `Input` with `label={t('spendingLimitUsdCap')}` and `prefix="$"` if `Input` supports a prefix, otherwise `suffix={t('spendingLimitUsd')}`. Root testid `spending-limits-settings` stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/app/templates/SpendingLimits.test.tsx`
Expected: PASS.

- [ ] **Step 5: Read the frontend skill before touching styling**

Read `skills/miden-wallet-frontend/SKILL.md` and check the rewritten markup against it: semantic tokens rather than literal colors, no `dark:` variant on an auto-flipping token, haptics on anything tappable, and the screen verified on extension and mobile widths.

- [ ] **Step 6: Commit**

```bash
git add src/app/templates/SpendingLimits.tsx src/app/templates/SpendingLimits.test.tsx
git commit -m "feat(spending-limits): one dollar cap in settings"
```

---

### Task 8: Challenge drawer and its five mounting surfaces

**Files:**
- Modify: `src/components/SpendingLimitChallenge.tsx`
- Modify: `src/screens/send-flow/ReviewTransaction.tsx:269,305,317,322,343,391-397,539`
- Modify: `src/screens/swap-flow/SwapManager.tsx:269,316,360-366,466`
- Modify: `src/screens/earn-flow/EarnDepositReview.tsx:97,100,125,140-146,182`
- Modify: `src/app/ConfirmPage.tsx:511-519,616,832`
- Modify: `src/app/pages/Browser/DappConfirmationModal.tsx:205,337-344`
- Modify: `src/lib/dapp-browser/confirmation-store.ts:61-62,98`
- Test: the sibling suite of each file above.

**Interfaces:**
- Consumes: `SpendingLimitAssessment`, `createSpendingLimitAuthorization`, `createUnpricedSpendingLimitAuthorization`.
- Produces: `SpendingLimitChallengeProps { assessment?: SpendingLimitAssessment; unpriced?: { accountId: string; spends: IConsumedAssetTotal[]; revision: string }; onResult: (authorization: SpendingLimitAuthorization | undefined) => void; now?: () => number; makeId?: () => string }` - exactly one of `assessment` and `unpriced` is set.

- [ ] **Step 1: Write the failing test**

```typescript
it('renders the dollar figures of a breach', () => {
  render(<SpendingLimitChallenge assessment={breachAssessment()} onResult={jest.fn()} />);

  expect(screen.getByText('$110.00')).toBeInTheDocument();
  expect(screen.getByText('$10.00')).toBeInTheDocument();
});

it('renders the unvalued variant without inventing a figure', () => {
  render(<SpendingLimitChallenge unpriced={unpricedContext()} onResult={jest.fn()} />);

  expect(screen.getByText('spendingLimitPriceUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
});

it('mints a usd authorization from a breach', () => {
  const onResult = jest.fn();
  render(<SpendingLimitChallenge assessment={breachAssessment()} onResult={onResult} now={() => 1_000} makeId={() => 'auth-1'} />);

  fireEvent.click(screen.getByTestId('strict-action-authenticate'));

  expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: 'usd', usdAmount: 110_000_000n }));
});

it('mints an unpriced authorization bound to the spends', () => {
  const onResult = jest.fn();
  render(<SpendingLimitChallenge unpriced={unpricedContext()} onResult={onResult} now={() => 1_000} makeId={() => 'auth-2'} />);

  fireEvent.click(screen.getByTestId('strict-action-authenticate'));

  expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unpriced', spendsDigest: expect.any(String) }));
});

it('returns undefined when the drawer is dismissed', () => {
  const onResult = jest.fn();
  render(<SpendingLimitChallenge assessment={breachAssessment()} onResult={onResult} />);

  fireEvent.click(screen.getByTestId('strict-action-cancel'));

  expect(onResult).toHaveBeenCalledWith(undefined);
});
```

`strict-action-authenticate` and `strict-action-cancel` stand for however this repo already drives
`StrictActionAuthentication`. Read `src/components/SpendingLimitChallenge.test.tsx` as it exists
today and reuse the exact handles its passing cases use, rather than introducing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/components/SpendingLimitChallenge.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Rewrite the drawer**

Drop the `asset` prop and the `formatBigInt(value, asset.decimals)` helper; format micro-dollars with a local helper that divides by `USD_SCALE` and renders two decimals through the existing i18n number formatting used elsewhere for fiat. Replace the `assessment.breaches.map` block with a single breach block, no period heading. Add the unpriced variant: a short explanation, the same `StrictActionAuthentication`, and no numbers. Keep `data-testid="spending-limit-challenge"` on `DrawerContent` - both E2E specs address it by that.

- [ ] **Step 4: Update the five surfaces**

Each drops the `asset` prop. Send, swap and Earn keep their pre-check, their staleness guard and their catch of `SpendingLimitAuthorizationRequiredError`, and add a branch that opens the drawer in its unpriced variant when `isSpendingLimitPriceUnavailable(error)` is true. Use that predicate, never `instanceof`: these catches run in the frontend realm and the error reached them through the intercom port, so its prototype is gone and `instanceof` is always false. The existing `spendingLimitAssessmentFromError` beside them reads `code` for exactly this reason. The two dApp surfaces drop `spendingLimitAsset` from the confirmation payload and keep the invariant at `ConfirmPage.tsx:511-519` in its new one-field form.

- [ ] **Step 5: Run the suites**

Run: `yarn test src/components/SpendingLimitChallenge.test.tsx src/screens/send-flow src/screens/swap-flow src/screens/earn-flow src/app/ConfirmPage.test.tsx src/app/pages/Browser src/lib/desktop src/lib/dapp-browser`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/SpendingLimitChallenge.tsx src/screens src/app/ConfirmPage.tsx src/app/pages/Browser src/lib/dapp-browser
git commit -m "feat(spending-limits): dollar challenge and its approval surfaces"
```

---

### Task 9: Locale keys

**Files:**
- Modify: `public/_locales/en/en.json:1131-1151` and `public/_locales/en/messages.json`
- Modify: the same two files under `de, en_GB, es, fr, ja, ko, pl, pt, ru, tr, uk, zh_CN, zh_TW`

- [ ] **Step 1: Retire the keys the UI no longer renders**

Remove `spendingLimitDaily`, `spendingLimitWeekly`, `spendingLimitPeriod24h`, `spendingLimitPeriod7d`, `spendingLimitUnknownDecimals`, `spendingLimitNoAssets` from all 14 locales, both formats.

- [ ] **Step 2: Add the new keys to English**

```json
"spendingLimitUsdCap": "Daily limit (USD)",
"spendingLimitCoverage": "Only assets the wallet can price count toward this limit. Assets without a price, including MIDEN, are not limited.",
"spendingLimitPriceUnavailable": "This transaction's value cannot be checked right now. Authenticate to send it anyway."
```

- [ ] **Step 3: Mirror the structure into the other 13 locales**

Copy the English strings into every other locale so no key is missing; CI's DeepL job replaces them with real translations on the PR. Do not hand-translate.

- [ ] **Step 4: Run the i18n gate**

Run: `yarn lint:i18n`
Expected: PASS, no literal strings and no missing keys.

- [ ] **Step 5: Commit**

```bash
git add public/_locales
git commit -m "i18n: dollar spending limit copy"
```

---

### Task 10: End-to-end specs, changelog and the full gate run

**Files:**
- Modify: `playwright/e2e/tests/spending-limits.spec.ts`
- Modify: `playwright/e2e/ios/tests/spending-limits.ios.spec.ts`
- Modify: `playwright/e2e/helpers/wallet-page.ts`, `playwright/e2e/ios/helpers/ios-wallet-page.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Re-express the local journey in dollars**

The serial journey keeps its step ORDER exactly - the memory of this spec records that the order is itself the assertion, since the custom-50 step must be counted for the custom-100 step to breach. Convert the 600-of-700 figures to their dollar equivalents at the mocked price the harness uses, and set the policy through the E2E store hook, which now writes one account-scoped record.

- [ ] **Step 2: Update the iOS spec**

It asserts the rendered policy and the challenge. Address the challenge by `data-testid="spending-limit-challenge"`, never by `[data-slot="drawer-content"]` - that matches every sheet in the app and previously read the send flow's token picker.

- [ ] **Step 3: Prove the converted assertions still bite**

For each spec, predict which mutation should break which assertion, write the prediction down, then run the spec against a branch carrying that mutation with `--retries=0`. A retry turns a real failure into a flaky pass and the run still exits 0.

- [ ] **Step 4: Add the changelog line**

Check the latest published tag first:

```bash
gh api repos/0xMiden/wallet/releases/latest --jq .tag_name
```

Add one line under a heading whose version is strictly higher and still marked `(TBD)`, creating that heading if none exists:

```markdown
- Spending limits are now a single daily limit in USD covering all priced assets, replacing the per-token limits.
```

- [ ] **Step 5: Run every gate the repo defines**

```bash
yarn lint
yarn lint:i18n
yarn lint:e2e
yarn check:prover-pin
yarn test
```

Expected: all pass. Coverage is gated in CI at 95%; if `yarn test --coverage` shows the diff below it, add tests rather than lowering the gate.

- [ ] **Step 6: Commit**

```bash
git add playwright CHANGELOG.md
git commit -m "test(spending-limits): dollar journeys end to end"
```

---

## Review

After the last task, run `/review-council:rev` over the branch, apply every actionable finding, re-run the gate list, and only then push and open the PR. The PR body states the current behaviour, not the round-by-round history, and ends with a Reviewers line naming the part worth real attention: the two authorization kinds and the ordering of price resolution against the Dexie write lock.
