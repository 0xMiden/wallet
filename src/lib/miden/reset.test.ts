/* eslint-disable import/first */

const _g = globalThis as any;
_g.__resetTest = {
  prefStub: { keys: jest.fn(), remove: jest.fn(), clear: jest.fn() }
};
const prefStub = _g.__resetTest.prefStub;
const mockPrefStore = new Map<string, string>();
const mockExtensionStore = new Map<string, string>();

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

const mockBrowserStorageGet = jest.fn();
const mockBrowserStorageRemove = jest.fn();
const mockBrowserStorageClear = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: {
        get: (...args: unknown[]) => mockBrowserStorageGet(...args),
        remove: (...args: unknown[]) => mockBrowserStorageRemove(...args),
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

const OVERRIDE = '{"networkName":"localnet","rpcUrl":"https://rpc.custom"}';

type PlatformStore = {
  name: string;
  select: () => void;
  set: (key: string, value: string) => void;
  get: (key: string) => string | undefined;
  failNextRemove: (error: Error) => void;
};

const afterEachRestores: Array<() => void> = [];

const MOBILE: PlatformStore = {
  name: 'mobile',
  select: () => (isMobile as jest.Mock).mockReturnValue(true),
  set: (key, value) => mockPrefStore.set(key, value),
  get: key => mockPrefStore.get(key),
  failNextRemove: error => prefStub.remove.mockRejectedValueOnce(error)
};

const DESKTOP: PlatformStore = {
  name: 'desktop',
  select: () => (isDesktop as jest.Mock).mockReturnValue(true),
  set: (key, value) => localStorage.setItem(`miden_wallet_${key}`, value),
  get: key => localStorage.getItem(`miden_wallet_${key}`) ?? undefined,
  failNextRemove: error => {
    const spy = jest.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
      throw error;
    });
    afterEachRestores.push(() => spy.mockRestore());
  }
};

const EXTENSION: PlatformStore = {
  name: 'extension',
  select: () => (isExtension as jest.Mock).mockReturnValue(true),
  set: (key, value) => mockExtensionStore.set(key, value),
  get: key => mockExtensionStore.get(key),
  failNextRemove: error => mockBrowserStorageRemove.mockRejectedValueOnce(error)
};

// fetchFromStorage and putToStorage reach the same store, so a snapshot-and-restore wipe would
// keep the override and only the no-read/no-write assertions would tell it apart.
function seedPlatform(platform: PlatformStore) {
  platform.select();
  platform.set('endpoint_overrides', OVERRIDE);
  platform.set('vault_data', 'vault');
  platform.set('guardian_url_setting', 'https://guardian.custom');
  mockFetchFromStorage.mockImplementation(async (key: string) => platform.get(key) ?? null);
  mockPutToStorage.mockImplementation(async (key: string, value: string) => {
    platform.set(key, value);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (isMobile as jest.Mock).mockReturnValue(false);
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isExtension as jest.Mock).mockReturnValue(false);
  localStorage.clear();
  sessionStorage.clear();
  mockPrefStore.clear();
  mockExtensionStore.clear();
  mockFetchFromStorage.mockResolvedValue(null);
  mockPutToStorage.mockResolvedValue(undefined);
  prefStub.keys.mockReset().mockImplementation(async () => ({ keys: [...mockPrefStore.keys()] }));
  prefStub.remove.mockReset().mockImplementation(async ({ key }: { key: string }) => {
    mockPrefStore.delete(key);
  });
  prefStub.clear.mockReset().mockImplementation(async () => mockPrefStore.clear());
  mockBrowserStorageGet
    .mockReset()
    .mockImplementation(async (keys: string[] | null) =>
      Object.fromEntries([...mockExtensionStore].filter(([key]) => keys === null || keys.includes(key)))
    );
  mockBrowserStorageRemove.mockReset().mockImplementation(async (keys: string[]) => {
    for (const key of keys) mockExtensionStore.delete(key);
  });
  mockBrowserStorageClear.mockReset().mockImplementation(async () => mockExtensionStore.clear());
});

afterEach(() => {
  for (const restore of afterEachRestores.splice(0)) restore();
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

  describe.each([MOBILE, DESKTOP, EXTENSION])('on $name', platform => {
    it('removes every other platform key and keeps the endpoint override without reading or rewriting it', async () => {
      seedPlatform(platform);

      await clearStorage();

      expect(platform.get('vault_data')).toBeUndefined();
      expect(platform.get('guardian_url_setting')).toBeUndefined();
      expect(platform.get('endpoint_overrides')).toBe(OVERRIDE);
      expect(mockFetchFromStorage).not.toHaveBeenCalled();
      expect(mockPutToStorage).not.toHaveBeenCalled();
    });

    it('rejects when removing a key fails, with the endpoint override still in place', async () => {
      seedPlatform(platform);
      const failure = new Error('storage unavailable');
      platform.failNextRemove(failure);

      await expect(clearStorage()).rejects.toBe(failure);

      expect(platform.get('endpoint_overrides')).toBe(OVERRIDE);
    });
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
  it('drops and reopens the IndexedDB and removes every platform key but the endpoint override', async () => {
    seedPlatform(EXTENSION);

    await resetStorageDestructive();

    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbOpen).toHaveBeenCalled();
    expect(EXTENSION.get('vault_data')).toBeUndefined();
    expect(EXTENSION.get('guardian_url_setting')).toBeUndefined();
    expect(EXTENSION.get('endpoint_overrides')).toBe(OVERRIDE);
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });
});

describe('clearClientStorage', () => {
  it("keeps the desktop platform store's keys, removes every other localStorage key and clears sessionStorage", () => {
    localStorage.setItem('miden_wallet_endpoint_overrides', '{"rpcUrl":"https://rpc.custom"}');
    localStorage.setItem('miden_wallet_guardian_url_setting', 'https://guardian.custom');
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('ui_draft', 'x');
    sessionStorage.setItem('session_key', 'y');

    clearClientStorage();

    // Vault.spawn's reset wipes the platform store itself, after reading the legacy guardian URL.
    expect(localStorage.getItem('miden_wallet_endpoint_overrides')).toBe('{"rpcUrl":"https://rpc.custom"}');
    expect(localStorage.getItem('miden_wallet_guardian_url_setting')).toBe('https://guardian.custom');
    expect(localStorage.getItem('i18nextLng')).toBeNull();
    expect(localStorage.getItem('ui_draft')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
