import { TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET } from 'lib/epoch/testing/bridge-config';
import { _resetNormalizedFaucetIdsForTest, TOKEN_IBTC, TOKEN_IETH } from 'lib/miden/swap/tokens';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import {
  getNativeAssetId,
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';

import { SpendingLimitPriceUnavailableError } from './types';
import { resolveSpendsUsd } from './valuation';
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(async () => NATIVE_BECH32),
  getNativeAssetMetadata: jest.fn(async () => ({ symbol: 'MIDEN', decimals: 6 })),
  getNativeAssetIdSync: jest.fn(() => NATIVE_BECH32),
  getNativeAssetMetadataSync: jest.fn(() => ({ symbol: 'MIDEN', decimals: 6 })),
  getSdkSyncedNativeAssetIdSync: jest.fn(() => NATIVE_BECH32)
}));

/**
 * Reproduces the dApp CUSTOM spending-limit refusal (wallet PR #1080, `dapp_custom_within_limit_
 * is_approved_and_counted`): `formatSimulatedCustomEffects` builds its `outgoing` spends list from
 * `netOutflowByFaucet` (`app/confirm/decode.ts`), which folds entries by `canonicalWalletAccountId`
 * - the bare-hex `AccountId.toString()` form - and then emits THAT hex string as the spend's
 * `faucetId`, not the bech32 string it folded. `fetchTokenMetadata`'s cache and its RPC parse
 * (`Address.fromBech32`) are both bech32-keyed, so a hex faucetId misses the cache and fails to
 * parse, and `resolveSpendsUsd`'s identify-first rule turns that into
 * `SpendingLimitPriceUnavailableError` - a dApp CUSTOM request refused before the wallet's confirm
 * popup ever opens.
 *
 * Drives the REAL `resolveSpendsUsd` and the REAL `fetchTokenMetadata` (not mocked, unlike
 * `valuation.test.ts`); only `fetchTokenMetadata`'s storage backend and the SDK's id
 * parsing/RPC surface are mocked, so this exercises the actual cache lookup and the actual
 * `Address.fromBech32` parse failure the bug goes through.
 */

const BECH32_FAUCET = 'mtst1qtstfaucet00000000000000000000000000000qqqqqqq';
// The hex form `netOutflowByFaucet` actually emits: `canonicalWalletAccountId` →
// `accountRefToSdk(bech32).toString()`, i.e. `AccountId.toString()`'s canonical hex.
const HEX_FAUCET = '0xaabbccddeeff00112233445566778899';
// The Earn collateral USDC, which the price allowlist names by its hex id (#1131).
const USDC_BECH32 = 'mtst1qusdcfaucet000000000000000000000000000qqqqqqq';
const NATIVE_BECH32 = 'mtst1qnativefaucet0000000000000000000000000qqqqqqq';
const NATIVE_HEX = '0x1234567890abcdef1234567890abcdef';

const TST_METADATA = {
  decimals: 6,
  symbol: 'TST',
  name: 'TST',
  scaleIsUnknown: false
};

const USDC_METADATA = { ...TST_METADATA, symbol: 'USDC', name: 'USDC' };
const IETH_METADATA = { ...TST_METADATA, decimals: 8, symbol: 'IETH', name: 'IETH' };

const sentinelAccountId = { __brand: 'faucet-account-id' };
const usdcAccountId = { __brand: 'usdc-faucet-account-id' };
const nativeAccountId = { __brand: 'native-faucet-account-id' };
// The swap registry's priced entries are bech32 ids: the cap matches every entry it compares
// strictly, so an entry that failed to parse here would refuse every spend in this suite.
const iethAccountId = { __brand: 'ieth-faucet-account-id' };
const ibtcAccountId = { __brand: 'ibtc-faucet-account-id' };
const BECH32_BY_ACCOUNT_ID = new Map<unknown, string>([
  [sentinelAccountId, BECH32_FAUCET],
  [usdcAccountId, USDC_BECH32],
  [nativeAccountId, NATIVE_BECH32],
  [iethAccountId, TOKEN_IETH.faucetId],
  [ibtcAccountId, TOKEN_IBTC.faucetId]
]);
const ACCOUNT_ID_BY_BECH32 = new Map([...BECH32_BY_ACCOUNT_ID].map(([accountId, bech32]) => [bech32, accountId]));
// A bech32 id's prefix names its network, so each faucet above has one spelling per network.
const PREFIX_BY_NETWORK: Record<string, string> = { testnet: 'mtst', devnet: 'mdev' };
const spelledOn = (bech32: string, network: string): string =>
  bech32.replace(/^[a-z]+1/, `${PREFIX_BY_NETWORK[network]}1`);

