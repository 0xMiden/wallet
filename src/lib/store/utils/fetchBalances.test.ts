import '../../../../test/jest-mocks';

import {
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncSuccess,
  noteSyncWatchdogEviction,
  syncFuseUntilMs
} from 'lib/miden/front/sync-fuse';
import { AssetMetadata, MIDEN_METADATA } from 'lib/miden/metadata';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { TOKEN_IETH } from 'lib/miden/swap/tokens';
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';
import { __resetFaucetAssetsMetadataForTest, useWalletStore } from 'lib/store';

import { __resetUnresolvedFaucetsForTest, fetchBalances } from './fetchBalances';

let mockNativeAssetId = 'miden-faucet-id';
let mockNativeMetadata = { symbol: 'MIDEN', decimals: 8 };
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockNativeAssetId,
  getNativeAssetMetadataSync: () => mockNativeMetadata,
  getSdkSyncedNativeAssetIdSync: () => mockNativeAssetId
}));

// Mock dependencies
const mockGetAccount = jest.fn();
const mockSyncState = jest.fn();
const mockGetMidenClient = jest.fn(() => ({
  getAccount: mockGetAccount,
  syncState: mockSyncState
}));

// Models hold OWNERSHIP, not just the callback: the read re-checks its hold before
// touching the account's vault, so a mock that hands out no hold makes that guard throw
// on every call and a mock that never revokes one makes it untestable.
let currentHold: object | null = null;
// Defaults to "lock free" — runs the op and reports it ran. A test overrides
// this to `{ ran: false }` to exercise the WASM-busy skip path.
const mockTryWithWasmClientLock = jest.fn(
  async (operation: (hold: object) => Promise<unknown>): Promise<{ ran: true; value: unknown } | { ran: false }> => {
    const hold = {};
    currentHold = hold;
    try {
      return { ran: true, value: await operation(hold) };
    } finally {
      if (currentHold === hold) currentHold = null;
    }
  }
);

// The OPTIONS are the point of the #777 change here, so they have to reach an assertion:
// a mock that silently drops them lets the bound come off without a single test noticing.
const lockOptionsSeen: unknown[] = [];

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  getCurrentWasmLockHold: () => currentHold,
  withWasmClientLock: async (operation: (hold: object) => Promise<unknown>, options?: unknown) => {
    lockOptionsSeen.push(options);
    const hold = {};
    currentHold = hold;
    try {
      return await operation(hold);
    } finally {
      if (currentHold === hold) currentHold = null;
    }
  },
  tryWithWasmClientLock: (operation: () => Promise<unknown>, options?: unknown) => {
    lockOptionsSeen.push(options);
    return mockTryWithWasmClientLock(operation);
  }
}));

jest.mock('lib/miden/assets', () => ({
  getFaucetIdSetting: jest.fn(() => 'miden-faucet-id')
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: string) => `bech32-${id}`)
}));

// Mock fetchTokenMetadata used by fetchBalances for inline metadata fetching
const mockFetchTokenMetadata = jest.fn();

jest.mock('lib/miden/metadata', () => ({
  MIDEN_METADATA: { name: 'Miden', symbol: 'MIDEN', decimals: 8 },
  DEFAULT_TOKEN_METADATA: { name: 'Unknown', symbol: 'Unknown', decimals: 6 },
  fetchTokenMetadata: (...args: unknown[]) => mockFetchTokenMetadata(...args)
}));

jest.mock('../../miden/front/assets', () => ({
  setTokensBaseMetadata: jest.fn()
}));

// The stored overrides are the input under test. The apply logic is the real one.
const mockGetTokenMetadataOverrides = jest.fn();
jest.mock('lib/miden/metadata/overrides', () => ({
  ...jest.requireActual('lib/miden/metadata/overrides'),
  getTokenMetadataOverrides: () => mockGetTokenMetadataOverrides()
}));

