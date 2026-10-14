import {
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET as MIDEN_AGGLAYER_FAUCET_ID
} from 'lib/epoch/testing/bridge-config';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
import { isCoveredSymbol } from 'lib/prices/usd';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { bridgePriceAllowlist } from './bridge-price-allowlist';
import {
  TEST_SWAP_TOKEN_CONFIG,
  TEST_SWAP_TOKEN_DECIMALS,
  TEST_SWAP_TOKENS,
  TEST_TOKEN_IBTC,
  TEST_TOKEN_IETH,
  TEST_TOKEN_IMIDEN,
  TEST_TOKEN_IUSDT
} from './testing/registry';
import {
  canonicalFaucetId,
  deriveRequestAmount,
  getDefaultSwapPair,
  getSwapTokenByFaucetId,
  getSwapEta,
  getSwapTokens,
  getSwapTokenBySymbol,
  normalizedFaucetId,
  priceSymbolFor,
  strictPriceSymbolFor,
  SwapEtaUnavailableError,
  tokenQuote,
  _allowlistedPriceSymbolsForTest,
  _resetNormalizedFaucetIdsForTest,
  _setSwapTokensForTest
} from './tokens';

// The bridged price entries: the testnet config's by default (the manual mock's answer), and others a test sets.
jest.mock('./bridge-price-allowlist', () => ({ bridgePriceAllowlist: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(),
  getNativeAssetMetadataSync: jest.fn(),
  getSdkSyncedNativeAssetIdSync: jest.fn()
}));
// The registry reads the document this realm has loaded; each suite below says which.
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));

const UNLOADED: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
const NO_DOCUMENT: BridgeConfigSnapshot = { ...UNLOADED, status: 'ready' };
/** The testnet document, with its four swap tokens and nothing else the registry reads. */
const LOADED: BridgeConfigSnapshot = {
  ...NO_DOCUMENT,
  config: {
    network: 'testnet',
    version: 3,
    evm: {},
    agglayer: {},
    epoch: {},
    features: { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false },
    swap: { tokens: TEST_SWAP_TOKEN_CONFIG, etaUrl: 'https://quotes.example' }
  }
};
const mockSnapshot = jest.mocked(getBridgeConfigSnapshot);

// The document spells each faucet in hex and the fixtures in bech32: the fake SDK below maps one to the other.
const mockBech32ByHex = new Map(
  TEST_SWAP_TOKEN_CONFIG.map((token, i) => [token.faucetId, TEST_SWAP_TOKENS[i]!.faucetId])
);

// Balances key a faucet by the SDK's bech32 form of its id, whose prefix names the network; make that
// form visibly different. As the SDK's re-encode does, an id in any network's form re-encodes under
// the current network, so an id already in the current form maps to itself.
const mockFakeBech32 = (id: unknown): string => {
  const bare = String(id).replace(/^\w+:/, '');
  return `${getEffectiveNetworkName()}:${mockBech32ByHex.get(bare) ?? bare}`;
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
  jest
    .mocked(bridgePriceAllowlist)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof import('./__mocks__/bridge-price-allowlist')>('./__mocks__/bridge-price-allowlist')
        .bridgePriceAllowlist
    );
  mockToBech32.mockReset().mockImplementation(mockFakeBech32);
  mockNetworkName.mockReturnValue('testnet' as any);
  mockSnapshot.mockReturnValue(LOADED);
});