const mockFromHex = jest.fn();
const mockFromBech32 = jest.fn();
const mockFromAccountId = jest.fn();
const mockGetAccountDetails = jest.fn();

// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: jest.fn(() => Promise.resolve()) }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (...args: unknown[]) => mockFromHex(...args) },
  Address: {
    fromBech32: (...args: unknown[]) => mockFromBech32(...args),
    fromAccountId: (...args: unknown[]) => mockFromAccountId(...args)
  },
  RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails })),
  BasicFungibleFaucetComponent: { fromAccountStorage: jest.fn() }
}));

// The network a user can switch mid-valuation: the SDK's id encoding (`getNetworkId`) and the
// canonical-id cache key both follow it, as they do in the wallet.
let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockNetwork
}));

jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(() => Promise.resolve()),
  getRpcEndpoint: jest.fn(() => 'mock-endpoint'),
  getNetworkId: jest.fn(() => mockNetwork)
}));

jest.mock('lib/miden/assets', () => ({ isMidenAsset: () => false }));

const mockFetchFromStorage = jest.fn();
const mockPutToStorage = jest.fn();
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args),
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

// `valuation.ts` imports `fetchTokenMetadata` off the `../metadata` barrel, which also
// re-exports `./utils` - a chain that pulls in `lib/miden/front` and, through it, most of the
// transaction module (for unrelated SDK symbols this test has no reason to stub). Re-export only
// the real `./fetch` module so `resolveSpendsUsd` still gets the genuine `fetchTokenMetadata`
// without dragging that chain in.
jest.mock('../metadata', () => jest.requireActual('../metadata/fetch'));