describe('fetchBalances', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSyncState.mockReset();
    mockFetchTokenMetadata.mockReset();
    mockGetTokenMetadataOverrides.mockReset().mockResolvedValue({});
    // Process-wide rate limit — without this a faucet that failed in one case
    // stays in backoff and silently skips the fetch in the next.
    __resetUnresolvedFaucetsForTest();
  });

  beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('bounds its hold at the sync ceiling and labels it, rather than taking the 5-minute backstop', async () => {
    // The window this non-blocking read wins is the instant an eviction released the
    // mutex — the client slot is empty, so the read rebuilds and the new client's genesis
    // fetch goes to the node that just parked. On the default backstop a 5s balance poll
    // then owned this realm's only WASM mutex for 300s. The label is what names it in the
    // eviction log and keys its fuse.
    mockGetAccount.mockResolvedValueOnce(null);
    lockOptionsSeen.length = 0;

    await fetchBalances('my-address', {});

    expect(lockOptionsSeen).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'balances' }]);
  });

  it('bounds and labels a waiting read exactly like a skipping one (#1123)', async () => {
    // A read that queues for the lock is still a balance probe: same ceiling, same fuse key.
    mockGetAccount.mockResolvedValueOnce(null);
    lockOptionsSeen.length = 0;
    mockTryWithWasmClientLock.mockClear();

    await fetchBalances('my-address', {}, { waitForLock: true });

    expect(lockOptionsSeen).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'balances' }]);
    expect(mockTryWithWasmClientLock).not.toHaveBeenCalled();
  });

  it('skips the hold entirely once its own fuse is lit, and resumes on a success (#777)', async () => {
    // A lit fuse means this probe's call is parked: the node took the request and never
    // answered, so the client the next lap builds parks on it too. Bounding capped one
    // park at 120s; only this gate stops the wallet paying that park, plus a leaked
    // client, on every refresh from here on.
    __resetSyncFuseStateForTests();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('balances');
    lockOptionsSeen.length = 0;

    expect(await fetchBalances('my-address', {})).toBeNull();
    expect(lockOptionsSeen).toHaveLength(0);
    expect(mockGetAccount).not.toHaveBeenCalled();

    // Falsifier: the gate is the fuse and nothing else. Put it out and the very next
    // refresh reads again — the fuse must never become a one-way door.
    noteSyncSuccess('balances');
    mockGetAccount.mockResolvedValueOnce(null);
    expect(await fetchBalances('my-address', {})).not.toBeNull();
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    __resetSyncFuseStateForTests();
  });

  it('stops before reading the vault when the hold was evicted during the account read', async () => {
    // An eviction hands the mutex to somebody else without stopping this callback, and
    // `acc.vault().fungibleAssets()` is a WASM call on an object borrowed from the
    // client's RefCell — so continuing is the double borrow the lock exists to prevent,
    // not a merely-stale read. Bounding this hold at two minutes made that window
    // reachable on the very path #777 is about.
    __resetSyncFuseStateForTests();
    const vault = jest.fn(() => ({ fungibleAssets: () => [] }));
    mockGetAccount.mockImplementationOnce(async () => {
      currentHold = null; // what the watchdog does to the hold this callback still holds
      return { vault };
    });

    await expect(fetchBalances('my-address', {})).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(vault).not.toHaveBeenCalled();

    // Falsifier: with the hold intact the same read completes and DOES touch the vault,
    // so the assertion above is about the eviction and not about the fixture.
    mockGetAccount.mockImplementationOnce(async () => ({ vault }));
    await expect(fetchBalances('my-address', {})).resolves.not.toBeNull();
    expect(vault).toHaveBeenCalledTimes(1);
    __resetSyncFuseStateForTests();
  });

  // A trap abandons the read without learning anything about the node.
  it('books a realm-error eviction as abandoned, never erasing eviction evidence', async () => {
    __resetSyncFuseStateForTests();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) noteSyncWatchdogEviction('balances');
    mockTryWithWasmClientLock.mockImplementationOnce(() => Promise.reject(new WasmClientPoisonedError('realm-error')));

    await expect(fetchBalances('my-address', {})).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    noteSyncWatchdogEviction('balances');

    expect(isSyncFused('balances')).toBe(true);
    __resetSyncFuseStateForTests();
  });

  it('reports its own evictions to the fuse, and a completed read puts it out', async () => {
    __resetSyncFuseStateForTests();
    const evict = () => Promise.reject(new WasmClientPoisonedError('watchdog'));

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      mockTryWithWasmClientLock.mockImplementationOnce(evict);
      await expect(fetchBalances('my-address', {})).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    }
    expect(isSyncFused('balances')).toBe(true);

    // A completed read is the one thing that puts it out — asserted through a real
    // successful `fetchBalances` rather than by calling `noteSyncSuccess` from the test,
    // which would only re-test the ledger. Proven by the eviction that follows: it is the
    // FIRST of a new run, so it cannot re-light a fuse whose count was truly zeroed.
    // Served out first: while the window stands the gate skips the read, so the probe that
    // clears the fuse is the one the fused cadence eventually lets through.
    const realNow = performance.now();
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(realNow + 40 * 60_000);
    mockGetAccount.mockResolvedValueOnce(null);
    await fetchBalances('my-address', {});
    nowSpy.mockRestore();
    expect(isSyncFused('balances')).toBe(false);
    mockTryWithWasmClientLock.mockImplementationOnce(evict);
    await expect(fetchBalances('my-address', {})).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(isSyncFused('balances')).toBe(false);

    // A BUSY lap is evidence of nothing — no hold was taken — so it must neither light
    // nor clear anything.
    __resetSyncFuseStateForTests();
    mockTryWithWasmClientLock.mockImplementationOnce(async () => ({ ran: false }));
    await fetchBalances('my-address', {});
    expect(syncFuseUntilMs('balances')).toBeNull();

    // And an ORDINARY failure does not light it: the fuse's claim is specifically that a
    // call is parked, which an offline node is not.
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 1; i++) {
      mockTryWithWasmClientLock.mockImplementationOnce(() => Promise.reject(new Error('Failed to fetch')));
      await expect(fetchBalances('my-address', {})).rejects.toThrow('Failed to fetch');
    }
    expect(isSyncFused('balances')).toBe(false);
    __resetSyncFuseStateForTests();
  });

  it('reports its own evictions to the fuse for a waiting read too, and a completed wait puts it out (#1123)', async () => {
    __resetSyncFuseStateForTests();

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      mockGetAccount.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));
      await expect(fetchBalances('my-address', {}, { waitForLock: true })).rejects.toMatchObject({
        name: 'WasmClientPoisonedError'
      });
    }
    expect(isSyncFused('balances')).toBe(true);

    // Same exit as the skipping read's above: only a completed read puts the fuse out,
    // proven through a real successful `fetchBalances` call rather than `noteSyncSuccess`
    // directly, which would only re-test the ledger.
    const realNow = performance.now();
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(realNow + 40 * 60_000);
    mockGetAccount.mockResolvedValueOnce(null);
    await fetchBalances('my-address', {}, { waitForLock: true });
    nowSpy.mockRestore();
    expect(isSyncFused('balances')).toBe(false);
    __resetSyncFuseStateForTests();
  });

  it('returns null (skips the read) when the WASM client lock is busy', async () => {
    // A transaction/sync holds withWasmClientLock — tryWithWasmClientLock can't
    // acquire, so it skips without running the read op.
    mockTryWithWasmClientLock.mockImplementationOnce(async () => ({ ran: false }));

    const result = await fetchBalances('my-address', {});

    expect(result).toBeNull();
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('returns default MIDEN balance when account not found', async () => {
    mockGetAccount.mockResolvedValueOnce(null);

    const result = (await fetchBalances('unknown-address', {}))!;

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      tokenId: 'miden-faucet-id',
      tokenSlug: 'MIDEN',
      metadata: expect.objectContaining(MIDEN_METADATA),
      // MIDEN is not on the price feed: no price, never a $1 guess.
      fiatPrice: 0,
      balance: 0,
      change24h: 0
    });
  });

  it('returns empty list when account not found AND native-asset discovery has not resolved', async () => {
    // Pre-discovery state: getFaucetIdSetting returns '' / undefined, so we
    // can't fabricate a "0 MIDEN" row and must return [] so the UI renders a
    // skeleton instead of a misattributed token.
    const { getFaucetIdSetting } = jest.requireMock('lib/miden/assets');
    getFaucetIdSetting.mockReturnValueOnce(undefined);
    mockGetAccount.mockResolvedValueOnce(null);

    const result = (await fetchBalances('unknown-address', {}))!;

    expect(result).toEqual([]);
  });

  it('returns balances for account with assets', async () => {
    // Mock so bech32 conversion always returns the miden faucet id for this test
    // (called multiple times: filter check + map in balance building)
    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    getBech32AddressFromAccountId.mockImplementation(() => 'miden-faucet-id');

    const mockAssets = [
      {
        faucetId: () => 'raw-miden-faucet',
        amount: () => ({ toString: () => '100000000' }) // 1 MIDEN (8 decimals per mock)
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    const result = (await fetchBalances('my-address', {}))!;

    expect(result).toHaveLength(1);
    expect(result[0]!.tokenSlug).toBe('MIDEN');
    expect(result[0]!.balance).toBe(1);

    // Restore default mock
    getBech32AddressFromAccountId.mockImplementation((id: string) => `bech32-${id}`);
  });

  it('includes zero MIDEN balance if not in vault', async () => {
    const tokenMetadata: AssetMetadata = { name: 'Other Token', symbol: 'OTH', decimals: 6 };
    const mockAssets = [
      {
        faucetId: () => 'other-faucet',
        amount: () => ({ toString: () => '1000000' }) // 1 OTH (6 decimals)
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    const result = (await fetchBalances('my-address', { 'bech32-other-faucet': tokenMetadata }))!;

    // Should NOT call fetchTokenMetadata — metadata already cached in tokenMetadatas
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    // Other token
    expect(result[0]!.tokenSlug).toBe('OTH');
    expect(result[0]!.balance).toBe(1);
    // MIDEN with 0 balance
    expect(result[1]!.tokenSlug).toBe('MIDEN');
    expect(result[1]!.balance).toBe(0);
  });

  it('does not wait forever on a metadata lookup that never answers', async () => {
    // The read holds the address's in-flight entry until it returns, so a node that accepts the
    // metadata request and never answers would otherwise block every balance read (#1123).
    jest.useFakeTimers();
    try {
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'hung-faucet', amount: () => ({ toString: () => '1000000' }) }]
        })
      });
      mockFetchTokenMetadata.mockReturnValueOnce(new Promise(() => {}));

      const read = fetchBalances('my-address', {});
      await jest.advanceTimersByTimeAsync(15_001);
      const result = (await read)!;

      expect(result.map(row => row.tokenSlug)).toEqual(['Unknown', 'MIDEN']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('prices each row by its price symbol, and leaves a token the feed does not quote unpriced', async () => {
    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    getBech32AddressFromAccountId.mockImplementation((id: string) =>
      id === 'raw-ieth' ? TOKEN_IETH.faucetId : `bech32-${id}`
    );
    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => [
          { faucetId: () => 'raw-ieth', amount: () => ({ toString: () => '38000000' }) },
          { faucetId: () => 'other-faucet', amount: () => ({ toString: () => '1000000' }) }
        ]
      })
    });

    const result = (await fetchBalances(
      'my-address',
      {
        [TOKEN_IETH.faucetId]: { name: 'IETH', symbol: 'IETH', decimals: 8 },
        'bech32-other-faucet': { name: 'Other Token', symbol: 'OTH', decimals: 6 }
      },
      { tokenPrices: { ETH: { price: 3000, change24h: 40, percentageChange24h: 1.2 } } }
    ))!;

    const priceOf = (slug: string) => {
      const { fiatPrice, change24h } = result.find(row => row.tokenSlug === slug)!;
      return { fiatPrice, change24h };
    };
    expect(priceOf('IETH')).toEqual({ fiatPrice: 3000, change24h: 40 });
    expect(priceOf('OTH')).toEqual({ fiatPrice: 0, change24h: 0 });
    expect(priceOf('MIDEN')).toEqual({ fiatPrice: 0, change24h: 0 });

    getBech32AddressFromAccountId.mockImplementation((id: string) => `bech32-${id}`);
  });

  describe('the user override of a token', () => {
    const customMetadata = { name: 'Custom', symbol: 'CST', decimals: 8 };

    it("scales the balance by the faucet's decimals and shows the overridden name and symbol", async () => {
      mockGetTokenMetadataOverrides.mockResolvedValue({
        'bech32-custom-faucet': { name: 'Mine', symbol: 'MN', decimals: 6 }
      });
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'custom-faucet', amount: () => ({ toString: () => '150000000' }) }]
        })
      });

      const result = (await fetchBalances('my-address', { 'bech32-custom-faucet': customMetadata }))!;

      // 150000000 base units at the faucet's 8 decimals: a stored decimals value never rescales a known scale.
      const row = result.find(entry => entry.tokenId === 'bech32-custom-faucet')!;
      expect(row).toMatchObject({ tokenSlug: 'MN', balance: 1.5 });
      expect(row.metadata).toStrictEqual({ name: 'Mine', symbol: 'MN', decimals: 8 });
    });

    it('applies the override over a fetched record, and stores the record as the faucet gave it', async () => {
      const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');
      mockGetTokenMetadataOverrides.mockResolvedValue({
        'bech32-custom-faucet': { name: 'Mine', symbol: 'MN', decimals: 2 }
      });
      mockFetchTokenMetadata.mockResolvedValueOnce(customMetadata);
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'custom-faucet', amount: () => ({ toString: () => '500000000' }) }]
        })
      });

      const result = (await fetchBalances('my-address', {}))!;

      expect(result.find(row => row.tokenId === 'bech32-custom-faucet')).toMatchObject({
        tokenSlug: 'MN',
        balance: 5,
        metadata: { name: 'Mine', symbol: 'MN', decimals: 8 }
      });
      expect(setTokensBaseMetadata).toHaveBeenCalledWith({ 'bech32-custom-faucet': customMetadata });
    });

    it('gives a quantity to a token whose faucet could not be read, once the user states its decimals', async () => {
      mockGetTokenMetadataOverrides.mockResolvedValue({
        'bech32-unknown-faucet': { name: 'Mine', symbol: 'MN', decimals: 3 }
      });
      mockFetchTokenMetadata.mockRejectedValueOnce(new Error('Not found'));
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'unknown-faucet', amount: () => ({ toString: () => '2000' }) }]
        })
      });

      const result = (await fetchBalances('my-address', {}))!;

      expect(result.find(row => row.tokenId === 'bech32-unknown-faucet')).toMatchObject({
        balance: 2,
        metadata: { decimals: 3, scaleIsUnknown: false, scaleFromOverride: true }
      });
    });

    it('fetches the metadata of a faucet whose store entry only an override made, and persists its record', async () => {
      const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');
      const override = { name: 'Mine', symbol: 'MN', decimals: 3 };
      __resetFaucetAssetsMetadataForTest();
      useWalletStore.setState({ assetsMetadata: {}, tokenMetadataOverrides: {}, balances: {}, tokenPrices: {} });
      // The provider's hydration of a stored override for a faucet with no record: the placeholder with the override on top.
      useWalletStore.getState().hydrateTokenMetadataOverrides({ 'bech32-fresh-faucet': override });
      mockGetTokenMetadataOverrides.mockResolvedValue({ 'bech32-fresh-faucet': override });
      mockFetchTokenMetadata.mockResolvedValueOnce(customMetadata);
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'fresh-faucet', amount: () => ({ toString: () => '150000000' }) }]
        })
      });

      await useWalletStore.getState().fetchBalances('my-address', useWalletStore.getState().assetsMetadata);

      expect(mockFetchTokenMetadata).toHaveBeenCalledWith('bech32-fresh-faucet');
      expect(setTokensBaseMetadata).toHaveBeenCalledWith({ 'bech32-fresh-faucet': customMetadata });
      const state = useWalletStore.getState();
      expect(state.assetsMetadata['bech32-fresh-faucet']).toStrictEqual({ name: 'Mine', symbol: 'MN', decimals: 8 });
      expect(state.balances['my-address']!.find(row => row.tokenId === 'bech32-fresh-faucet')).toMatchObject({
        tokenSlug: 'MN',
        balance: 1.5
      });
    });

    it('reports the display faucet setting it read, once', async () => {
      const onDisplayFaucetId = jest.fn();
      mockGetAccount.mockResolvedValueOnce({ vault: () => ({ fungibleAssets: () => [] }) });

      await fetchBalances('my-address', {}, { onDisplayFaucetId });

      expect(onDisplayFaucetId.mock.calls).toEqual([['miden-faucet-id']]);
    });

    it('reports each faucet whose row it built with an override, and only those', async () => {
      const onOverrideApplied = jest.fn();
      mockGetTokenMetadataOverrides.mockResolvedValue({
        'bech32-custom-faucet': { name: 'Mine', symbol: 'MN' },
        'miden-faucet-id': { name: 'Fake', symbol: 'FAKE' }
      });
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [
            { faucetId: () => 'custom-faucet', amount: () => ({ toString: () => '100000000' }) },
            { faucetId: () => 'plain-faucet', amount: () => ({ toString: () => '100000000' }) }
          ]
        })
      });

      await fetchBalances(
        'my-address',
        { 'bech32-custom-faucet': customMetadata, 'bech32-plain-faucet': customMetadata },
        { onOverrideApplied }
      );

      expect(onOverrideApplied.mock.calls).toEqual([['bech32-custom-faucet']]);
    });

    it('reads the balances without overrides when the overrides cannot be read', async () => {
      mockGetTokenMetadataOverrides.mockRejectedValue(new Error('storage unavailable'));
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'custom-faucet', amount: () => ({ toString: () => '100000000' }) }]
        })
      });

      const result = (await fetchBalances('my-address', { 'bech32-custom-faucet': customMetadata }))!;

      expect(result.find(row => row.tokenId === 'bech32-custom-faucet')).toMatchObject({
        tokenSlug: 'CST',
        balance: 1
      });
    });
  });

  it('shows unknown tokens with default metadata when fetch fails', async () => {
    const mockAssets = [
      {
        faucetId: () => 'unknown-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // fetchTokenMetadata will throw for unknown token — falls back to DEFAULT_TOKEN_METADATA
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('Not found'));

    const result = (await fetchBalances('my-address', {}))!;

    // Unknown token shown with default metadata + MIDEN with 0 balance
    expect(result).toHaveLength(2);
    expect(result[0]!.tokenSlug).toBe('Unknown');
    expect(result[1]!.tokenSlug).toBe('MIDEN');
  });

  it('fetches metadata inline and calls setAssetsMetadata', async () => {
    const mockSetAssetsMetadata = jest.fn();
    const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');

    const mockAssets = [
      {
        faucetId: () => 'new-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // Mock fetchTokenMetadata to return metadata for the new faucet
    mockFetchTokenMetadata.mockResolvedValueOnce({
      decimals: 6,
      symbol: 'NEW',
      name: 'NEW'
    });

    await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata });

    // Should call fetchTokenMetadata with the bech32 asset id
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('bech32-new-faucet');
    // Should call setAssetsMetadata with fetched metadata
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({
      'bech32-new-faucet': expect.objectContaining({
        symbol: 'NEW',
        decimals: 6
      })
    });
    // Should persist metadata
    expect(setTokensBaseMetadata).toHaveBeenCalled();
  });

  it('uses fetchTokenMetadata for metadata fetching (no importAccountById)', async () => {
    const mockSetAssetsMetadata = jest.fn();
    const mockAssets = [
      {
        faucetId: () => 'new-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // Mock fetchTokenMetadata to return metadata (simulates RPC fetch)
    mockFetchTokenMetadata.mockResolvedValueOnce({
      decimals: 8,
      symbol: 'FETCHED',
      name: 'FETCHED'
    });

    await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata });

    // Should delegate metadata fetching to fetchTokenMetadata
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('bech32-new-faucet');
    // Should call setAssetsMetadata with fetched metadata
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({
      'bech32-new-faucet': expect.objectContaining({
        symbol: 'FETCHED',
        decimals: 8
      })
    });
  });

  it('falls back to DEFAULT_TOKEN_METADATA when fetchTokenMetadata throws', async () => {
    const mockSetAssetsMetadata = jest.fn();
    const mockAssets = [
      {
        faucetId: () => 'bad-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // fetchTokenMetadata throws — should not break balance loading
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('RPC error'));

    const result = (await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata }))!;

    // The token still lists, under the placeholder, so a failed lookup does not
    // make the user's holding vanish from the screen.
    expect(result).toHaveLength(2);
    expect(result[0]!.tokenSlug).toBe('Unknown');
  });

  // A thrown lookup is transient. Publishing the placeholder would end the
  // retries — the faucet is skipped once metadata is known — so the guessed
  // decimals would outlive the outage with no path back to the real ones.
  it('does not persist the placeholder when the metadata lookup throws', async () => {
    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    getBech32AddressFromAccountId.mockReturnValue('bech32-bad-faucet');
    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => [{ faucetId: () => 'bad-faucet', amount: () => BigInt(1000) }]
      })
    });
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('RPC error'));
    const mockSetAssetsMetadata = jest.fn();
    const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');

    await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata });

    // Nothing at all is written for this faucet, so the next refresh sees it as
    // still-unknown and tries the lookup again.
    const wroteBadFaucet = (fn: jest.Mock) =>
      fn.mock.calls.some(([written]: [Record<string, unknown>]) => 'bech32-bad-faucet' in written);

    expect(wroteBadFaucet(mockSetAssetsMetadata)).toBe(false);
    expect(wroteBadFaucet(setTokensBaseMetadata)).toBe(false);
  });

  it('skips MIDEN token when fetching metadata', async () => {
    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    // Return miden-faucet-id for both the filter and the balance loop
    getBech32AddressFromAccountId.mockReturnValue('miden-faucet-id');

    const mockAssets = [
      {
        faucetId: () => 'raw-miden-faucet',
        amount: () => ({ toString: () => '100000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    await fetchBalances('my-address', {});

    // Should NOT call fetchTokenMetadata for the MIDEN token
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();

    // Reset mock to default behavior
    getBech32AddressFromAccountId.mockImplementation((id: string) => `bech32-${id}`);
  });

  it('reads from IndexedDB (getAccount) without calling syncState', async () => {
    const mockAssets = [
      {
        faucetId: () => 'raw-miden-faucet',
        amount: () => ({ toString: () => '100000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    getBech32AddressFromAccountId.mockReturnValueOnce('miden-faucet-id');

    await fetchBalances('my-address', {});

    // Should read from IndexedDB
    expect(mockGetAccount).toHaveBeenCalledWith('my-address');
    // Should NOT call syncState - that happens separately via AutoSync
    expect(mockSyncState).not.toHaveBeenCalled();
  });
  describe('a read the store lands builds each row from the faucet record', () => {
    const LEGACY = 'legacy-faucet';
    const legacyRecord = { name: 'Legacy', symbol: 'LEGACY', decimals: 2 };
    const vaultOf = (...entries: [string, string][]) => ({
      vault: () => ({
        fungibleAssets: () =>
          entries.map(([faucetId, amount]) => ({
            faucetId: () => faucetId,
            amount: () => ({ toString: () => amount })
          }))
      })
    });

    beforeEach(() => {
      __resetFaucetAssetsMetadataForTest();
      useWalletStore.setState({
        assetsMetadata: {},
        tokenMetadataOverrides: {},
        balances: {},
        tokenPrices: {},
        balancesDisplayFaucetId: {}
      });
    });

    afterEach(() => {
      mockNativeAssetId = 'miden-faucet-id';
      jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockReturnValue('miden-faucet-id');
    });

    it('shows the placeholder for an unresolved faucet whose override was cleared while the read was held', async () => {
      const UNRESOLVED = 'bech32-unresolved-faucet';
      // A failed lookup puts the faucet in backoff, so the held read does not fetch it again.
      mockFetchTokenMetadata.mockRejectedValueOnce(new Error('Not found'));
      mockGetAccount.mockResolvedValueOnce(vaultOf(['unresolved-faucet', '2000000']));
      await fetchBalances('priming-address', {});
      useWalletStore
        .getState()
        .hydrateTokenMetadataOverrides({ [UNRESOLVED]: { name: 'Mine', symbol: 'MN', decimals: 3 } });
      let releaseAccount: () => void = () => {};
      mockGetAccount.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            releaseAccount = () => resolve(vaultOf(['unresolved-faucet', '2000000']));
          })
      );
      const read = useWalletStore.getState().fetchBalances('my-address', useWalletStore.getState().assetsMetadata);

      await useWalletStore.getState().clearTokenMetadataOverride(UNRESOLVED);
      mockGetTokenMetadataOverrides.mockResolvedValue({});
      releaseAccount();
      await read;

      const landed = useWalletStore.getState().balances['my-address']!.find(row => row.tokenId === UNRESOLVED)!;
      expect(landed.tokenSlug).toBe('Unknown');
      expect(landed.balance).toBe(2);
      expect(mockFetchTokenMetadata).toHaveBeenCalledTimes(1);
    });

    it('builds the display row of a legacy faucet setting from its record, not the entry its override made', async () => {
      mockNativeAssetId = 'bech32-native-faucet';
      jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockReturnValue(LEGACY);
      // The store holds the record; the storage cache does not.
      useWalletStore.getState().setAssetsMetadata({ [LEGACY]: legacyRecord });
      useWalletStore.getState().hydrateTokenMetadataOverrides({ [LEGACY]: { name: 'Mine', symbol: 'MINE' } });
      mockGetAccount.mockResolvedValueOnce(vaultOf());

      await useWalletStore.getState().fetchBalances('my-address', useWalletStore.getState().assetsMetadata);
      const displayRow = () => useWalletStore.getState().balances['my-address']!.find(row => row.tokenId === LEGACY)!;

      expect(displayRow().tokenSlug).toBe('LEGACY');
      await useWalletStore.getState().clearTokenMetadataOverride(LEGACY);
      expect(displayRow().tokenSlug).toBe('LEGACY');
      expect(displayRow().metadata).toMatchObject(legacyRecord);
    });
  });

  // Neither storing the guess nor re-asking every few seconds is acceptable: the
  // first answers the question forever with a wrong number, the second turns an
  // unreadable faucet into a permanent RPC drip on a list that refreshes every
  // few seconds. The record stays absent and the retry is spaced out instead.
  describe('an unresolvable faucet', () => {
    function accountWithBadFaucet() {
      mockGetAccount.mockResolvedValueOnce({
        vault: () => ({
          fungibleAssets: () => [{ faucetId: () => 'bad-faucet', amount: () => BigInt(1000) }]
        })
      });
    }

    it('is not retried on the very next refresh', async () => {
      const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
      getBech32AddressFromAccountId.mockReturnValue('bech32-bad-faucet');
      mockFetchTokenMetadata.mockRejectedValue(new Error('RPC error'));

      accountWithBadFaucet();
      await fetchBalances('my-address', {}, {});
      expect(mockFetchTokenMetadata).toHaveBeenCalledTimes(1);

      accountWithBadFaucet();
      await fetchBalances('my-address', {}, {});
      expect(mockFetchTokenMetadata).toHaveBeenCalledTimes(1);
    });

    // The placeholder is returned, not thrown, when the faucet was reached but
    // could not be read — that lands on the success path, which is how it used
    // to get persisted despite `fetchTokenMetadata` deliberately not caching it.
    it('is not persisted when the lookup RESOLVES to the placeholder', async () => {
      const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
      getBech32AddressFromAccountId.mockReturnValue('bech32-bad-faucet');
      const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');
      const placeholder = { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true };
      mockFetchTokenMetadata.mockResolvedValue(placeholder);

      accountWithBadFaucet();
      const result = (await fetchBalances('my-address', {}, {}))!;

      const wrote = setTokensBaseMetadata.mock.calls.some(
        ([written]: [Record<string, unknown>]) => written && 'bech32-bad-faucet' in written
      );
      expect(wrote).toBe(false);
      // Still listed — an unresolved holding is a real one.
      expect(result.some(b => b.tokenId === 'bech32-bad-faucet')).toBe(true);
    });

    it('still lists the token while its lookup is in backoff', async () => {
      const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
      getBech32AddressFromAccountId.mockReturnValue('bech32-bad-faucet');
      mockFetchTokenMetadata.mockRejectedValue(new Error('RPC error'));

      accountWithBadFaucet();
      await fetchBalances('my-address', {}, {});

      accountWithBadFaucet();
      const result = (await fetchBalances('my-address', {}, {}))!;

      const row = result.find(b => b.tokenId === 'bech32-bad-faucet');
      expect(row).toBeDefined();
      expect(row!.metadata.symbol).toBe('Unknown');
    });
  });
});

describe('actual native balance with a separate legacy display selection', () => {
  const actual = 'bech32-native-A';
  const legacy = 'legacy-B';
  const foreign = 'bech32-foreign';
  beforeEach(() => {
    jest
      .requireMock('lib/miden/sdk/helpers')
      .getBech32AddressFromAccountId.mockReset()
      .mockImplementation((id: string) => `bech32-${id}`);
    mockGetAccount.mockReset();
    mockFetchTokenMetadata.mockReset();
    mockNativeAssetId = actual;
    mockNativeMetadata = { symbol: 'USDCX', decimals: 6 };
    jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockReturnValue(legacy);
    mockGetAccount.mockResolvedValue({
      vault: () => ({
        fungibleAssets: () => [
          { faucetId: () => 'native-A', amount: () => ({ toString: () => '1000000' }) },
          { faucetId: () => 'foreign', amount: () => ({ toString: () => '200000000' }) }
        ]
      })
    });
  });
  afterEach(() => {
    mockNativeAssetId = 'miden-faucet-id';
    mockNativeMetadata = { symbol: 'MIDEN', decimals: 8 };
    jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockReturnValue('miden-faucet-id');
  });
  it.each([legacy, actual, undefined])('uses actual native metadata with legacy selection %s', async selection => {
    jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockReturnValue(selection);
    const balances = (await fetchBalances(
      'native-account',
      {
        [actual]: { symbol: 'MIDEN', name: 'Miden', decimals: 8 },
        [legacy]: { symbol: 'LEGACY', name: 'Legacy', decimals: 2 },
        [foreign]: { symbol: 'FOREIGN', name: 'Foreign', decimals: 8 }
      },
      { tokenPrices: {} }
    ))!;
    const native = balances.find(row => row.tokenId === actual)!;
    expect(native.balance).toBe(1);
    expect(native.metadata).toMatchObject({ symbol: 'USDCX', decimals: 6 });
    expect(native.fiatPrice * native.balance).toBe(1);
    expect(balances.find(row => row.tokenId === foreign)).toMatchObject({ balance: 2, tokenSlug: 'FOREIGN' });
    expect(
      balances.filter(row => row.tokenId === legacy).map(({ balance, tokenSlug }) => ({ balance, tokenSlug }))
    ).toEqual(selection === legacy ? [{ balance: 0, tokenSlug: 'LEGACY' }] : []);
  });
  it('fetches uncached legacy display metadata without fetching or pricing it as the actual native asset', async () => {
    jest
      .requireMock('lib/miden/sdk/helpers')
      .getBech32AddressFromAccountId.mockImplementation((id: string) => (id === legacy ? legacy : `bech32-${id}`));
    mockGetAccount.mockResolvedValue({
      vault: () => ({
        fungibleAssets: () => [
          { faucetId: () => 'native-A', amount: () => ({ toString: () => '1000000' }) },
          { faucetId: () => legacy, amount: () => ({ toString: () => '125' }) }
        ]
      })
    });
    const legacyMetadata = { symbol: 'USDCX', name: 'Legacy', decimals: 2 };
    mockFetchTokenMetadata.mockResolvedValue(legacyMetadata);
    const setAssetsMetadata = jest.fn();
    const balances = (await fetchBalances(
      'native-legacy-cache-miss',
      {
        [actual]: { symbol: 'MIDEN', name: 'Miden', decimals: 8 }
      },
      { tokenPrices: {}, setAssetsMetadata }
    ))!;
    expect(mockFetchTokenMetadata.mock.calls).toEqual([[legacy]]);
    expect(setAssetsMetadata).toHaveBeenCalledWith({ [legacy]: legacyMetadata });
    expect(balances.find(row => row.tokenId === legacy)).toMatchObject({
      balance: 1.25,
      metadata: legacyMetadata,
      tokenSlug: 'USDCX',
      fiatPrice: 0
    });
    expect(balances.find(row => row.tokenId === legacy)!.metadata.scaleIsUnknown).not.toBe(true);
    expect(balances.find(row => row.tokenId === actual)).toMatchObject({
      balance: 1,
      metadata: { symbol: 'USDCX', decimals: 6 },
      fiatPrice: 1
    });
  });

  it('preserves native eight-decimal scale against cached six-decimal metadata', async () => {
    mockNativeMetadata = { symbol: 'USDCX', decimals: 8 };
    mockGetAccount.mockResolvedValue({
      vault: () => ({
        fungibleAssets: () => [{ faucetId: () => 'native-A', amount: () => ({ toString: () => '100000000' }) }]
      })
    });
    const native = (await fetchBalances(
      'native-account',
      { [actual]: { symbol: 'USDCX', name: 'USDCX', decimals: 6 } },
      { tokenPrices: {} }
    ))!.find(row => row.tokenId === actual)!;
    expect(native.balance).toBe(1);
    expect(native.metadata.decimals).toBe(8);
    expect(native.fiatPrice).toBe(1);
  });
});