/** The canonical id the fake SDK gives a fixture's faucet. */
const canonical = (faucetId: string) => `testnet:${faucetId}`;

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

  // The document's entries, each faucet in the SDK's form, each logo as named, each price symbol as given.
  const listed = TEST_SWAP_TOKENS.map(token => ({ ...token, faucetId: canonical(token.faucetId) }));

  it("reads the document's tokens in its order, with each faucet in the SDK's form", () => {
    expect(getSwapTokens()).toEqual(listed);
    expect(getSwapTokenBySymbol('IMIDEN')).toEqual(listed[0]);
    expect(getSwapTokenBySymbol('IBTC')?.priceSymbol).toBe('BTC');
    expect(getSwapTokenBySymbol('IUSDT')?.priceSymbol).toBeUndefined();
  });

  it('carries a listed hex faucet as it is until the SDK can convert it, then in its bech32 form', () => {
    mockToBech32.mockImplementation(() => {
      throw new Error('wasm not ready');
    });
    expect(getSwapTokenBySymbol('IETH')?.faucetId).toBe('0xe33498f1176661512b5ac4ded86ec7');
    mockToBech32.mockImplementation(mockFakeBech32);
    expect(getSwapTokenBySymbol('IETH')?.faucetId).toBe(canonical(TEST_TOKEN_IETH.faucetId));
  });

  it('draws a token with no logo named under its own symbol, and a token with one under that mark', () => {
    mockSnapshot.mockReturnValue({
      ...LOADED,
      config: {
        ...LOADED.config!,
        swap: {
          tokens: [
            { symbol: 'IABC', faucetId: '0x0000000000000000000000000000ab', decimals: 8 },
            { ...TEST_SWAP_TOKEN_CONFIG[1]! }
          ]
        }
      }
    });
    expect(getSwapTokens().map(token => token.logoSymbol)).toEqual(['IABC', 'ETH']);
  });

  it.each([
    ['the document is still loading', UNLOADED],
    ['no document is accepted', NO_DOCUMENT],
    ['the document lists no swap tokens', { ...LOADED, config: { ...LOADED.config!, swap: { tokens: [] } } }],
    ['the document predates the swap section', { ...LOADED, config: { ...LOADED.config!, swap: undefined } }]
  ])('has no tokens while %s', (_name, snapshot) => {
    mockSnapshot.mockReturnValue(snapshot);
    expect(getSwapTokens()).toEqual([]);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeUndefined();
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
      ...listed
    ]);
    expect(getSwapTokenByFaucetId('mtst1native')).toEqual(expect.objectContaining({ symbol: 'MIDEN', decimals: 6 }));
  });

  it('does not duplicate a native asset the document already lists, in either spelling', () => {
    mockGetNativeAssetIdSync.mockReturnValue(TEST_TOKEN_IMIDEN.faucetId);
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'IMIDEN', decimals: 8 });
    expect(getSwapTokens().filter(token => token.symbol === 'IMIDEN')).toHaveLength(1);

    mockGetNativeAssetIdSync.mockReturnValue(TEST_SWAP_TOKEN_CONFIG[0]!.faucetId);
    expect(getSwapTokens().filter(token => token.symbol === 'IMIDEN')).toHaveLength(1);
  });

  it('withholds the native swap entry until its scale is authoritative', () => {
    mockGetNativeAssetIdSync.mockReturnValue('mtst1native');
    expect(getSwapTokens()).toEqual(listed);
  });

  it('override replaces the registry for all readers', () => {
    const t = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: TEST_SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    mockGetNativeAssetIdSync.mockReturnValue('mtst1native');
    _setSwapTokensForTest([t]);
    expect(getSwapTokens()).toEqual([t]);
    expect(getSwapTokenBySymbol('SWPA')).toEqual(t);
    expect(getSwapTokenBySymbol('IMIDEN')).toBeUndefined();
  });
});

describe('swap token price symbols', () => {
  it('prices IETH and IBTC as the ETH and BTC the feed lists', () => {
    expect(getSwapTokenBySymbol('IETH')?.priceSymbol).toBe('ETH');
    expect(getSwapTokenBySymbol('IBTC')?.priceSymbol).toBe('BTC');
  });

  it('leaves IUSDT and IMIDEN unpriced, whatever logo they borrow', () => {
    expect(getSwapTokenBySymbol('IUSDT')).toEqual(
      expect.objectContaining({ symbol: 'IUSDT', faucetId: canonical(TEST_TOKEN_IUSDT.faucetId) })
    );
    expect(getSwapTokenBySymbol('IMIDEN')).toEqual(
      expect.objectContaining({ symbol: 'IMIDEN', faucetId: canonical(TEST_TOKEN_IMIDEN.faucetId) })
    );
    expect(getSwapTokenBySymbol('IUSDT')?.priceSymbol).toBeUndefined();
    expect(getSwapTokenBySymbol('IMIDEN')?.priceSymbol).toBeUndefined();
  });

  // #1131: a registry token whose priceSymbol the feed does not quote would make the spending cap
  // refuse every spend of that faucet and leave display surfaces with no price for it; this
  // catches it at CI time.
  it('quotes every allowlisted price symbol, including ETH, BTC and USDC', () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);

    const symbols = _allowlistedPriceSymbolsForTest();

    expect(symbols).toEqual(expect.arrayContaining(['ETH', 'BTC', 'USDC']));
    symbols.forEach(symbol => expect(isCoveredSymbol(symbol)).toBe(true));
  });
});

