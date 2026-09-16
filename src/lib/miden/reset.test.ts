/* eslint-disable import/first */

const _g = globalThis as any;
_g.__resetTest = {
  prefStub: { clear: jest.fn() }
};

const mockDbDelete = jest.fn();
const mockDbOpen = jest.fn();
const mockTransactionsClear = jest.fn();
jest.mock('lib/miden/repo', () => ({
  db: {
    delete: () => mockDbDelete(),
    open: () => mockDbOpen()
  },
  transactions: {
    clear: () => mockTransactionsClear()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isDesktop: jest.fn(() => false),
  isExtension: jest.fn(() => false)
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  resetNativeAssetCache: jest.fn(async () => {})
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

import { isDesktop, isExtension, isMobile } from 'lib/platform';

import { clearClientStorage, clearStorage, resetStorageDestructive } from './reset';

beforeEach(() => {
  jest.clearAllMocks();
  (isMobile as jest.Mock).mockReturnValue(false);
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isExtension as jest.Mock).mockReturnValue(false);
  mockFetchFromStorage.mockResolvedValue(null);
  mockPutToStorage.mockResolvedValue(undefined);
});

describe('clearStorage', () => {
  it('clears the transactions table by default and never deletes the DB', async () => {
    await clearStorage();
    expect(mockTransactionsClear).toHaveBeenCalled();
    // db.delete() would force every other open handle closed and leave the
    // page Dexie connection unrecoverable — see commit message.
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockDbOpen).not.toHaveBeenCalled();
  });

  it('skips the table clear when clearDb=false', async () => {
    await clearStorage(false);
    expect(mockTransactionsClear).not.toHaveBeenCalled();
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
});

describe('resetStorageDestructive', () => {
  it('drops and reopens the IndexedDB and clears platform storage', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    await resetStorageDestructive();
    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbOpen).toHaveBeenCalled();
    expect(mockBrowserStorageClear).toHaveBeenCalled();
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
