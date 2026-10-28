import '../../../test/jest-mocks';

import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { StorageHealth } from 'lib/miden/storage-health';
import { type WalletAccount, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { useWalletStore } from './index';
import { fetchingAddresses } from './utils/fetchBalances';

// The jest webextension mock makes isExtension() true, which skips the Ready-time read;
// this file is about the mobile and desktop path, where that read exists.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: jest.fn(() => false)
}));

const mockFetchBalances = jest.fn();
jest.mock('./utils/fetchBalances', () => ({
  fetchBalances: (...args: unknown[]) => mockFetchBalances(...args),
  fetchingAddresses: new Set<string>()
}));

// The display faucet setting the action reads before it lands a read: the rows below are its MIDEN rows.
jest.mock('lib/miden/assets/faucet-id-setting', () => ({
  getFaucetIdSetting: jest.fn(async () => 'miden-faucet-id')
}));

jest.mock('lib/intercom/client', () => ({
  createIntercomClient: jest.fn(() => ({ request: jest.fn(), subscribe: jest.fn(() => () => {}) }))
}));

const account: WalletAccount = {
  publicKey: 'pk1',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa'
};
const readyState = {
  storageAvailability: { status: 'healthy', epoch: 0 },
  status: WalletStatus.Ready,
  accounts: [account],
  currentAccount: account,
  networks: [],
  settings: { contacts: [] },
  ownMnemonic: true
};
const row = {
  tokenId: 'miden-faucet-id',
  tokenSlug: 'MIDEN',
  metadata: {},
  fiatPrice: 1,
  change24h: 0,
  balance: 5
} as TokenBalanceData;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the balance read when the wallet becomes Ready', () => {
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  beforeEach(() => {
    mockFetchBalances.mockReset();
    fetchingAddresses.clear();
    useWalletStore.setState({
      status: WalletStatus.Locked,
      storageAvailability: { status: 'pending' },
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {}
    });
  });

  it('is requested on the transition itself, and waits for the lock rather than skipping (#1123)', () => {
    mockFetchBalances.mockResolvedValue([row]);

    useWalletStore.getState().syncFromBackend(readyState as any);

    // Synchronously: the read has to be queued before the sync effect React runs next.
    expect(mockFetchBalances).toHaveBeenCalledTimes(1);
    expect(mockFetchBalances).toHaveBeenCalledWith(
      'pk1',
      expect.anything(),
      expect.objectContaining({ waitForLock: true })
    );
    // Metadata fetched for imported tokens reaches the store, as it does from every other reader.
    expect(mockFetchBalances.mock.calls[0][2].setAssetsMetadata).toBe(useWalletStore.getState().setAssetsMetadata);
  });

  it('stores what it read and marks the address loaded', async () => {
    mockFetchBalances.mockResolvedValue([row]);

    useWalletStore.getState().syncFromBackend(readyState as any);
    await flush();

    const state = useWalletStore.getState();
    expect(state.balances.pk1).toEqual([row]);
    expect(state.balancesLoading.pk1).toBe(false);
    expect(state.balancesLastFetched.pk1).toBeGreaterThan(0);
  });

  it('leaves the address loading when the read fails, so Home never shows the zero placeholder', async () => {
    mockFetchBalances.mockRejectedValue(new Error('evicted'));

    useWalletStore.getState().syncFromBackend(readyState as any);
    await flush();

    expect(useWalletStore.getState().balancesLoading.pk1).toBeUndefined();
    expect(useWalletStore.getState().balances.pk1).toBeUndefined();
  });

  it('keeps balances already on screen when a read on a later unlock fails', async () => {
    useWalletStore.setState({
      balances: { pk1: [row] },
      balancesLoading: { pk1: false },
      balancesLastFetched: { pk1: 1 }
    });
    mockFetchBalances.mockRejectedValue(new Error('evicted'));

    useWalletStore.getState().syncFromBackend(readyState as any);
    await flush();

    // Figures are on screen, so this read is a refresh: it must not wait behind writes.
    expect(mockFetchBalances).toHaveBeenCalledWith(
      'pk1',
      expect.anything(),
      expect.objectContaining({ waitForLock: false })
    );
    expect(useWalletStore.getState().balances.pk1).toEqual([row]);
    expect(useWalletStore.getState().balancesLoading.pk1).toBe(false);
  });

  it('holds the address in flight while the read runs, and releases it once the read lands', async () => {
    let land!: (value: TokenBalanceData[]) => void;
    mockFetchBalances.mockReturnValue(new Promise(resolve => (land = resolve)));

    useWalletStore.getState().syncFromBackend(readyState as any);

    // The hook consults this guard, so Home's first read does not queue a second hold (#1123).
    expect(fetchingAddresses.has('pk1')).toBe(true);
    land([row]);
    await flush();
    expect(fetchingAddresses.has('pk1')).toBe(false);
  });

  it('releases the address when the read fails, so the next poll can retry', async () => {
    mockFetchBalances.mockRejectedValue(new Error('evicted'));

    useWalletStore.getState().syncFromBackend(readyState as any);
    await flush();

    expect(fetchingAddresses.has('pk1')).toBe(false);
  });

  it('does not start a second read for an address already in flight', () => {
    fetchingAddresses.add('pk1');

    useWalletStore.getState().syncFromBackend(readyState as any);

    expect(mockFetchBalances).not.toHaveBeenCalled();
  });
});

