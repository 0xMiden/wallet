import { MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';
import { MIDEN_USDC_FAUCET, setEarnCollateralFaucetForTest } from 'lib/epoch/collateral';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
import { isCoveredSymbol } from 'lib/prices/usd';

import {
  allowlistedPriceSymbols,
  deriveRequestAmount,
  getDefaultSwapPair,
  getSwapTokenByFaucetId,
  getSwapEta,
  getSwapTokens,
  getSwapTokenBySymbol,
  normalizedFaucetId,
  priceSymbolFor,
  TOKEN_IBTC,
  TOKEN_IETH,
  TOKEN_IMIDEN,
  TOKEN_IUSDT,
  tokenQuote,
  _resetNormalizedFaucetIdsForTest,
  _setSwapTokensForTest,
  SWAP_TOKEN_DECIMALS,
  SWAP_TOKENS
} from './tokens';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(),
  getNativeAssetMetadataSync: jest.fn()
}));

// Balances key a faucet by the SDK's bech32 form of its id; make that form visibly different. As the
// SDK's re-encode does, an id already in that form maps to itself.
const mockFakeBech32 = (id: unknown): string => {
  const text = String(id);
  return text.startsWith('bech32:') ? text : `bech32:${text}`;
};
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => id,
  accountRefToSdk: (id: string) => id,
  getBech32AddressFromAccountId: jest.fn((id: string) => mockFakeBech32(id))
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: jest.fn(() => 'testnet')
}));

const mockToBech32 = jest.mocked(getBech32AddressFromAccountId);
const mockNetworkName = jest.mocked(getEffectiveNetworkName);

beforeEach(() => {
  _resetNormalizedFaucetIdsForTest();
  mockToBech32.mockReset().mockImplementation(mockFakeBech32);
  mockNetworkName.mockReturnValue('testnet' as any);
});

const mockGetNativeAssetIdSync = jest.mocked(getNativeAssetIdSync);
const mockGetNativeAssetMetadataSync = jest.mocked(getNativeAssetMetadataSync);

// The root `__mocks__/lib/i18n/numbers.ts` manual mock is auto-applied (the
// mapped `lib/…` specifier reads as a package name to jest), and it only stubs
// the three format helpers — `toFixedRoundedDown` would be undefined.
// `deriveRequestAmount` rounds with it, so opt this suite back into the real
// module to test the real truncation.
jest.unmock('lib/i18n/numbers');

describe('swap token registry accessor', () => {
  beforeEach(() => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetNativeAssetMetadataSync.mockReturnValue(null);
  });

  afterEach(() => _setSwapTokensForTest(undefined)); // reset to default

  it('defaults to the built-in registry', () => {
    expect(getSwapTokens().length).toBeGreaterThanOrEqual(4);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeDefined();
  });

  it('prepends the discovered native asset with its on-chain metadata', () => {
    mockGetNativeAssetIdSync.mockReturnValue('mtst1native');
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 });

    expect(getSwapTokens()).toEqual([
      {
        symbol: 'MIDEN',
        faucetId: 'mtst1native',
        decimals: 6,
        logoSymbol: 'MIDEN'
      },
      ...SWAP_TOKENS
    ]);
    expect(getSwapTokenByFaucetId('mtst1native')).toEqual(expect.objectContaining({ symbol: 'MIDEN', decimals: 6 }));
  });

  it('does not duplicate a native asset already present in the built-in registry', () => {
    mockGetNativeAssetIdSync.mockReturnValue(TOKEN_IMIDEN.faucetId);

    expect(getSwapTokens().filter(token => token.faucetId === TOKEN_IMIDEN.faucetId)).toHaveLength(1);
  });

  it('override replaces the registry for all readers', () => {
    const t = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    mockGetNativeAssetIdSync.mockReturnValue('mtst1native');
    _setSwapTokensForTest([t]);
    expect(getSwapTokens()).toEqual([t]);
    expect(getSwapTokenBySymbol('SWPA')).toEqual(t);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeUndefined();
  });
});

describe('swap token price symbols', () => {
  it('prices IETH and IBTC as the ETH and BTC the feed lists', () => {
    expect(TOKEN_IETH.priceSymbol).toBe('ETH');
    expect(TOKEN_IBTC.priceSymbol).toBe('BTC');
  });

  it('leaves IUSDT and IMIDEN unpriced, whatever logo they borrow', () => {
    expect(TOKEN_IUSDT.priceSymbol).toBeUndefined();
    expect(TOKEN_IMIDEN.priceSymbol).toBeUndefined();
  });

  // #1131: a registry token whose priceSymbol the feed does not quote would drift the spending
  // cap into counting every spend of that faucet as uncovered ($0); this catches it at CI time.
  it('quotes every allowlisted price symbol, including ETH, BTC and USDC', () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);

    const symbols = allowlistedPriceSymbols();

    expect(symbols).toEqual(expect.arrayContaining(['ETH', 'BTC', 'USDC']));
    symbols.forEach(symbol => expect(isCoveredSymbol(symbol)).toBe(true));
  });
});