describe('priceSymbolFor', () => {
  beforeEach(() => mockGetNativeAssetIdSync.mockReturnValue(null));

  // #1131: every faucet the wallet knows stands for a quoted asset resolves a price symbol, so none of
  // them silently drops out of spending-limit coverage.
  it.each([
    ['IETH', TEST_TOKEN_IETH.faucetId, 'ETH'],
    ['IBTC', TEST_TOKEN_IBTC.faucetId, 'BTC'],
    ['the Earn collateral USDC', MIDEN_USDC_FAUCET, 'USDC'],
    ['the Agglayer-bridged ETH', MIDEN_AGGLAYER_FAUCET_ID, 'ETH']
  ])('prices %s under either id encoding', (_name, faucetId, priceSymbol) => {
    expect(priceSymbolFor(faucetId, 'ANY')).toBe(priceSymbol);
    expect(priceSymbolFor(`testnet:${faucetId}`, 'ANY')).toBe(priceSymbol);
  });

  it('matches a faucet spelled in another encoding than the allowlist entry (hex against bech32)', () => {
    // Both spellings canonicalize to one id, the way the SDK maps a hex id and its bech32 form.
    // Every spelling of iETH, the canonical one included: the SDK re-encodes its own form to itself.
    const iethSpellings = [
      '0xiethhex',
      TEST_TOKEN_IETH.faucetId,
      TEST_SWAP_TOKEN_CONFIG[1]!.faucetId,
      'canonical-ieth'
    ];
    mockToBech32.mockImplementation((id: any) => (iethSpellings.includes(id) ? 'canonical-ieth' : `bech32:${id}`));
    expect(priceSymbolFor('0xiethhex', 'IETH')).toBe('ETH');
  });

  it('prices the bridged faucets the bridge config names, and no compiled one', () => {
    jest.mocked(bridgePriceAllowlist).mockReturnValueOnce([{ faucetId: '0xe2ecollateral', priceSymbol: 'USDC' }]);
    expect(priceSymbolFor('0xe2ecollateral', 'USDC')).toBe('USDC');
    jest.mocked(bridgePriceAllowlist).mockReturnValueOnce([]);
    expect(priceSymbolFor(MIDEN_USDC_FAUCET, 'USDC')).toBeUndefined();
    jest.mocked(bridgePriceAllowlist).mockReturnValueOnce([]);
    expect(priceSymbolFor(MIDEN_AGGLAYER_FAUCET_ID, 'ETH')).toBeUndefined();
  });

  it('gives no price symbol to any other faucet, whatever symbol it gives itself', () => {
    expect(priceSymbolFor('mtst1other', 'USDC')).toBeUndefined();
    expect(priceSymbolFor('mtst1other', 'ETH')).toBeUndefined();
    expect(priceSymbolFor('mtst1other', 'BTC')).toBeUndefined();
    expect(priceSymbolFor('mtst1other', 'IETH')).toBeUndefined();
    expect(priceSymbolFor(TEST_TOKEN_IUSDT.faucetId, 'IUSDT')).toBeUndefined();
    expect(priceSymbolFor(`testnet:${TEST_TOKEN_IMIDEN.faucetId}`, 'IMIDEN')).toBeUndefined();
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

describe('strictPriceSymbolFor', () => {
  beforeEach(() => mockGetNativeAssetIdSync.mockReturnValue(null));
  const parseError = new Error('cannot parse the USDC entry');
  const usdcEntryFailsToParse = () =>
    mockToBech32.mockImplementation((id: any) => {
      if (id === MIDEN_USDC_FAUCET) throw parseError;
      return mockFakeBech32(id);
    });

  it('prices a canonical IETH id at ETH', () => {
    expect(strictPriceSymbolFor(canonicalFaucetId(TEST_TOKEN_IETH.faucetId), 'IETH')).toBe('ETH');
  });

  // #1131 F-006: the cap canonicalizes a spend before its metadata await; a network switch during
  // that await must not leave the spend spelled for the old network while the entries re-encode.
  it('matches an id canonicalized before a network switch against the entries as the new network spells them', () => {
    const spend = canonicalFaucetId(TEST_TOKEN_IETH.faucetId);
    mockNetworkName.mockReturnValue('devnet' as any);
    expect(strictPriceSymbolFor(spend, 'IETH')).toBe(TEST_TOKEN_IETH.priceSymbol);
  });

  it('throws when an allowlist entry it compares cannot be parsed, rather than missing the match', () => {
    usdcEntryFailsToParse();
    expect(() => strictPriceSymbolFor(`testnet:${MIDEN_USDC_FAUCET}`, 'USDC')).toThrow(parseError);
  });

  // #1131 F-009: the spend side must throw on an id it cannot parse the same way an entry does -
  // a lenient fallback there would count an unidentifiable spend as an uncovered $0 instead of
  // refusing it.
  it('throws when the spend id itself cannot be parsed, rather than matching nothing', () => {
    const spendId = '0xspendonly';
    const spendParseError = new Error('cannot parse the spend id');
    mockToBech32.mockImplementation((id: any) => {
      if (id === spendId) throw spendParseError;
      return mockFakeBech32(id);
    });
    expect(() => strictPriceSymbolFor(spendId, 'IETH')).toThrow(spendParseError);
  });

  it('leaves the display match lenient: the same entry failure gives no price instead of throwing', () => {
    usdcEntryFailsToParse();
    const usdc = { price: 1, change24h: 0, percentageChange24h: 0 };
    expect(priceSymbolFor(`testnet:${MIDEN_USDC_FAUCET}`, 'USDC')).toBeUndefined();
    expect(tokenQuote({ USDC: usdc }, `testnet:${MIDEN_USDC_FAUCET}`, 'USDC')).toBeUndefined();
  });
});

describe('tokenQuote', () => {
  beforeEach(() => mockGetNativeAssetIdSync.mockReturnValue(null));
  const eth = { price: 3000, change24h: 40, percentageChange24h: 1.2 };

  it('quotes a registry token under its price symbol, IETH at ETH', () => {
    expect(tokenQuote({ ETH: eth }, TEST_TOKEN_IETH.faucetId, 'IETH')).toEqual({
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
      tokenQuote({ ETH: { price: 0, change24h: 0, percentageChange24h: 0 } }, TEST_TOKEN_IETH.faucetId, 'IETH')
    ).toBeUndefined();
  });
});

describe('canonicalFaucetId', () => {
  it("returns the SDK's form of an id", () => {
    expect(canonicalFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
  });

  it('throws when the SDK cannot parse the id, and caches nothing', () => {
    const parseError = new Error('wasm not ready');
    mockToBech32.mockImplementationOnce(() => {
      throw parseError;
    });
    expect(() => canonicalFaucetId(TEST_TOKEN_IETH.faucetId)).toThrow(parseError);
    expect(canonicalFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
    expect(canonicalFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
    expect(mockToBech32).toHaveBeenCalledTimes(2);
  });
});

describe('normalizedFaucetId', () => {
  it('converts an id once per network', () => {
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
    expect(mockToBech32).toHaveBeenCalledTimes(1);
  });

  it('converts again on another network and reuses the first result on returning to it', () => {
    mockToBech32.mockImplementation((id: any) => `${mockNetworkName()}:${id}`);
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
    mockNetworkName.mockReturnValue('devnet' as any);
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`devnet:${TEST_TOKEN_IETH.faucetId}`);
    mockNetworkName.mockReturnValue('testnet' as any);
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
    expect(mockToBech32).toHaveBeenCalledTimes(2);
  });

  it('keeps an id the SDK cannot parse yet as it is, and tries it again later', () => {
    mockToBech32.mockImplementationOnce(() => {
      throw new Error('wasm not ready');
    });
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(TEST_TOKEN_IETH.faucetId);
    expect(normalizedFaucetId(TEST_TOKEN_IETH.faucetId)).toBe(`testnet:${TEST_TOKEN_IETH.faucetId}`);
  });
});

describe('getSwapTokenByFaucetId', () => {
  afterEach(() => _setSwapTokensForTest(undefined));

  it("resolves a registry token by faucet id in any spelling: a row's bech32, the document's hex", () => {
    const expected = { ...TEST_TOKEN_IMIDEN, faucetId: canonical(TEST_TOKEN_IMIDEN.faucetId) };
    expect(getSwapTokenByFaucetId(TEST_TOKEN_IMIDEN.faucetId)).toEqual(expected);
    expect(getSwapTokenByFaucetId(canonical(TEST_TOKEN_IMIDEN.faucetId))).toEqual(expected);
    expect(getSwapTokenByFaucetId(TEST_SWAP_TOKEN_CONFIG[0]!.faucetId)).toEqual(expected);
  });

  it('returns undefined for an unknown faucet id', () => {
    expect(getSwapTokenByFaucetId('mtst1unknown')).toBeUndefined();
  });

  it('returns undefined when no faucet id is supplied', () => {
    expect(getSwapTokenByFaucetId(undefined)).toBeUndefined();
    expect(getSwapTokenByFaucetId('')).toBeUndefined();
  });

  it('reads through the overridden registry', () => {
    const token = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: TEST_SWAP_TOKEN_DECIMALS, logoSymbol: 'MIDEN' };
    _setSwapTokensForTest([token]);
    expect(getSwapTokenByFaucetId('mtst1local')).toEqual(token);
    expect(getSwapTokenByFaucetId(TEST_TOKEN_IMIDEN.faucetId)).toBeUndefined();
  });
});

describe('deriveRequestAmount', () => {
  it('discounts the fair quote by the solver margin', () => {
    // 10 offered * 2 per offered = 20 fair, less 5% => 19.
    expect(deriveRequestAmount('10', '2', TEST_SWAP_TOKEN_DECIMALS)).toBe('19');
  });

  it('rounds down to the requested token precision', () => {
    // 1 * 1 * 0.95 = 0.95, truncated to 1 decimal => 0.9.
    expect(deriveRequestAmount('1', '1', 1)).toBe('0.9');
  });

  it.each([
    ['11', '1', '10'],
    ['200', '1', '190'],
    ['2000', '1', '1900']
  ])('preserves significant integer zeros for offer %s at zero decimals', (offer, rate, expected) => {
    expect(deriveRequestAmount(offer, rate, 0)).toBe(expected);
  });

  it('returns empty for a missing or unusable offered amount', () => {
    expect(deriveRequestAmount('', '2', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('0', '2', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('abc', '2', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
  });

  it('returns empty for a missing or non-finite rate', () => {
    expect(deriveRequestAmount('10', null, TEST_SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', undefined, TEST_SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', '0', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', 'not-a-rate', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
    expect(deriveRequestAmount('10', 'Infinity', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
  });

  it('returns empty when the quote rounds away to zero at the token precision', () => {
    expect(deriveRequestAmount('0.0001', '0.0001', 2)).toBe('');
  });

  it('returns empty when the fair quote is non-positive', () => {
    // A negative offered amount is truthy (passes the earlier `!offered` guard)
    // but produces a negative quote, so the `quote <= 0` guard returns ''.
    expect(deriveRequestAmount('-5', '2', TEST_SWAP_TOKEN_DECIMALS)).toBe('');
  });
});

describe('getDefaultSwapPair', () => {
  afterEach(() => _setSwapTokensForTest(undefined));

  it("opens on the document's first two tokens whether or not native discovery has landed", () => {
    mockSnapshot.mockReturnValue({
      ...LOADED,
      config: {
        ...LOADED.config!,
        swap: {
          tokens: [TEST_SWAP_TOKEN_CONFIG[3]!, TEST_SWAP_TOKEN_CONFIG[2]!, ...TEST_SWAP_TOKEN_CONFIG.slice(0, 2)]
        }
      }
    });
    // Cold start: discovery has not populated the synchronous cache yet.
    mockGetNativeAssetIdSync.mockReturnValue(null);
    const cold = getDefaultSwapPair();

    // Warm start: the discovered native asset is now FIRST in the list, which
    // is what made an index-based default flip between the two.
    mockGetNativeAssetIdSync.mockReturnValue('0xnative');
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
    const warm = getDefaultSwapPair();

    expect(getSwapTokens()[0]!.faucetId).toBe('0xnative');
    expect(cold).toEqual({
      offer: expect.objectContaining({ symbol: 'IBTC', faucetId: canonical(TEST_TOKEN_IBTC.faucetId) }),
      request: expect.objectContaining({ symbol: 'IUSDT', faucetId: canonical(TEST_TOKEN_IUSDT.faucetId) })
    });
    expect(warm).toEqual(cold);
  });

  it('has no pair while the document lists fewer than two tokens', () => {
    mockSnapshot.mockReturnValue(UNLOADED);
    expect(getDefaultSwapPair()).toBeNull();
    mockSnapshot.mockReturnValue({
      ...LOADED,
      config: { ...LOADED.config!, swap: { tokens: [TEST_SWAP_TOKEN_CONFIG[0]!] } }
    });
    expect(getDefaultSwapPair()).toBeNull();
  });

  it("opens on an override's first two tokens", () => {
    _setSwapTokensForTest([TEST_TOKEN_IBTC, TEST_TOKEN_IUSDT]);
    expect(getDefaultSwapPair()).toEqual({ offer: TEST_TOKEN_IBTC, request: TEST_TOKEN_IUSDT });
  });
});

describe('getSwapEta', () => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

  it('asks the quote service the document names, and none while the document names no service', async () => {
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ canFill: true })
    }));
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });
    await expect(getSwapEta(TEST_TOKEN_IMIDEN, 1n, TEST_TOKEN_IUSDT, 0n)).resolves.toEqual({ canFill: true });
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^https:\/\/quotes\.example\/v1\/swap-eta\?offered_faucet=/);

    mockSnapshot.mockReturnValue({
      ...LOADED,
      config: { ...LOADED.config!, swap: { tokens: TEST_SWAP_TOKEN_CONFIG } }
    });
    await expect(getSwapEta(TEST_TOKEN_IMIDEN, 1n, TEST_TOKEN_IUSDT, 0n)).rejects.toBeInstanceOf(
      SwapEtaUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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
    void getSwapEta(TEST_TOKEN_IMIDEN, 1n, TEST_TOKEN_IUSDT, 0n).then(
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

describe('SDK-confirmed native stablecoin pricing', () => {
  beforeEach(() => {
    mockGetNativeAssetIdSync.mockReturnValue('testnet:0xfee');
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.requireMock('lib/miden-chain/native-asset').getSdkSyncedNativeAssetIdSync.mockReturnValue('0xfee');
  });
  it('prices the confirmed native faucet through either canonical spelling', () => {
    expect(priceSymbolFor('0xfee', 'USDCX')).toBe('USDCX');
    expect(tokenQuote({}, 'testnet:0xfee', 'USDCX')).toEqual({ price: 1, change24h: 0, percentageChange24h: 0 });
  });
  it('does not price a copied symbol or an arbitrary configured native override', () => {
    expect(tokenQuote({}, 'other-faucet', 'USDCX')).toBeUndefined();
    mockGetNativeAssetIdSync.mockReturnValue('override-faucet');
    expect(tokenQuote({}, 'override-faucet', 'USDCX')).toBeUndefined();
  });
  it('quotes the native USDCX unit independently of scale and respects a different chain symbol', () => {
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true });
    expect(tokenQuote({}, '0xfee', 'USDCX')).toEqual({ price: 1, change24h: 0, percentageChange24h: 0 });
    expect(getSwapTokens().some(token => token.faucetId === 'testnet:0xfee')).toBe(false);
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
    expect(tokenQuote({}, '0xfee', 'MIDEN')).toBeUndefined();
  });
});

describe('SDK-confirmed provisional native unit pricing', () => {
  beforeEach(() => {
    mockGetNativeAssetIdSync.mockReturnValue('testnet:0xfee');
    mockGetNativeAssetMetadataSync.mockReturnValue(null);
    jest.requireMock('lib/miden-chain/native-asset').getSdkSyncedNativeAssetIdSync.mockReturnValue('0xfee');
  });
  it('quotes the provisional native USDCX unit at one dollar before its scale resolves', () => {
    expect(priceSymbolFor('0xfee', 'USDCX')).toBe('USDCX');
    expect(tokenQuote({}, 'testnet:0xfee', 'USDCX')).toEqual({ price: 1, change24h: 0, percentageChange24h: 0 });
    expect(getSwapTokens().some(token => token.faucetId === 'testnet:0xfee')).toBe(false);
  });
  it('does not quote a copied symbol, missing SDK proof or an unsynced override', () => {
    expect(tokenQuote({}, 'other-faucet', 'USDCX')).toBeUndefined();
    jest.requireMock('lib/miden-chain/native-asset').getSdkSyncedNativeAssetIdSync.mockReturnValue(null);
    expect(tokenQuote({}, 'testnet:0xfee', 'USDCX')).toBeUndefined();
    jest.requireMock('lib/miden-chain/native-asset').getSdkSyncedNativeAssetIdSync.mockReturnValue('0xfee');
    mockGetNativeAssetIdSync.mockReturnValue('override-faucet');
    expect(tokenQuote({}, 'override-faucet', 'USDCX')).toBeUndefined();
  });
  it('stops the default USDCX quote when authoritative chain metadata identifies MIDEN', () => {
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
    expect(tokenQuote({}, 'testnet:0xfee', 'USDCX')).toBeUndefined();
  });
});