describe('the store fetchBalances action', () => {
  beforeEach(() => {
    mockFetchBalances.mockReset();
    fetchingAddresses.clear();
    useWalletStore.setState({ balances: {}, balancesLoading: {}, balancesLastFetched: {} });
  });

  it('never marks an address that has balances as loading, so a refresh keeps its rows on screen', async () => {
    useWalletStore.setState({ balances: { pk1: [row] }, balancesLoading: { pk1: false } });
    let land!: (value: TokenBalanceData[]) => void;
    mockFetchBalances.mockReturnValue(new Promise(resolve => (land = resolve)));

    const refresh = useWalletStore.getState().fetchBalances('pk1', {});

    expect(useWalletStore.getState().balancesLoading.pk1).toBe(false);
    expect(mockFetchBalances).toHaveBeenCalledWith(
      'pk1',
      expect.anything(),
      expect.objectContaining({ waitForLock: false })
    );
    land([row]);
    await refresh;
    expect(useWalletStore.getState().balancesLoading.pk1).toBe(false);
    expect(fetchingAddresses.has('pk1')).toBe(false);
  });

  it('waits for the lock for an address with no balances, and leaves it loading when that read fails', async () => {
    mockFetchBalances.mockRejectedValue(new Error('evicted'));

    await expect(useWalletStore.getState().fetchBalances('pk1', {})).rejects.toThrow('evicted');

    expect(mockFetchBalances).toHaveBeenCalledWith(
      'pk1',
      expect.anything(),
      expect.objectContaining({ waitForLock: true })
    );
    expect(useWalletStore.getState().balancesLoading.pk1).toBeUndefined();
    expect(fetchingAddresses.has('pk1')).toBe(false);
  });

  it('leaves an unread address loading when its read is skipped', async () => {
    mockFetchBalances.mockResolvedValue(null);

    await useWalletStore.getState().fetchBalances('pk1', {});

    expect(useWalletStore.getState().balancesLoading.pk1).toBeUndefined();
    expect(useWalletStore.getState().balances.pk1).toBeUndefined();
    // A skipped read happens on every refresh tick a sync holds the lock through; if it kept the
    // address, no later read of it would ever start.
    expect(fetchingAddresses.has('pk1')).toBe(false);
  });

  it('skips while another reader has the address in flight', async () => {
    fetchingAddresses.add('pk1');

    await useWalletStore.getState().fetchBalances('pk1', {});

    expect(mockFetchBalances).not.toHaveBeenCalled();
    expect(useWalletStore.getState().balancesLoading.pk1).toBeUndefined();
  });
});