describe('priceSymbolFor', () => {
  beforeEach(() => mockGetNativeAssetIdSync.mockReturnValue(null));

  // #1131: every faucet the wallet knows stands for a quoted asset resolves a price symbol, so none of
  // them silently drops out of spending-limit coverage.
  it.each([
    ['IETH', TOKEN_IETH.faucetId, 'ETH'],
    ['IBTC', TOKEN_IBTC.faucetId, 'BTC'],
    ['the Earn collateral USDC', MIDEN_USDC_FAUCET, 'USDC'],
    ['the Agglayer-bridged ETH', MIDEN_AGGLAYER_FAUCET_ID, 'ETH']
  ])('prices %s under either id encoding', (_name, faucetId, priceSymbol) => {
    expect(priceSymbolFor(faucetId, 'ANY')).toBe(priceSymbol);
    expect(priceSymbolFor(`bech32:${faucetId}`, 'ANY')).toBe(priceSymbol);
  });

  it('matches a faucet spelled in another encoding than the allowlist entry (hex against bech32)', () => {
    // Both spellings canonicalize to one id, the way the SDK maps a hex id and its bech32 form.
    mockToBech32.mockImplementation((id: any) =>
      id === '0xiethhex' || id === TOKEN_IETH.faucetId ? 'canonical-ieth' : `bech32:${id}`
    );
    expect(priceSymbolFor('0xiethhex', 'IETH')).toBe('ETH');
  });

  it('follows the Earn collateral faucet an E2E run injects', () => {
    setEarnCollateralFaucetForTest('0xe2ecollateral');
    try {
      expect(priceSymbolFor('0xe2ecollateral', 'USDC')).toBe('USDC');
      expect(priceSymbolFor(MIDEN_USDC_FAUCET, 'USDC')).toBeUndefined();
    } finally {
      setEarnCollateralFaucetForTest(undefined);
    }
  });

  it('gives no price symbol to any other faucet, whatever symbol it gives itself', () => {
    expect(priceSymbolFor('mtst1other', 'USDC')).toBeUndefined();
    expect(priceSymbolFor('mtst1other', 'ETH')).toBeUndefined();
    expect(priceSymbolFor('mtst1other', 'BTC')).toBeUndefined();
    expect(priceSymbolFor('mtst1other', 'IETH')).toBeUndefined();
    expect(priceSymbolFor(TOKEN_IUSDT.faucetId, 'IUSDT')).toBeUndefined();
    expect(priceSymbolFor(`bech32:${TOKEN_IMIDEN.faucetId}`, 'IMIDEN')).toBeUndefined();
  });

  it('prices the E2E fixture symbol TST by symbol only in an E2E build', () => {
    const previous = process.env.MIDEN_E2E_TEST;
    try {
      process.env.MIDEN_E2E_TEST = 'true';
      expect(priceSymbolFor('mtst1fixture', 'TST')).toBe('TST');
      expect(priceSymbolFor('mtst1fixture', 'USDC')).toBeUndefined();
      delete process.env.MIDEN_E2E_TEST;
      expect(priceSymbolFor('mtst1fixture', 'TST')).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = previous;
    }
  });
});

describe('tokenQuote', () => {
  beforeEach(() => mockGetNativeAssetIdSync.mockReturnValue(null));
  const eth = { price: 3000, change24h: 40, percentageChange24h: 1.2 };

  it('quotes a registry token under its price symbol, IETH at ETH', () => {
    expect(tokenQuote({ ETH: eth }, TOKEN_IETH.faucetId, 'IETH')).toEqual({
      price: 3000,
      change24h: 40,
      percentageChange24h: 1.2
    });
  });

  it('gives no quote to an unknown faucet, or to a token without a faucet id, whatever its symbol', () => {
    expect(tokenQuote({ ETH: eth }, 'mtst1other', 'ETH')).toBeUndefined();
    expect(tokenQuote({ ETH: eth }, undefined, 'ETH')).toBeUndefined();
    expect(tokenQuote({ ETH: eth }, undefined, 'IETH')).toBeUndefined();
  });

  it('gives no quote for a zero price', () => {
    expect(
      tokenQuote({ ETH: { price: 0, change24h: 0, percentageChange24h: 0 } }, TOKEN_IETH.faucetId, 'IETH')
    ).toBeUndefined();
  });
});

describe('normalizedFaucetId', () => {
  it('converts an id once per network', () => {
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(`bech32:${TOKEN_IETH.faucetId}`);
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(`bech32:${TOKEN_IETH.faucetId}`);
    expect(mockToBech32).toHaveBeenCalledTimes(1);
  });

  it('converts again on another network and reuses the first result on returning to it', () => {
    mockToBech32.mockImplementation((id: any) => `${mockNetworkName()}:${id}`);
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(`testnet:${TOKEN_IETH.faucetId}`);
    mockNetworkName.mockReturnValue('devnet' as any);
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(`devnet:${TOKEN_IETH.faucetId}`);
    mockNetworkName.mockReturnValue('testnet' as any);
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(`testnet:${TOKEN_IETH.faucetId}`);
    expect(mockToBech32).toHaveBeenCalledTimes(2);
  });

  it('keeps an id the SDK cannot parse yet as it is, and tries it again later', () => {
    mockToBech32.mockImplementationOnce(() => {
      throw new Error('wasm not ready');
    });
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(TOKEN_IETH.faucetId);
    expect(normalizedFaucetId(TOKEN_IETH.faucetId)).toBe(`bech32:${TOKEN_IETH.faucetId}`);
  });
});

