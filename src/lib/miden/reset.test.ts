/* eslint-disable import/first */

const _g = globalThis as any;
_g.__resetTest = {
  prefStub: { clear: jest.fn() }
};

const mockDbDelete = jest.fn();
const mockDbOpen = jest.fn();
const mockTransactionsClear = jest.fn();
const mockSpendingLimitsClear = jest.fn();
jest.mock('lib/miden/repo', () => ({
  db: {
    delete: () => mockDbDelete(),
    open: () => mockDbOpen()
  },
  transactions: {
    clear: () => mockTransactionsClear()
  },
  spendingLimits: {
    clear: () => mockSpendingLimitsClear()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isDesktop: jest.fn(() => false),
  isExtension: jest.fn(() => false)
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  resetNativeAssetCache: jest.fn(async () => {}),
  primeNativeAssetId: jest.fn()
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ENDPOINT_OVERRIDE_STORAGE_KEY: 'endpoint_overrides'
}));

const mockFetchFromStorage = jest.fn();
const mockPutToStorage = jest.fn();
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: (...a: unknown[]) => mockFetchFromStorage(...a),
  putToStorage: (...a: unknown[]) => mockPutToStorage(...a)
}));

const mockBrowserStorageClear = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: {
        clear: (...args: unknown[]) => mockBrowserStorageClear(...args)
      }
    }
  }
}));

jest.mock(
  '@capacitor/preferences',
  () => ({
    Preferences: (globalThis as any).__resetTest.prefStub
  }),
  { virtual: true }
);

import { primeNativeAssetId, resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { isDesktop, isExtension, isMobile } from 'lib/platform';

import { clearClientStorage, clearStorage, resetStorageDestructive } from './reset';

beforeEach(() => {
  jest.clearAllMocks();
  (isMobile as jest.Mock).mockReturnValue(false);
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isExtension as jest.Mock).mockReturnValue(false);
  mockFetchFromStorage.mockResolvedValue(null);
  mockPutToStorage.mockResolvedValue(undefined);
  // clearAllMocks keeps queued once-values, so one a failing test never used would reach the next.
  for (const step of [
    mockDbDelete,
    mockDbOpen,
    mockTransactionsClear,
    mockSpendingLimitsClear,
    mockBrowserStorageClear
  ]) {
    step.mockReset().mockResolvedValue(undefined);
  }
});

describe('clearStorage', () => {
  it('clears the transactions table by default and never deletes the DB', async () => {
    await clearStorage();
    expect(mockTransactionsClear).toHaveBeenCalled();
    // The caps and the history they are computed from go together. Recovery from the same
    // mnemonic reproduces the same account ids, so a configuration left behind here would keep
    // enforcing a cap over a spend total that was just zeroed.
    expect(mockSpendingLimitsClear).toHaveBeenCalled();
    // db.delete() would force every other open handle closed and leave the
    // page Dexie connection unrecoverable — see commit message.
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockDbOpen).not.toHaveBeenCalled();
  });

  it('skips the table clear when clearDb=false', async () => {
    await clearStorage(false);
    expect(mockTransactionsClear).not.toHaveBeenCalled();
    expect(mockSpendingLimitsClear).not.toHaveBeenCalled();
    expect(mockDbDelete).not.toHaveBeenCalled();
  });

  it('clears Capacitor Preferences on mobile', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    _g.__resetTest.prefStub.clear.mockResolvedValueOnce(undefined);
    await clearStorage();
    expect(_g.__resetTest.prefStub.clear).toHaveBeenCalled();
  });

  it('clears localStorage on desktop', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    const setSpy = jest.spyOn(Storage.prototype, 'clear');
    await clearStorage();
    expect(setSpy).toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('clears browser.storage.local on extension', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    await clearStorage();
    expect(mockBrowserStorageClear).toHaveBeenCalled();
  });

  it('preserves the endpoint override across the wipe (snapshot → clear → restore)', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    const OVERRIDE = { networkName: 'localnet', rpcUrl: 'https://rpc.custom' };
    mockFetchFromStorage.mockImplementation(async (k: string) => (k === 'endpoint_overrides' ? OVERRIDE : null));

    await clearStorage();

    expect(mockFetchFromStorage).toHaveBeenCalledWith('endpoint_overrides');
    expect(mockPutToStorage).toHaveBeenCalledWith('endpoint_overrides', OVERRIDE);
    // Order is load-bearing: the override must be READ before the wipe and
    // RESTORED after it, or the blanket clear() would erase it.
    expect(mockFetchFromStorage.mock.invocationCallOrder[0]!).toBeLessThan(
      mockBrowserStorageClear.mock.invocationCallOrder[0]!
    );
    expect(mockBrowserStorageClear.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPutToStorage.mock.invocationCallOrder[0]!
    );
  });

  it('does not restore an endpoint override that was never set', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockFetchFromStorage.mockResolvedValue(null);
    await clearStorage();
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('rediscovers the native asset right after resetting its cache, so the first balance after an import does not wait on it (#1123)', async () => {
    const order: string[] = [];
    (resetNativeAssetCache as jest.Mock).mockImplementation(async () => {
      await Promise.resolve();
      order.push('reset');
    });
    (primeNativeAssetId as jest.Mock).mockImplementation(() => {
      order.push('prime');
    });

    await clearStorage();

    expect(order).toEqual(['reset', 'prime']);
  });
});

