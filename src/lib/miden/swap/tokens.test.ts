import {
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET as MIDEN_AGGLAYER_FAUCET_ID
} from 'lib/epoch/testing/bridge-config';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
import { isCoveredSymbol } from 'lib/prices/usd';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { parseSwapPairs, type SwapPairs } from 'lib/remote-config/swap-pairs';
import { peekTokenPriceAssets } from 'lib/token-list/runtime';

import { bridgePriceAllowlist } from './bridge-price-allowlist';
import {
  TEST_SWAP_PAIRS_RESPONSE,
  TEST_SWAP_TOKEN_DECIMALS,
  TEST_SWAP_TOKENS,
  TEST_TOKEN_IBTC,
  TEST_TOKEN_IETH,
  TEST_TOKEN_IMIDEN,
  TEST_TOKEN_IUSDT
} from './testing/registry';
import {
  canonicalFaucetId,
  getDefaultSwapPair,
  getSwapTokenByFaucetId,
  getSwapPartners,
  getSwapTokens,
  isSwapPair,
  getSwapTokenBySymbol,
  normalizedFaucetId,
  priceSymbolFor,
  strictPriceSymbolFor,
  tokenQuote,
  _allowlistedPriceSymbolsForTest,
  _resetNormalizedFaucetIdsForTest,
  _setSwapTokensForTest
} from './tokens';

// The bridged price entries: the testnet config's by default (the manual mock's answer), and others a test sets.
jest.mock('lib/token-list/runtime', () => ({ peekTokenPriceAssets: jest.fn() }));
jest.mock('./bridge-price-allowlist', () => ({ bridgePriceAllowlist: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(),
  getNativeAssetMetadataSync: jest.fn(),
  getSdkSyncedNativeAssetIdSync: jest.fn()
}));
// The registry reads the solver's pairs this realm has loaded; each suite below says which.
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));

const SKIPPED: { state: 'skipped' } = { state: 'skipped' };
const HEX_TOKENS = TEST_SWAP_PAIRS_RESPONSE.tokens;

const UNLOADED: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
const NO_DOCUMENT: BridgeConfigSnapshot = { ...UNLOADED, status: 'ready' };
/** A document that names the solver, with the read of its pairs as given and nothing else the registry reads. */
const withPairs = (pairs: NonNullable<NonNullable<BridgeConfigSnapshot['derived']>['swap']>['pairs']) => ({
  ...NO_DOCUMENT,
  config: {
    network: 'testnet',
    version: 3,
    'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
    supportedEvmChains: {},
    features: { earn: false, nearIntents: false },
    swap: { etaUrl: 'https://quotes.example' }
  },
  derived: {
    network: 'testnet',
    version: 3,
    derivedAt: 0,
    chains: {},
    agglayer: { indexer: SKIPPED },
    epoch: { allocator: SKIPPED, market: SKIPPED, midenUsdcFaucet: SKIPPED, vaults: SKIPPED },
    swap: { pairs }
  }
});
const listing = (pairs: SwapPairs): BridgeConfigSnapshot => withPairs({ state: 'ok', value: pairs });
/** The solver's four tokens and three pairs, as the parser reads its answer. */
const SOLVER_PAIRS: SwapPairs = parseSwapPairs(TEST_SWAP_PAIRS_RESPONSE)!;
const LOADED: BridgeConfigSnapshot = listing(SOLVER_PAIRS);
const mockSnapshot = jest.mocked(getBridgeConfigSnapshot);

