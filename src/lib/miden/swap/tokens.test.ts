import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

import {
  deriveRequestAmount,
  getDefaultSwapPair,
  getSwapTokenByFaucetId,
  getSwapTokens,
  getSwapTokenBySymbol,
  normalizedFaucetId,
  priceSymbolFor,
  TOKEN_IBTC,
  TOKEN_IETH,
  TOKEN_IMIDEN,
  TOKEN_IUSDT,
  _resetNormalizedFaucetIdsForTest,
  _setSwapTokensForTest,
  SWAP_TOKEN_DECIMALS,
  SWAP_TOKENS
} from './tokens';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(),
  getNativeAssetMetadataSync: jest.fn()
}));

// Balances key a faucet by the SDK's bech32 form of its id; make that form visibly different.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => id,
  getBech32AddressFromAccountId: jest.fn((id: string) => `bech32:${id}`)
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: jest.fn(() => 'testnet')
}));

const mockToBech32 = jest.mocked(getBech32AddressFromAccountId);
const mockNetworkName = jest.mocked(getEffectiveNetworkName);

beforeEach(() => {
  _resetNormalizedFaucetIdsForTest();
  mockToBech32.mockReset().mockImplementation((id: any) => `bech32:${id}`);
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
});

describe('priceSymbolFor', () => {
  beforeEach(() => mockGetNativeAssetIdSync.mockReturnValue(null));

  it('prices IETH and IBTC as ETH and BTC under either id encoding', () => {
    expect(priceSymbolFor(TOKEN_IETH.faucetId, 'IETH')).toBe('ETH');
    expect(priceSymbolFor(`bech32:${TOKEN_IETH.faucetId}`, 'IETH')).toBe('ETH');
    expect(priceSymbolFor(TOKEN_IBTC.faucetId, 'IBTC')).toBe('BTC');
    expect(priceSymbolFor(`bech32:${TOKEN_IBTC.faucetId}`, 'IBTC')).toBe('BTC');
  });

  it('leaves IUSDT, IMIDEN and a non-swap token on their own symbol', () => {
    expect(priceSymbolFor(TOKEN_IUSDT.faucetId, 'IUSDT')).toBe('IUSDT');
    expect(priceSymbolFor(`bech32:${TOKEN_IMIDEN.faucetId}`, 'IMIDEN')).toBe('IMIDEN');
    expect(priceSymbolFor('mtst1other', 'ETH')).toBe('ETH');
  });

  it('converts each registry id once across calls', () => {
    priceSymbolFor('mtst1other', 'ETH');
    priceSymbolFor('mtst1another', 'BTC');
    expect(mockToBech32).toHaveBeenCalledTimes(getSwapTokens().length);
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
