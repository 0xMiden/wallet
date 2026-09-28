import { MIDEN_USDC_FAUCET } from 'lib/epoch/collateral';
import { _resetNormalizedFaucetIdsForTest } from 'lib/miden/swap/tokens';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';

import { resolveSpendsUsd } from './valuation';

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

const TST_METADATA = {
  decimals: 6,
  symbol: 'TST',
  name: 'TST',
  shouldPreferSymbol: true,
  thumbnailUri: '',
  scaleIsUnknown: false
};

const USDC_METADATA = { ...TST_METADATA, symbol: 'USDC', name: 'USDC' };

const sentinelAccountId = { __brand: 'faucet-account-id' };
const usdcAccountId = { __brand: 'usdc-faucet-account-id' };
const BECH32_BY_ACCOUNT_ID = new Map<unknown, string>([
  [sentinelAccountId, BECH32_FAUCET],
  [usdcAccountId, USDC_BECH32]
]);

const mockFromHex = jest.fn();
const mockFromBech32 = jest.fn();
const mockFromAccountId = jest.fn();
const mockGetAccountDetails = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (...args: unknown[]) => mockFromHex(...args) },
  Address: {
    fromBech32: (...args: unknown[]) => mockFromBech32(...args),
    fromAccountId: (...args: unknown[]) => mockFromAccountId(...args)
  },
  RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails })),
  BasicFungibleFaucetComponent: { fromAccountStorage: jest.fn() }
}));

jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(() => Promise.resolve()),
  getRpcEndpoint: jest.fn(() => 'mock-endpoint'),
  getNetworkId: jest.fn(() => 'testnet')
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

    // The metadata cache holds TST under the BECH32 key - the form every wallet-populated cache
    // entry uses (`getBech32AddressFromAccountId`), matching the E2E fixture's own faucet.
    mockFetchFromStorage.mockResolvedValue({ [BECH32_FAUCET]: TST_METADATA });
    mockPutToStorage.mockResolvedValue(undefined);

    // AccountId.fromHex(hex) -> a sentinel AccountId; Address.fromAccountId(that, 'BasicWallet')
    // .toBech32(...) -> the SAME bech32 string the cache is keyed under, exactly what
    // `getBech32AddressFromAccountId` already produces for every other faucet id this codebase
    // caches under. Anything else parsing to a different account id is not this faucet.
    mockFromHex.mockImplementation((hex: string) =>
      hex === HEX_FAUCET ? sentinelAccountId : hex === MIDEN_USDC_FAUCET ? usdcAccountId : { __brand: 'other' }
    );
    mockFromAccountId.mockImplementation((accountId: unknown, iface: string) => ({
      toBech32: () => (iface === 'BasicWallet' ? BECH32_BY_ACCOUNT_ID.get(accountId) : undefined) ?? 'unexpected'
    }));
    // The real SDK's `Address.fromBech32` rejects a non-bech32 string (a hex id included) rather
    // than silently accepting it - the RPC-path parse failure this bug goes through.
    mockFromBech32.mockImplementation((address: string) => {
      if (address === BECH32_FAUCET) return { accountId: () => sentinelAccountId };
      if (address === USDC_BECH32) return { accountId: () => usdcAccountId };
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
});