// The solver spells each faucet in hex and the fixtures in bech32: the fake SDK below maps one to the other.
const mockBech32ByHex = new Map(HEX_TOKENS.map((token, i) => [token.faucetId, TEST_SWAP_TOKENS[i]!.faucetId]));

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
  jest.mocked(peekTokenPriceAssets).mockReturnValue(
    new Map([
      [TEST_TOKEN_IBTC.faucetId, 'BTC'],
      [TEST_TOKEN_IETH.faucetId, 'ETH']
    ])
  );
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

  // The solver's entries, each faucet in the SDK's form, each priced at the asset the feed quotes.
  const listed = TEST_SWAP_TOKENS.map(token => ({ ...token, faucetId: canonical(token.faucetId) }));

  it("reads the solver's tokens in its order, with each faucet in the SDK's form", () => {
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

  it.each([
    ['the document is still loading', UNLOADED],
    ['no document is accepted', NO_DOCUMENT],
    ['the solver lists no tokens', listing({ tokens: [], pairs: [] })],
    ["the read of the solver's pairs failed", withPairs({ state: 'error', message: 'HTTP 503' })],
    ['the document names no solver', withPairs(SKIPPED)],
    ['the derivation predates the swap pairs', { ...LOADED, derived: { ...LOADED.derived!, swap: undefined } }]
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
        decimals: 6
      },
      ...listed
    ]);
    expect(getSwapTokenByFaucetId('mtst1native')).toEqual(expect.objectContaining({ symbol: 'MIDEN', decimals: 6 }));
  });

  it('does not duplicate a native asset the solver already lists, in either spelling', () => {
    mockGetNativeAssetIdSync.mockReturnValue(TEST_TOKEN_IMIDEN.faucetId);
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'IMIDEN', decimals: 8 });
    expect(getSwapTokens().filter(token => token.symbol === 'IMIDEN')).toHaveLength(1);

    mockGetNativeAssetIdSync.mockReturnValue(HEX_TOKENS[0]!.faucetId);
    expect(getSwapTokens().filter(token => token.symbol === 'IMIDEN')).toHaveLength(1);
  });

  it('withholds the native swap entry until its scale is authoritative', () => {
    mockGetNativeAssetIdSync.mockReturnValue('mtst1native');
    expect(getSwapTokens()).toEqual(listed);
  });

  it('override replaces the registry for all readers', () => {
    const t = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: TEST_SWAP_TOKEN_DECIMALS };
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

  it('leaves IUSDT and IMIDEN unpriced: the feed quotes neither asset the solver prices them with', () => {
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
    const iethSpellings = ['0xiethhex', TEST_TOKEN_IETH.faucetId, HEX_TOKENS[1]!.faucetId, 'canonical-ieth'];
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

  it("prices a faucet the bridge config names at the config's symbol, whatever the solver gives it", () => {
    const solverWeth = { faucetId: MIDEN_AGGLAYER_FAUCET_ID, ticker: 'IWETH', decimals: 8 };
    mockSnapshot.mockReturnValue(
      listing({ ...SOLVER_PAIRS, tokens: [...SOLVER_PAIRS.tokens, { ...solverWeth, binanceAsset: 'USDC' }] })
    );
    expect(strictPriceSymbolFor(canonicalFaucetId(MIDEN_AGGLAYER_FAUCET_ID), 'IWETH')).toBe('ETH');
    expect(priceSymbolFor(MIDEN_AGGLAYER_FAUCET_ID, 'IWETH')).toBe('ETH');
    expect(getSwapTokenByFaucetId(MIDEN_AGGLAYER_FAUCET_ID)?.priceSymbol).toBe('ETH');
    expect(getSwapTokenBySymbol('IWETH')?.priceSymbol).toBe('ETH');
    // An asset the solver leaves out does not leave the faucet unpriced either.
    mockSnapshot.mockReturnValue(listing({ ...SOLVER_PAIRS, tokens: [...SOLVER_PAIRS.tokens, solverWeth] }));
    expect(getSwapTokenByFaucetId(MIDEN_AGGLAYER_FAUCET_ID)?.priceSymbol).toBe('ETH');
  });

  it('matches the bridge config before an overriding registry token that names the same faucet', () => {
    _setSwapTokensForTest([{ symbol: 'IWETH', faucetId: MIDEN_AGGLAYER_FAUCET_ID, decimals: 8, priceSymbol: 'USDC' }]);
    try {
      expect(strictPriceSymbolFor(canonicalFaucetId(MIDEN_AGGLAYER_FAUCET_ID), 'IWETH')).toBe('ETH');
    } finally {
      _setSwapTokensForTest(undefined);
    }
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

  it("resolves a registry token by faucet id in any spelling: a row's bech32, the solver's hex", () => {
    const expected = { ...TEST_TOKEN_IMIDEN, faucetId: canonical(TEST_TOKEN_IMIDEN.faucetId) };
    expect(getSwapTokenByFaucetId(TEST_TOKEN_IMIDEN.faucetId)).toEqual(expected);
    expect(getSwapTokenByFaucetId(canonical(TEST_TOKEN_IMIDEN.faucetId))).toEqual(expected);
    expect(getSwapTokenByFaucetId(HEX_TOKENS[0]!.faucetId)).toEqual(expected);
  });

  it('returns undefined for an unknown faucet id', () => {
    expect(getSwapTokenByFaucetId('mtst1unknown')).toBeUndefined();
  });

  it('returns undefined when no faucet id is supplied', () => {
    expect(getSwapTokenByFaucetId(undefined)).toBeUndefined();
    expect(getSwapTokenByFaucetId('')).toBeUndefined();
  });

  it('reads through the overridden registry', () => {
    const token = { symbol: 'SWPA', faucetId: 'mtst1local', decimals: TEST_SWAP_TOKEN_DECIMALS };
    _setSwapTokensForTest([token]);
    expect(getSwapTokenByFaucetId('mtst1local')).toEqual(token);
    expect(getSwapTokenByFaucetId(TEST_TOKEN_IMIDEN.faucetId)).toBeUndefined();
  });
});

describe('getDefaultSwapPair', () => {
  afterEach(() => _setSwapTokensForTest(undefined));

  it("opens on the solver's first pair, in the pair's order, while the native asset is unknown or in no pair", () => {
    // The first pair names neither of the first two tokens: the pair decides, not the token order.
    mockSnapshot.mockReturnValue(listing({ ...SOLVER_PAIRS, pairs: [SOLVER_PAIRS.pairs[2]!, SOLVER_PAIRS.pairs[0]!] }));
    // Cold start: discovery has not populated the synchronous cache yet.
    mockGetNativeAssetIdSync.mockReturnValue(null);
    const cold = getDefaultSwapPair();

    // A native asset the solver lists in no pair is first in the list, and still not the default.
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

  it('pays with the native asset and receives its first partner once the solver pairs it, in either spelling', () => {
    // The fixture's pairs: IMIDEN-IETH, IETH-IUSDT, IBTC-IUSDT. IUSDT pairs with IETH and IBTC.
    const expected = {
      offer: expect.objectContaining({ symbol: 'IUSDT', faucetId: canonical(TEST_TOKEN_IUSDT.faucetId) }),
      request: expect.objectContaining({ symbol: 'IETH', faucetId: canonical(TEST_TOKEN_IETH.faucetId) })
    };
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'IUSDT', decimals: 8 });
    mockGetNativeAssetIdSync.mockReturnValue(HEX_TOKENS[2]!.faucetId);
    expect(getDefaultSwapPair()).toEqual(expected);
    mockGetNativeAssetIdSync.mockReturnValue(canonical(TEST_TOKEN_IUSDT.faucetId));
    expect(getDefaultSwapPair()).toEqual(expected);
  });

  it('has no pair while the registry is not loaded or the solver lists no pair', () => {
    mockSnapshot.mockReturnValue(UNLOADED);
    expect(getDefaultSwapPair()).toBeNull();
    mockSnapshot.mockReturnValue(listing({ ...SOLVER_PAIRS, pairs: [] }));
    expect(getDefaultSwapPair()).toBeNull();
    mockSnapshot.mockReturnValue(withPairs({ state: 'error', message: 'HTTP 503' }));
    expect(getDefaultSwapPair()).toBeNull();
  });

  it("opens on an override's first two tokens, whatever the native asset is", () => {
    mockGetNativeAssetIdSync.mockReturnValue(TEST_TOKEN_IUSDT.faucetId);
    _setSwapTokensForTest([TEST_TOKEN_IBTC, TEST_TOKEN_IUSDT]);
    expect(getDefaultSwapPair()).toEqual({ offer: TEST_TOKEN_IBTC, request: TEST_TOKEN_IUSDT });
  });
});

describe('getSwapPartners', () => {
  beforeEach(() => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    mockGetNativeAssetMetadataSync.mockReturnValue(null);
  });
  afterEach(() => _setSwapTokensForTest(undefined));
  const symbols = (faucetId: string) => getSwapPartners(faucetId).map(token => token.symbol);

  // The fixture's pairs: IMIDEN-IETH, IETH-IUSDT, IBTC-IUSDT.
  it("lists the tokens that share a solver pair with a faucet, in the registry's order and either direction", () => {
    expect(symbols(TEST_TOKEN_IETH.faucetId)).toEqual(['IMIDEN', 'IUSDT']);
    expect(symbols(TEST_TOKEN_IUSDT.faucetId)).toEqual(['IETH', 'IBTC']);
    expect(symbols(TEST_TOKEN_IMIDEN.faucetId)).toEqual(['IETH']);
    expect(symbols(TEST_TOKEN_IBTC.faucetId)).toEqual(['IUSDT']);
  });

  it('matches a faucet in any spelling of its id', () => {
    expect(symbols(HEX_TOKENS[3]!.faucetId)).toEqual(['IUSDT']);
    expect(symbols(canonical(TEST_TOKEN_IBTC.faucetId))).toEqual(['IUSDT']);
    expect(isSwapPair(HEX_TOKENS[3]!.faucetId, TEST_TOKEN_IUSDT.faucetId)).toBe(true);
    expect(isSwapPair(TEST_TOKEN_IUSDT.faucetId, canonical(TEST_TOKEN_IBTC.faucetId))).toBe(true);
  });

  it('gives no partner to two tokens the solver does not pair, a token with itself, or an unknown faucet', () => {
    expect(isSwapPair(TEST_TOKEN_IMIDEN.faucetId, TEST_TOKEN_IBTC.faucetId)).toBe(false);
    expect(isSwapPair(TEST_TOKEN_IETH.faucetId, TEST_TOKEN_IETH.faucetId)).toBe(false);
    expect(getSwapPartners('mtst1unknown')).toEqual([]);
  });

  it('gives no partner to a native asset the solver lists in no pair', () => {
    mockGetNativeAssetIdSync.mockReturnValue('mtst1native');
    mockGetNativeAssetMetadataSync.mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
    expect(getSwapTokens()[0]!.symbol).toBe('MIDEN');
    expect(getSwapPartners('mtst1native')).toEqual([]);
    expect(symbols(TEST_TOKEN_IBTC.faucetId)).toEqual(['IUSDT']);
  });

  it('has no partners while the read of the pairs has failed', () => {
    mockSnapshot.mockReturnValue(withPairs({ state: 'error', message: 'HTTP 503' }));
    expect(getSwapPartners(TEST_TOKEN_IETH.faucetId)).toEqual([]);
  });

  it('pairs every two tokens of an override, which has no pairs', () => {
    _setSwapTokensForTest([TEST_TOKEN_IBTC, TEST_TOKEN_IMIDEN, TEST_TOKEN_IETH]);
    expect(getSwapPartners(TEST_TOKEN_IBTC.faucetId)).toEqual([TEST_TOKEN_IMIDEN, TEST_TOKEN_IETH]);
    expect(isSwapPair(TEST_TOKEN_IMIDEN.faucetId, TEST_TOKEN_IBTC.faucetId)).toBe(true);
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

describe('verified list price mapping', () => {
  it('uses a verified faucet asset without trusting a reported symbol', () => {
    jest.mocked(peekTokenPriceAssets).mockReturnValue(new Map([['mtst1verified', 'ARB']]));
    expect(priceSymbolFor('mtst1verified', 'ETH')).toBe('ARB');
    expect(priceSymbolFor('mtst1other', 'ARB')).toBeUndefined();
    expect(isCoveredSymbol('ARB')).toBe(true);
  });

  it('uses full verified symbols before bridge price aliases', () => {
    jest.mocked(peekTokenPriceAssets).mockReturnValue(
      new Map([
        [TEST_TOKEN_IETH.faucetId, 'IETH'],
        ['mtst1listed', 'IBTC']
      ])
    );
    expect(priceSymbolFor(TEST_TOKEN_IETH.faucetId, 'IETH')).toBe('IETH');
    expect(priceSymbolFor('mtst1listed', 'BTC')).toBe('IBTC');
  });
});