describe('resolveSpendsUsd against the real fetchTokenMetadata (faucet id format)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // An earlier case's successful parse would otherwise match the allowlist without the SDK.
    _resetNormalizedFaucetIdsForTest();
    process.env.MIDEN_E2E_TEST = 'true';
    mockNetwork = 'testnet';
    jest.mocked(getNativeAssetId).mockResolvedValue(NATIVE_BECH32);
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'MIDEN', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(NATIVE_BECH32);

    // The metadata cache holds TST under the BECH32 key - the form every wallet-populated cache
    // entry uses (`getBech32AddressFromAccountId`), matching the E2E fixture's own faucet.
    mockFetchFromStorage.mockResolvedValue({ [BECH32_FAUCET]: TST_METADATA });
    mockPutToStorage.mockResolvedValue(undefined);

    // AccountId.fromHex(hex) -> a sentinel AccountId; Address.fromAccountId(that, 'BasicWallet')
    // .toBech32(...) -> the SAME bech32 string the cache is keyed under, exactly what
    // `getBech32AddressFromAccountId` already produces for every other faucet id this codebase
    // caches under. Anything else parsing to a different account id is not this faucet.
    mockFromHex.mockImplementation((hex: string) =>
      hex === HEX_FAUCET
        ? sentinelAccountId
        : hex === MIDEN_USDC_FAUCET
          ? usdcAccountId
          : hex === NATIVE_HEX
            ? nativeAccountId
            : { __brand: 'other' }
    );
    mockFromAccountId.mockImplementation((accountId: unknown, iface: string) => ({
      toBech32: (network: string) => {
        const bech32 = iface === 'BasicWallet' ? BECH32_BY_ACCOUNT_ID.get(accountId) : undefined;
        return bech32 === undefined ? 'unexpected' : spelledOn(bech32, network);
      }
    }));
    // The real SDK's `Address.fromBech32` parses any network's spelling of an id but rejects a
    // non-bech32 string (a hex id included) rather than silently accepting it - the RPC-path parse
    // failure this bug goes through.
    mockFromBech32.mockImplementation((address: string) => {
      const accountId = ACCOUNT_ID_BY_BECH32.get(spelledOn(address, 'testnet'));
      if (accountId !== undefined) return { accountId: () => accountId };
      throw new Error(`invalid bech32 address: ${address}`);
    });
  });

  afterEach(() => {
    delete process.env.MIDEN_E2E_TEST;
  });

  it('sanity: prices a spend already in the cache-matching bech32 form (the dApp SEND path)', async () => {
    await expect(resolveSpendsUsd([{ faucetId: BECH32_FAUCET, amount: 50_000_000n }], 10)).resolves.toBe(50_000_000n);
    expect(mockGetAccountDetails).not.toHaveBeenCalled();
  });

  it('prices a spend whose faucetId is the dry-run hex canonical form (the dApp CUSTOM path)', async () => {
    await expect(resolveSpendsUsd([{ faucetId: HEX_FAUCET, amount: 50_000_000n }], 10)).resolves.toBe(50_000_000n);
    // Resolved straight from cache once canonicalized - no RPC round trip needed.
    expect(mockGetAccountDetails).not.toHaveBeenCalled();
  });

  it('counts a USDC spend given by its bech32 id toward the total (#1131)', async () => {
    mockFetchFromStorage.mockImplementation(async (key: string) =>
      key === 'usd_price_cache' ? { USDC: { priceMicro: '1000000', fetchedAt: 10 } } : { [USDC_BECH32]: USDC_METADATA }
    );

    await expect(resolveSpendsUsd([{ faucetId: USDC_BECH32, amount: 25_000_000n }], 10)).resolves.toBe(25_000_000n);
  });

  it('loads the SDK before matching a cached USDC spend against its hex allowlist entry (#1131 F-012)', async () => {
    // A freshly woken service worker with this faucet's metadata cached: the lazy SDK's statics
    // throw until its WASM loads, and the metadata cache hit never loads it.
    let sdkLoaded = false;
    jest.mocked(ensureSdkWasmReady).mockImplementationOnce(
      () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            sdkLoaded = true;
            resolve();
          }, 0)
        )
    );
    const untilLoaded =
      <A extends unknown[], R>(parse: (...args: A) => R) =>
      (...args: A): R => {
        if (!sdkLoaded) throw new TypeError('SDK not loaded');
        return parse(...args);
      };
    mockFromHex.mockImplementation(untilLoaded(mockFromHex.getMockImplementation()!));
    mockFromBech32.mockImplementation(untilLoaded(mockFromBech32.getMockImplementation()!));
    mockFetchFromStorage.mockImplementation(async (key: string) =>
      key === 'usd_price_cache' ? { USDC: { priceMicro: '1000000', fetchedAt: 10 } } : { [USDC_BECH32]: USDC_METADATA }
    );

    await expect(resolveSpendsUsd([{ faucetId: USDC_BECH32, amount: 25_000_000n }], 10)).resolves.toBe(25_000_000n);
  });

  it('values an IETH spend at ETH when the network switches while its metadata loads (#1131 F-006)', async () => {
    mockFetchFromStorage.mockImplementation(async (key: string) => {
      if (key === 'usd_price_cache') return { ETH: { priceMicro: '2000000000', fetchedAt: 10 } };
      // The spend was canonicalized, and its metadata cached, under the network it started on.
      mockNetwork = 'devnet';
      return { [TOKEN_IETH.faucetId]: IETH_METADATA };
    });

    await expect(resolveSpendsUsd([{ faucetId: TOKEN_IETH.faucetId, amount: 100_000_000n }], 10)).resolves.toBe(
      2_000_000_000n
    );
  });

  // #1131 F-009: strictPriceSymbolFor re-canonicalizes the spend id, not just the allowlist
  // entries, once the network has switched during the metadata await. A parse failure there must
  // still refuse the spend - the symbol on the rejection is 'USDC' (from the already-resolved
  // metadata), proving the throw came from the re-canonicalization, not the first pass (which
  // parsed fine on testnet) or the metadata stage (which succeeded from cache).
  it('refuses a bech32 USDC spend the allowlist match cannot re-canonicalize after a network switch (#1131 F-009)', async () => {
    const parseError = new Error('cannot parse the switched-network USDC spend');
    const parseBech32 = mockFromBech32.getMockImplementation()!;
    mockFromBech32.mockImplementation((address: string) => {
      if (address === USDC_BECH32 && mockNetwork === 'devnet') throw parseError;
      return parseBech32(address);
    });
    mockFetchFromStorage.mockImplementation(async (key: string) => {
      if (key === 'usd_price_cache') return { USDC: { priceMicro: '1000000', fetchedAt: 10 } };
      // The spend was canonicalized, and its metadata cached, under the network it started on.
      mockNetwork = 'devnet';
      return { [USDC_BECH32]: USDC_METADATA };
    });

    const valued = resolveSpendsUsd([{ faucetId: USDC_BECH32, amount: 25_000_000n }], 10);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({ symbol: 'USDC', cause: parseError });
  });

  it('refuses a USDC spend whose allowlist entry the SDK cannot parse, never counting it as nothing (#1131 F-001)', async () => {
    const parseError = new Error('cannot parse the USDC entry');
    const parseHex = mockFromHex.getMockImplementation()!;
    mockFromHex.mockImplementation((hex: string) => {
      if (hex === MIDEN_USDC_FAUCET) throw parseError;
      return parseHex(hex);
    });
    mockFetchFromStorage.mockImplementation(async (key: string) =>
      key === 'usd_price_cache' ? { USDC: { priceMicro: '1000000', fetchedAt: 10 } } : { [USDC_BECH32]: USDC_METADATA }
    );

    const valued = resolveSpendsUsd([{ faucetId: USDC_BECH32, amount: 25_000_000n }], 10);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({ symbol: 'USDC', cause: parseError });
  });

  it.each([
    [NATIVE_BECH32, NATIVE_HEX],
    [NATIVE_HEX, NATIVE_BECH32]
  ])('values native USDCX when identity %s and SDK proof %s are canonical aliases', async (identity, proof) => {
    jest.mocked(getNativeAssetId).mockResolvedValueOnce(identity);
    jest.mocked(getNativeAssetMetadata).mockResolvedValueOnce({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(proof);

    await expect(resolveSpendsUsd([{ faucetId: NATIVE_BECH32, amount: 1_000_000n }], 10)).resolves.toBe(1_000_000n);
    expect(mockGetAccountDetails).not.toHaveBeenCalled();
  });

  it('refuses native USDCX when its non-null SDK proof cannot be canonicalized', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValueOnce({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue('not-a-protocol-faucet');

    const valued = resolveSpendsUsd([{ faucetId: NATIVE_BECH32, amount: 1_000_000n }], 10);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'invalid bech32 address: not-a-protocol-faucet' })
    });
  });

  it('refuses a spend whose own id the SDK cannot parse, named after that id (#1131 F-001)', async () => {
    const RAW_ID = 'not-a-faucet-id';
    mockFetchFromStorage.mockImplementation(async (key: string) =>
      key === 'usd_price_cache' ? { USDC: { priceMicro: '1000000', fetchedAt: 10 } } : { [RAW_ID]: USDC_METADATA }
    );

    const valued = resolveSpendsUsd([{ faucetId: RAW_ID, amount: 25_000_000n }], 10);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({
      symbol: RAW_ID,
      cause: expect.objectContaining({ message: `invalid bech32 address: ${RAW_ID}` })
    });
  });
});