describe('getSwapTokenByFaucetId', () => {
  afterEach(() => _setSwapTokensForTest(undefined));

  it('resolves a registry token by faucet id', () => {
    expect(getSwapTokenByFaucetId(TOKEN_IMIDEN.faucetId)).toEqual(TOKEN_IMIDEN);
  });

  it('returns undefined for an unknown faucet id', () => {
    expect(getSwapTokenByFaucetId('mtst1unknown')).toBeUndefined();
  });

  it('returns undefined when no faucet id is supplied', () => {
    expect(getSwapTokenByFaucetId(undefined)).toBeUndefined();
    expect(getSwapTokenByFaucetId('')).toBeUndefined();
  });

  it('reads through the overridden registry', () => {
    const token = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    _setSwapTokensForTest([token]);
    expect(getSwapTokenByFaucetId('mtst1local')).toEqual(token);
    expect(getSwapTokenByFaucetId(TOKEN_IMIDEN.faucetId)).toBeUndefined();
  });
});

describe('deriveRequestAmount', () => {
  it('discounts the fair quote by the solver margin', () => {
    // 10 offered * 2 per offered = 20 fair, less 5% => 19.
    expect(deriveRequestAmount('10', '2', SWAP_TOKEN_DECIMALS)).toBe('19');
  });

  it('rounds down to the requested token precision', () => {
    // 1 * 1 * 0.95 = 0.95, truncated to 1 decimal => 0.9.
    expect(deriveRequestAmount('1', '1', 1)).toBe('0.9');
  });

  it('returns empty for a missing or unusable offered amount', () => {
    expect(deriveRequestAmount('', '2', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('0', '2', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('abc', '2', SWAP_TOKEN_DECIMALS)).toBe('');
  });

  it('returns empty for a missing or non-finite rate', () => {
    expect(deriveRequestAmount('10', undefined, SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', '0', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', 'not-a-rate', SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', 'Infinity', SWAP_TOKEN_DECIMALS)).toBe('');
  });

  it('returns empty when the quote rounds away to zero at the token precision', () => {
    expect(deriveRequestAmount('0.0001', '0.0001', 2)).toBe('');
  });

  it('returns empty when the fair quote is non-positive', () => {
    // A negative offered amount is truthy (passes the earlier `!offered` guard)
    // but produces a negative quote, so the `quote <= 0` guard returns ''.
    expect(deriveRequestAmount('-5', '2', SWAP_TOKEN_DECIMALS)).toBe('');
  });
});

describe('getDefaultSwapPair', () => {
  it('picks the same pair whether or not native discovery has landed', () => {
    _setSwapTokensForTest(undefined);

    // Cold start: discovery has not populated the synchronous cache yet.
    mockGetNativeAssetIdSync.mockReturnValue(null);
    const cold = getDefaultSwapPair();

    // Warm start: the discovered native asset is now FIRST in the list, which
    // is what made an index-based default flip between the two.
    mockGetNativeAssetIdSync.mockReturnValue('0xnative');
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 } as never);
    const warm = getDefaultSwapPair();

    expect(getSwapTokens()[0]!.faucetId).toBe('0xnative');
    expect(warm.offer.symbol).toBe(cold.offer.symbol);
    expect(warm.request.symbol).toBe(cold.request.symbol);
    expect(warm.offer.symbol).not.toBe(warm.request.symbol);
  });
});

describe('getSwapEta', () => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

  afterEach(() => {
    jest.useRealTimers();
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  });

  it('bounds the quote body read too, rejecting once the 10 s timeout passes', async () => {
    jest.useFakeTimers();
    // Headers arrive, then a body that ends only when the request's signal aborts, as a real stream does.
    let signal: AbortSignal | undefined;
    const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const given = init.signal ?? undefined;
      signal = given;
      const json = () =>
        new Promise((_resolve, reject) => given?.addEventListener('abort', () => reject(given.reason)));
      return { ok: true, status: 200, json };
    });
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });
    const quote: { outcome: unknown } = { outcome: 'pending' };
    void getSwapEta(TOKEN_IMIDEN, 1n, TOKEN_IUSDT, 0n).then(
      () => {
        quote.outcome = 'resolved';
      },
      (error: unknown) => {
        quote.outcome = error;
      }
    );

    await jest.advanceTimersByTimeAsync(9_999);
    expect(quote.outcome).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);

    expect(quote.outcome).toBe(signal?.reason);
  });
});