describe('Task5 availability', () => {
  const retainedAccount: WalletAccount = { ...account, type: WalletType.Guardian, authScheme: 'ecdsa' };

  beforeEach(() => {
    mockFetchBalances.mockReset().mockResolvedValue([row]);
    fetchingAddresses.clear();
    useWalletStore.setState({
      status: WalletStatus.Locked,
      storageAvailability: { status: 'pending' },
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {}
    });
  });

  afterEach(async () => {
    await flush();
    fetchingAddresses.clear();
  });

  it('unavailable Ready queues no balance read', () => {
    const storageAvailability: StorageHealth = {
      status: 'unavailable',
      epoch: 7,
      reason: 'continuity',
      backend: 'sdk',
      operation: 'open',
      time: 1234
    };
    const state = {
      ...readyState,
      accounts: [retainedAccount],
      currentAccount: retainedAccount,
      storageAvailability
    };

    useWalletStore.getState().syncFromBackend(state);

    expect(mockFetchBalances).not.toHaveBeenCalled();
    expect(useWalletStore.getState().status).toBe(WalletStatus.Ready);
    expect(useWalletStore.getState().balances.pk1).toBeUndefined();
    expect(fetchingAddresses.has('pk1')).toBe(false);
  });

  it('pending Ready queues no balance read', () => {
    const storageAvailability: { status: 'pending' } = { status: 'pending' };
    const state = {
      ...readyState,
      accounts: [retainedAccount],
      currentAccount: retainedAccount,
      storageAvailability
    };

    useWalletStore.getState().syncFromBackend(state);

    expect(mockFetchBalances).not.toHaveBeenCalled();
    expect(useWalletStore.getState().status).toBe(WalletStatus.Ready);
    expect(useWalletStore.getState().balances.pk1).toBeUndefined();
    expect(fetchingAddresses.has('pk1')).toBe(false);
  });
});

describe('Task5 availability followon', () => {
  const incident: StorageHealth = {
    status: 'unavailable',
    epoch: 9,
    reason: 'continuity',
    backend: 'sdk',
    operation: 'open',
    time: 1000
  };
  const healthy: StorageHealth = { status: 'healthy', epoch: 8 };

  beforeEach(() => {
    mockFetchBalances.mockReset().mockResolvedValue([row]);
    fetchingAddresses.clear();
    useWalletStore.setState({
      status: WalletStatus.Locked,
      storageAvailability: { status: 'pending' },
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {}
    });
  });

  afterEach(async () => {
    await flush();
    fetchingAddresses.clear();
  });

  it('a missing availability payload grants no balance authority', () => {
    const { storageAvailability: _omitted, ...missing } = readyState;
    useWalletStore.getState().syncFromBackend(missing);
    expect(mockFetchBalances).not.toHaveBeenCalled();
    expect(Reflect.get(useWalletStore.getState(), 'storageAvailability')).toEqual({ status: 'pending' });
  });

  it('a stale healthy Ready snapshot cannot clear an incident or start a balance read', () => {
    useWalletStore.setState({ status: WalletStatus.Ready, storageAvailability: incident });
    useWalletStore.getState().syncFromBackend({ ...readyState, storageAvailability: healthy });
    expect(Reflect.get(useWalletStore.getState(), 'storageAvailability')).toEqual(incident);
    expect(mockFetchBalances).not.toHaveBeenCalled();
  });

  it('a balance read started before an incident cannot publish a late result', async () => {
    let finish!: (rows: TokenBalanceData[]) => void;
    mockFetchBalances.mockImplementationOnce(
      () =>
        new Promise<TokenBalanceData[]>(resolve => {
          finish = resolve;
        })
    );
    useWalletStore.getState().syncFromBackend({ ...readyState, storageAvailability: healthy });
    expect(mockFetchBalances).toHaveBeenCalledTimes(1);
    useWalletStore.getState().syncFromBackend({ ...readyState, storageAvailability: incident });
    finish([row]);
    await flush();
    expect(useWalletStore.getState().balances.pk1).toBeUndefined();
  });

  it('a newer verified recovery epoch admits one balance read without changing authenticated Ready', () => {
    useWalletStore.setState({ status: WalletStatus.Ready, storageAvailability: incident });
    const recovered: StorageHealth = { status: 'healthy', epoch: 10 };
    useWalletStore.getState().syncFromBackend({ ...readyState, storageAvailability: recovered });
    expect(useWalletStore.getState().status).toBe(WalletStatus.Ready);
    expect(mockFetchBalances).toHaveBeenCalledTimes(1);
  });
});