describe('resetStorageDestructive', () => {
  it('drops and reopens the IndexedDB and clears platform storage', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    await resetStorageDestructive();
    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbOpen).toHaveBeenCalled();
    expect(mockBrowserStorageClear).toHaveBeenCalled();
  });

  // The options page calls it with no options and relies on the override surviving.
  it('keeps the endpoint override across the wipe by default', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    const OVERRIDE = { networkName: 'localnet', rpcUrl: 'https://rpc.custom' };
    mockFetchFromStorage.mockImplementation(async (k: string) => (k === 'endpoint_overrides' ? OVERRIDE : null));

    await resetStorageDestructive();

    expect(mockPutToStorage).toHaveBeenCalledWith('endpoint_overrides', OVERRIDE);
    expect(mockBrowserStorageClear.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPutToStorage.mock.invocationCallOrder[0]!
    );
  });

  it('clears the endpoint override when asked not to keep it', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    const OVERRIDE = { networkName: 'localnet', rpcUrl: 'https://rpc.custom' };
    mockFetchFromStorage.mockImplementation(async (k: string) => (k === 'endpoint_overrides' ? OVERRIDE : null));

    await resetStorageDestructive({ keepEndpointOverride: false });

    expect(mockBrowserStorageClear).toHaveBeenCalled();
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  // The key-value store holds the vault, so clearing it first leaves no wallet to unlock after a
  // later step rejects.
  it('clears the key-value store before it deletes the database', async () => {
    jest.mocked(isExtension).mockReturnValue(true);

    await resetStorageDestructive();

    expect(mockBrowserStorageClear.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDbDelete.mock.invocationCallOrder[0]!
    );
  });

  it('rejects without deleting the database when the key-value clear rejects', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    const clearError = new Error('storage clear failed');
    mockBrowserStorageClear.mockRejectedValueOnce(clearError);

    await expect(resetStorageDestructive()).rejects.toBe(clearError);

    expect(mockDbDelete).not.toHaveBeenCalled();
  });

  it('clears the transactions and spending limits when the delete rejects', async () => {
    const deleteError = new Error('delete blocked');
    mockDbDelete.mockRejectedValueOnce(deleteError);

    await expect(resetStorageDestructive()).rejects.toBe(deleteError);

    expect(mockTransactionsClear).toHaveBeenCalledTimes(1);
    expect(mockSpendingLimitsClear).toHaveBeenCalledTimes(1);
  });

  it('still clears the spending limits and rethrows the delete error when the cleanup steps reject', async () => {
    const deleteError = new Error('delete blocked');
    mockDbDelete.mockRejectedValueOnce(deleteError);
    mockDbOpen.mockRejectedValueOnce(new Error('open failed'));
    mockTransactionsClear.mockRejectedValueOnce(new Error('clear failed'));

    await expect(resetStorageDestructive()).rejects.toBe(deleteError);

    expect(mockSpendingLimitsClear).toHaveBeenCalledTimes(1);
  });
});

describe('clearClientStorage', () => {
  it('clears both localStorage and sessionStorage', () => {
    const localSpy = jest.spyOn(Storage.prototype, 'clear');
    clearClientStorage();
    // Both localStorage.clear() and sessionStorage.clear() share the prototype
    expect(localSpy).toHaveBeenCalledTimes(2);
    localSpy.mockRestore();
  });
});
