/* eslint-disable import/first */

const _g = globalThis as any;
_g.__resetTest = {
  prefStub: { keys: jest.fn(), remove: jest.fn(), clear: jest.fn(), set: jest.fn() }
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

const mockBrowserStorageGet = jest.fn();
const mockBrowserStorageRemove = jest.fn();
const mockBrowserStorageClear = jest.fn();
const mockBrowserStorageSet = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: {
        get: (...args: unknown[]) => mockBrowserStorageGet(...args),
        remove: (...args: unknown[]) => mockBrowserStorageRemove(...args),
        clear: (...args: unknown[]) => mockBrowserStorageClear(...args),
        set: (...args: unknown[]) => mockBrowserStorageSet(...args)
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
  localStorage.clear();
  sessionStorage.clear();
  (isMobile as jest.Mock).mockReturnValue(false);
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isExtension as jest.Mock).mockReturnValue(false);
  _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: [] });
  _g.__resetTest.prefStub.remove.mockResolvedValue(undefined);
  mockBrowserStorageGet.mockResolvedValue({});
  mockBrowserStorageRemove.mockResolvedValue(undefined);
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

  const OVERRIDE = { networkName: 'localnet', rpcUrl: 'https://rpc.custom' };
  const LEGACY_GUARDIAN = 'https://my-guardian.example';

  it('removes every Preferences key but the setup-kept ones on mobile, and never clears or writes', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockResolvedValue({
      keys: ['endpoint_overrides', 'guardian_url_setting', 'vault_key', 'accounts']
    });

    await clearStorage();

    expect(_g.__resetTest.prefStub.remove.mock.calls).toEqual([[{ key: 'vault_key' }], [{ key: 'accounts' }]]);
    expect(_g.__resetTest.prefStub.clear).not.toHaveBeenCalled();
    expect(_g.__resetTest.prefStub.set).not.toHaveBeenCalled();
  });

  it('rejects when listing the Preferences keys fails, and removes nothing', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockRejectedValue(new Error('bridge down'));

    await expect(clearStorage()).rejects.toThrow('bridge down');
    expect(_g.__resetTest.prefStub.remove).not.toHaveBeenCalled();
  });

  it('rejects when a Preferences removal fails, having never offered a kept key for removal', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: ['endpoint_overrides', 'vault_key', 'accounts'] });
    _g.__resetTest.prefStub.remove.mockRejectedValueOnce(new Error('write refused'));

    await expect(clearStorage()).rejects.toThrow('write refused');
    const removed = _g.__resetTest.prefStub.remove.mock.calls.map((c: [{ key: string }]) => c[0].key);
    expect(removed).not.toContain('endpoint_overrides');
  });

  it('removes every localStorage key but the setup-kept ones in their desktop form, and never clears or writes', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    localStorage.setItem('miden_wallet_endpoint_overrides', JSON.stringify(OVERRIDE));
    localStorage.setItem('miden_wallet_guardian_url_setting', LEGACY_GUARDIAN);
    localStorage.setItem('miden_wallet_vault_key', 'v');
    localStorage.setItem('ui_cache', 'u');
    const clearSpy = jest.spyOn(Storage.prototype, 'clear');
    const setSpy = jest.spyOn(Storage.prototype, 'setItem');

    try {
      await clearStorage();

      expect(Object.keys(localStorage).sort()).toEqual([
        'miden_wallet_endpoint_overrides',
        'miden_wallet_guardian_url_setting'
      ]);
      expect(localStorage.getItem('miden_wallet_endpoint_overrides')).toBe(JSON.stringify(OVERRIDE));
      expect(localStorage.getItem('miden_wallet_guardian_url_setting')).toBe(LEGACY_GUARDIAN);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('removes every extension key but the setup-kept ones in one call, and never clears or writes', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      endpoint_overrides: OVERRIDE,
      guardian_url_setting: LEGACY_GUARDIAN,
      vault_key: 'v',
      accounts: []
    });

    await clearStorage();

    expect(mockBrowserStorageGet).toHaveBeenCalledWith(null);
    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['vault_key', 'accounts']]]);
    expect(mockBrowserStorageClear).not.toHaveBeenCalled();
    expect(mockBrowserStorageSet).not.toHaveBeenCalled();
  });

  it('makes no removal call on the extension when only kept keys exist', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ endpoint_overrides: OVERRIDE });

    await clearStorage();

    expect(mockBrowserStorageRemove).not.toHaveBeenCalled();
  });

  it('rejects when the extension removal fails', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ vault_key: 'v' });
    mockBrowserStorageRemove.mockRejectedValue(new Error('quota'));

    await expect(clearStorage()).rejects.toThrow('quota');
  });

  it('rejects when listing the extension keys fails, and removes nothing', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockRejectedValue(new Error('storage down'));

    await expect(clearStorage()).rejects.toThrow('storage down');
    expect(mockBrowserStorageRemove).not.toHaveBeenCalled();
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
  it('drops and reopens the IndexedDB and keeps only the endpoint override, not the legacy guardian URL', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      endpoint_overrides: { rpcUrl: 'https://rpc.custom' },
      guardian_url_setting: 'https://my-guardian.example',
      vault_key: 'v'
    });

    await resetStorageDestructive();

    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbOpen).toHaveBeenCalled();
    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['guardian_url_setting', 'vault_key']]]);
    expect(mockBrowserStorageClear).not.toHaveBeenCalled();
  });
});

describe('clearClientStorage', () => {
  it('keeps the setup-kept keys in their desktop form, removes every other localStorage key, and clears sessionStorage', () => {
    localStorage.setItem('miden_wallet_endpoint_overrides', '{"rpcUrl":"https://rpc.custom"}');
    localStorage.setItem('miden_wallet_guardian_url_setting', 'https://my-guardian.example');
    localStorage.setItem('miden_wallet_vault_key', 'v');
    localStorage.setItem('ui_cache', 'u');
    sessionStorage.setItem('draft', 'd');

    clearClientStorage();

    expect(Object.keys(localStorage).sort()).toEqual([
      'miden_wallet_endpoint_overrides',
      'miden_wallet_guardian_url_setting'
    ]);
    expect(sessionStorage.length).toBe(0);
  });
});
