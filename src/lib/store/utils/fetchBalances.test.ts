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
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';

import { __resetUnresolvedFaucetsForTest, fetchBalances } from './fetchBalances';

// Mock dependencies
const mockGetAccount = jest.fn();
const mockSyncState = jest.fn();
const mockGetMidenClient = jest.fn(() => ({
  getAccount: mockGetAccount,
  syncState: mockSyncState
}));

// Defaults to "lock free" — runs the op and reports it ran. A test overrides
// this to `{ ran: false }` to exercise the WASM-busy skip path.
const mockTryWithWasmClientLock = jest.fn(
  async (operation: () => Promise<unknown>): Promise<{ ran: true; value: unknown } | { ran: false }> => ({
    ran: true,
    value: await operation()
  })
);

// The OPTIONS are the point of the #777 change here, so they have to reach an assertion:
// a mock that silently drops them lets the bound come off without a single test noticing.
const lockOptionsSeen: unknown[] = [];

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
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
  fetchTokenMetadata: (...args: unknown[]) => mockFetchTokenMetadata(...args),
  getAssetUrl: jest.fn((path: string) => `/${path}`)
}));

jest.mock('../../miden/front/assets', () => ({
  setTokensBaseMetadata: jest.fn()
}));

describe('fetchBalances', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSyncState.mockReset();
    mockFetchTokenMetadata.mockReset();
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

  it('reports its own evictions to the fuse, and a completed read puts it out', async () => {
    __resetSyncFuseStateForTests();
    const evict = () => Promise.reject(new WasmClientPoisonedError('watchdog'));

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      mockTryWithWasmClientLock.mockImplementationOnce(evict);
      await expect(fetchBalances('my-address', {})).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    }
    expect(isSyncFused('balances')).toBe(true);

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
      metadata: MIDEN_METADATA,
      fiatPrice: 1,
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
      base: {
        decimals: 6,
        symbol: 'NEW',
        name: 'NEW',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      },
      detailed: {
        decimals: 6,
        symbol: 'NEW',
        name: 'NEW',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      }
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
      base: {
        decimals: 8,
        symbol: 'FETCHED',
        name: 'FETCHED',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      },
      detailed: {
        decimals: 8,
        symbol: 'FETCHED',
        name: 'FETCHED',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      }
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
      mockFetchTokenMetadata.mockResolvedValue({ base: placeholder, detailed: placeholder });

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
