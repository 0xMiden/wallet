/* eslint-disable import/first */

jest.unmock('lib/remote-config/wallet-access');

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

const mockReread = jest.fn<Promise<void>, []>(async () => {});
jest.mock('lib/miden/front/storage', () => ({
  rereadStorageCache: () => mockReread()
}));

jest.mock(
  '@capacitor/preferences',
  () => ({
    Preferences: (globalThis as any).__resetTest.prefStub
  }),
  { virtual: true }
);

import { CARRIED_MAINNET_CODE_STORAGE_KEY } from 'lib/carried-mainnet-code';
import { primeNativeAssetId, resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import {
  assertWalletAccessAllowed,
  getWalletAccessGeneration,
  publishWalletAccessDecision,
  registerWalletAccessRuntime
} from 'lib/remote-config/wallet-access';
import { ACTIVITY_READ_STORAGE_KEY } from 'lib/settings/constants';
import { onStorageCleared } from 'lib/storage-cleared';

import {
  clearClientStorage,
  clearStorage,
  PENDING_ADMISSION_STORAGE_KEY,
  PRESERVED_STORAGE_KEYS,
  resetStorageDestructive,
  SETUP_WIPE_KEPT_KEYS
} from './reset';

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  (isMobile as jest.Mock).mockReturnValue(false);
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isExtension as jest.Mock).mockReturnValue(false);
  // clearAllMocks keeps queued once-values, so one a failing test never used would reach the next.
  for (const step of [
    mockDbDelete,
    mockDbOpen,
    mockTransactionsClear,
    mockSpendingLimitsClear,
    mockBrowserStorageRemove,
    _g.__resetTest.prefStub.remove
  ]) {
    step.mockReset().mockResolvedValue(undefined);
  }
  _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: [] });
  mockBrowserStorageGet.mockResolvedValue({});
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

  it('removes every Preferences key but the kept ones on mobile, and never clears or writes', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: ['endpoint_overrides', 'vault_key', 'accounts'] });

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

  it('removes every localStorage key but the kept ones in their desktop form, and never clears or writes', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    localStorage.setItem('miden_wallet_endpoint_overrides', JSON.stringify(OVERRIDE));
    localStorage.setItem('miden_wallet_vault_key', 'v');
    localStorage.setItem('ui_cache', 'u');
    const clearSpy = jest.spyOn(Storage.prototype, 'clear');
    const setSpy = jest.spyOn(Storage.prototype, 'setItem');

    try {
      await clearStorage();

      expect(Object.keys(localStorage)).toEqual(['miden_wallet_endpoint_overrides']);
      expect(localStorage.getItem('miden_wallet_endpoint_overrides')).toBe(JSON.stringify(OVERRIDE));
      expect(clearSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('removes every extension key but the kept ones in one call, and never clears or writes', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ endpoint_overrides: OVERRIDE, vault_key: 'v', accounts: [] });

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

  // The registration that uses a carried mainnet code starts with this wipe, which is what makes the code single use.
  it("takes the code a switch to mainnet carried with a wallet setup's wipe", async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      endpoint_overrides: OVERRIDE,
      [PENDING_ADMISSION_STORAGE_KEY]: [],
      [CARRIED_MAINNET_CODE_STORAGE_KEY]: { code: '8gKIgL0O6HcU' }
    });

    await clearStorage(true, SETUP_WIPE_KEPT_KEYS);

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[[CARRIED_MAINNET_CODE_STORAGE_KEY]]]);
  });

  it('keeps only the list its caller passes', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ endpoint_overrides: OVERRIDE, vault_key: 'v' });

    await clearStorage(false, []);

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['endpoint_overrides', 'vault_key']]]);
  });

  it('rejects when listing the extension keys fails, and removes nothing', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockRejectedValue(new Error('storage down'));

    await expect(clearStorage()).rejects.toThrow('storage down');
    expect(mockBrowserStorageRemove).not.toHaveBeenCalled();
  });

  // The key-value store holds the vault, so a wipe that stops partway never leaves a wallet that
  // unlocks without its caps.
  it('clears the key-value store before the tables', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ vault_key: 'v' });

    await clearStorage();

    expect(mockBrowserStorageRemove.mock.invocationCallOrder[0]!).toBeLessThan(
      mockTransactionsClear.mock.invocationCallOrder[0]!
    );
    expect(mockBrowserStorageRemove.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSpendingLimitsClear.mock.invocationCallOrder[0]!
    );
  });

  it('rejects without clearing the tables when the key-value clear rejects', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ vault_key: 'v' });
    const clearError = new Error('storage clear failed');
    mockBrowserStorageRemove.mockRejectedValueOnce(clearError);

    await expect(clearStorage()).rejects.toBe(clearError);

    expect(mockTransactionsClear).not.toHaveBeenCalled();
    expect(mockSpendingLimitsClear).not.toHaveBeenCalled();
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

/** Runs `clear` over a stored read state and returns, per announcement, whether the key was gone. */
async function announcementsSeeingTheKeyGone(clear: () => unknown): Promise<boolean[]> {
  localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, JSON.stringify({ seenBefore: 1, ids: {} }));
  const seen: boolean[] = [];
  const unsubscribe = onStorageCleared(() => seen.push(localStorage.getItem(ACTIVITY_READ_STORAGE_KEY) === null));
  await clear();
  unsubscribe();
  return seen;
}

describe('resetStorageDestructive', () => {
  it('drops and reopens the IndexedDB and keeps only the endpoint override', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      endpoint_overrides: { rpcUrl: 'https://rpc.custom' },
      accounts: [],
      vault_key: 'v'
    });

    await resetStorageDestructive();

    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbOpen).toHaveBeenCalled();
    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['accounts', 'vault_key']]]);
    expect(mockBrowserStorageClear).not.toHaveBeenCalled();
  });

  it('removes the request links Bread holds on mobile, which the wallet-setup wipe keeps', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    localStorage.setItem('bread-connect:queue', '[]');

    await clearStorage();
    expect(localStorage.getItem('bread-connect:queue')).toBe('[]');

    await resetStorageDestructive();
    expect(localStorage.getItem('bread-connect:queue')).toBeNull();
  });

  // The options page calls it with no options and relies on the override surviving.
  it('keeps the endpoint override across the wipe by default', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    const OVERRIDE = { networkName: 'localnet', rpcUrl: 'https://rpc.custom' };
    mockBrowserStorageGet.mockResolvedValue({ endpoint_overrides: OVERRIDE, vault_key: 'v' });

    await resetStorageDestructive();

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['vault_key']]]);
    expect(mockBrowserStorageSet).not.toHaveBeenCalled();
  });

  it('clears the endpoint override when asked not to keep it', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    const OVERRIDE = { networkName: 'localnet', rpcUrl: 'https://rpc.custom' };
    mockBrowserStorageGet.mockResolvedValue({ endpoint_overrides: OVERRIDE, vault_key: 'v' });

    await resetStorageDestructive({ keepEndpointOverride: false });

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['endpoint_overrides', 'vault_key']]]);
    expect(mockBrowserStorageSet).not.toHaveBeenCalled();
  });

  // The key-value store holds the vault, so clearing it first leaves no wallet to unlock after a
  // later step rejects.
  it('clears the key-value store before it deletes the database', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ vault_key: 'v' });

    await resetStorageDestructive();

    expect(mockBrowserStorageRemove.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDbDelete.mock.invocationCallOrder[0]!
    );
  });

  it('rejects without deleting the database when the key-value clear rejects', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ vault_key: 'v' });
    const clearError = new Error('storage clear failed');
    mockBrowserStorageRemove.mockRejectedValueOnce(clearError);

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

describe('the storage cache after a key-value wipe (#1177)', () => {
  type Platform = 'mobile' | 'desktop' | 'extension';
  type Reset = () => Promise<void>;
  const resets: Array<[string, Reset]> = [
    ['clearStorage', () => clearStorage()],
    ['resetStorageDestructive', () => resetStorageDestructive()]
  ];
  const platforms: Platform[] = ['mobile', 'desktop', 'extension'];
  const cases = resets.flatMap(([name, reset]) =>
    platforms.map((platform): [string, Platform, Reset] => [name, platform, reset])
  );

  let removeItem: jest.SpyInstance<void, [key: string]>;
  beforeEach(() => {
    removeItem = jest.spyOn(Storage.prototype, 'removeItem');
  });
  afterEach(() => removeItem.mockRestore());

  // Puts one wallet key in the platform's store and returns the mock that removes it.
  const onPlatform = (
    platform: Platform,
    { failRemoval = false } = {}
  ): { mock: { invocationCallOrder: number[] } } => {
    jest.mocked(isMobile).mockReturnValue(platform === 'mobile');
    jest.mocked(isDesktop).mockReturnValue(platform === 'desktop');
    jest.mocked(isExtension).mockReturnValue(platform === 'extension');
    _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: ['vault_key'] });
    localStorage.setItem('miden_wallet_vault_key', 'v');
    mockBrowserStorageGet.mockResolvedValue({ vault_key: 'v' });
    const failure = new Error('removal failed');
    if (platform === 'mobile') {
      if (failRemoval) _g.__resetTest.prefStub.remove.mockRejectedValueOnce(failure);
      return _g.__resetTest.prefStub.remove;
    }
    if (platform === 'desktop') {
      if (failRemoval) {
        removeItem.mockImplementation(() => {
          throw failure;
        });
      }
      return removeItem;
    }
    if (failRemoval) mockBrowserStorageRemove.mockRejectedValueOnce(failure);
    return mockBrowserStorageRemove;
  };

  it.each(cases)('%s on %s re-reads the storage cache once, after the removal', async (_name, platform, reset) => {
    const removal = onPlatform(platform);

    await reset();

    expect(removal.mock.invocationCallOrder).toHaveLength(1);
    expect(mockReread).toHaveBeenCalledTimes(1);
    expect(mockReread.mock.invocationCallOrder[0]!).toBeGreaterThan(removal.mock.invocationCallOrder[0]!);
  });

  it.each(cases)(
    '%s on %s still re-reads the storage cache when the removal fails, and rejects with that failure',
    async (_name, platform, reset) => {
      onPlatform(platform, { failRemoval: true });

      await expect(reset()).rejects.toThrow('removal failed');

      expect(mockReread).toHaveBeenCalledTimes(1);
    }
  );
});

describe('the desktop wipe announcement', () => {
  it('announces the desktop clear only once localStorage is empty', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    expect(await announcementsSeeingTheKeyGone(() => resetStorageDestructive())).toEqual([true]);
  });
});

describe('clearClientStorage', () => {
  it("keeps the kept keys in their desktop form, removes every other localStorage key, and every sessionStorage key but open-link's and Bread Connect's records", async () => {
    localStorage.setItem('miden_wallet_endpoint_overrides', '{"rpcUrl":"https://rpc.custom"}');
    localStorage.setItem('miden_wallet_vault_key', 'v');
    localStorage.setItem('ui_cache', 'u');
    sessionStorage.setItem('open-link:taken', '["com.miden.wallet://open?url=https%3A%2F%2Flive.example%2F"]');
    sessionStorage.setItem('open-link:pending', 'https://bread.miden.xyz/open#url=https%3A%2F%2Fheld.example%2F');
    sessionStorage.setItem('open-link:launch', 'https://bread.miden.xyz/open#url=https%3A%2F%2Flaunch.example%2F');
    sessionStorage.setItem('bread-connect:taken', '["AAAAAAAAAAAAAAAAAAAAAA"]');
    sessionStorage.setItem('draft', 'd');

    await clearClientStorage();

    expect(Object.keys(localStorage)).toEqual(['miden_wallet_endpoint_overrides']);
    expect(sessionStorage.getItem('open-link:taken')).toBe(
      '["com.miden.wallet://open?url=https%3A%2F%2Flive.example%2F"]'
    );
    expect(sessionStorage.getItem('open-link:pending')).toBe(
      'https://bread.miden.xyz/open#url=https%3A%2F%2Fheld.example%2F'
    );
    expect(sessionStorage.getItem('open-link:launch')).toBe(
      'https://bread.miden.xyz/open#url=https%3A%2F%2Flaunch.example%2F'
    );
    expect(sessionStorage.getItem('bread-connect:taken')).toBe('["AAAAAAAAAAAAAAAAAAAAAA"]');
    expect(sessionStorage.getItem('draft')).toBeNull();
  });

  it('re-reads the storage cache after the localStorage and sessionStorage removals (#1177)', async () => {
    localStorage.setItem('miden_wallet_vault_key', 'v');
    sessionStorage.setItem('draft', 'd');
    const removeItem = jest.spyOn(Storage.prototype, 'removeItem');
    const clear = jest.spyOn(Storage.prototype, 'clear');
    try {
      await clearClientStorage();

      expect(removeItem).toHaveBeenCalledTimes(2);
      expect(clear).not.toHaveBeenCalled();
      expect(mockReread).toHaveBeenCalledTimes(1);
      const wipedAt = Math.max(...removeItem.mock.invocationCallOrder);
      expect(mockReread.mock.invocationCallOrder[0]!).toBeGreaterThan(wipedAt);
    } finally {
      removeItem.mockRestore();
      clear.mockRestore();
    }
  });

  it('still re-reads the storage cache when a localStorage removal throws, then rejects (#1177)', async () => {
    localStorage.setItem('miden_wallet_vault_key', 'v');
    const removeItem = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage down');
    });
    try {
      await expect(clearClientStorage()).rejects.toThrow('storage down');

      expect(mockReread).toHaveBeenCalledTimes(1);
    } finally {
      removeItem.mockRestore();
    }
  });

  it('announces the clear only once localStorage is empty', async () => {
    expect(await announcementsSeeingTheKeyGone(() => clearClientStorage())).toEqual([true]);
  });
});

describe('announcing a storage clear', () => {
  const cleared = jest.fn();
  let unsubscribe: () => void;
  beforeEach(() => {
    unsubscribe = onStorageCleared(cleared);
  });
  afterEach(() => unsubscribe());

  it('announces clearClientStorage once, after its cache re-read', async () => {
    await clearClientStorage();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(mockReread.mock.invocationCallOrder.at(-1)!).toBeLessThan(cleared.mock.invocationCallOrder[0]!);
  });

  it('announces the desktop clear on clearStorage once', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    await clearStorage();
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('announces the desktop clear on resetStorageDestructive once', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    await resetStorageDestructive();
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});

describe('announcing the platform wipe, once fully settled', () => {
  it('on mobile, announces once, after the keys are removed and the cache re-read', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockResolvedValueOnce({ keys: ['doomed', 'endpoint_overrides'] });
    _g.__resetTest.prefStub.remove.mockResolvedValue(undefined);
    const cleared = jest.fn();
    const unsubscribe = onStorageCleared(cleared);

    await clearStorage();
    unsubscribe();

    expect(cleared).toHaveBeenCalledTimes(1);
    expect(_g.__resetTest.prefStub.remove.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      cleared.mock.invocationCallOrder[0]!
    );
    expect(mockReread.mock.invocationCallOrder.at(-1)!).toBeLessThan(cleared.mock.invocationCallOrder[0]!);
  });

  it('on desktop, announces once, after the keys are removed and the cache re-read', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    localStorage.setItem('doomed', '1');
    const removeSpy = jest.spyOn(Storage.prototype, 'removeItem');
    const cleared = jest.fn();
    const unsubscribe = onStorageCleared(cleared);

    await clearStorage();
    unsubscribe();

    expect(cleared).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.invocationCallOrder.at(-1)!).toBeLessThan(cleared.mock.invocationCallOrder[0]!);
    expect(mockReread.mock.invocationCallOrder.at(-1)!).toBeLessThan(cleared.mock.invocationCallOrder[0]!);
    removeSpy.mockRestore();
  });

  it('on the extension, announces nothing: browser.storage.onChanged reports the removals', async () => {
    (isExtension as jest.Mock).mockReturnValue(true);
    const cleared = jest.fn();
    const unsubscribe = onStorageCleared(cleared);

    await clearStorage();
    unsubscribe();

    expect(cleared).not.toHaveBeenCalled();
  });
});

describe('the bridge config version floor', () => {
  const FLOOR = { bridge_config_floor_v1: { testnet: 4 } };

  it('survives the wallet-setup wipe', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({ ...FLOOR, vault_key: 'v' });

    await clearStorage();

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['vault_key']]]);
  });

  it('survives the destructive reset that takes the endpoint override with it', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      endpoint_overrides: { rpcUrl: 'https://rpc.custom' },
      ...FLOOR,
      vault_key: 'v'
    });

    await resetStorageDestructive({ keepEndpointOverride: false });

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['endpoint_overrides', 'vault_key']]]);
  });

  it('survives the mobile wipe', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: ['bridge_config_floor_v1', 'vault_key'] });

    await clearStorage();

    expect(_g.__resetTest.prefStub.remove.mock.calls).toEqual([[{ key: 'vault_key' }]]);
  });

  it('survives the recovery page wipe in its desktop form', async () => {
    localStorage.setItem('miden_wallet_bridge_config_floor_v1', '{"testnet":4}');
    localStorage.setItem('miden_wallet_vault_key', 'v');

    await clearClientStorage();

    expect(Object.keys(localStorage)).toEqual(['miden_wallet_bridge_config_floor_v1']);
  });
});

// Each network's accepted document and its derivation are network configuration, as the floor is. The service worker
// has no scheduler, so a wipe that took them left its synchronous readers with no document after a create or import.
// Developer Settings' reset takes them with the override they may have been read through, and keeps the floors.
describe('the bridge config documents', () => {
  const DOCUMENTS = [
    'bridge_config_v1:testnet',
    'bridge_config_derived_v1:testnet',
    'bridge_config_v1:devnet',
    'bridge_config_derived_v1:devnet'
  ];
  const onExtension = () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      endpoint_overrides: { rpcUrl: 'https://rpc.custom' },
      ...Object.fromEntries(DOCUMENTS.map(key => [key, {}])),
      bridge_config_floor_v1: { testnet: 4 },
      explore_config_floor_v1: { testnet: 2 },
      vault_key: 'v'
    });
  };
  const inDesktopForm = () => {
    for (const key of [...DOCUMENTS, 'vault_key']) localStorage.setItem(`miden_wallet_${key}`, '{}');
  };
  const desktopKeys = () => Object.keys(localStorage).sort();

  it('survive the wallet-setup wipe on mobile, which removes the rest', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    _g.__resetTest.prefStub.keys.mockResolvedValue({ keys: [...DOCUMENTS, 'vault_key'] });

    await clearStorage();

    expect(_g.__resetTest.prefStub.remove.mock.calls).toEqual([[{ key: 'vault_key' }]]);
  });

  it('survive the wallet-setup wipe on desktop in their desktop form, which removes the rest', async () => {
    jest.mocked(isDesktop).mockReturnValue(true);
    inDesktopForm();

    await clearStorage();

    expect(desktopKeys()).toEqual(DOCUMENTS.map(key => `miden_wallet_${key}`).sort());
  });

  it('survive the wallet-setup wipe on the extension, which removes the rest', async () => {
    onExtension();

    await clearStorage();

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['vault_key']]]);
  });

  it('go with the destructive reset that takes the endpoint override with it, which keeps the floors', async () => {
    onExtension();

    await resetStorageDestructive({ keepEndpointOverride: false });

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['endpoint_overrides', ...DOCUMENTS, 'vault_key']]]);
  });

  it('survive the destructive reset that keeps the endpoint override, which removes the rest', async () => {
    onExtension();

    await resetStorageDestructive();

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['vault_key']]]);
  });

  it('survive the recovery page wipe in their desktop form', async () => {
    inDesktopForm();

    await clearClientStorage();

    expect(desktopKeys()).toEqual(DOCUMENTS.map(key => `miden_wallet_${key}`).sort());
  });
});

describe('the Explore catalog version floor', () => {
  it('is one of the keys every wipe keeps', () => {
    expect(PRESERVED_STORAGE_KEYS).toContain('explore_config_floor_v1');
  });

  it('survives the wallet-setup wipe while the stored catalog goes', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockBrowserStorageGet.mockResolvedValue({
      explore_config_floor_v1: { testnet: 2 },
      'explore_config_v1:testnet': { fetchedAt: 1, body: {} },
      vault_key: 'v'
    });

    await clearStorage();

    expect(mockBrowserStorageRemove.mock.calls).toEqual([[['explore_config_v1:testnet', 'vault_key']]]);
  });

  it('survives the recovery page wipe in its desktop form', async () => {
    localStorage.setItem('miden_wallet_explore_config_floor_v1', '{"testnet":2}');
    localStorage.setItem('miden_wallet_vault_key', 'v');

    await clearClientStorage();

    expect(Object.keys(localStorage)).toEqual(['miden_wallet_explore_config_floor_v1']);
  });
});

describe('wallet access after a reset', () => {
  it.each<[string, () => Promise<void>]>([
    ['wallet setup', () => clearStorage(false)],
    ['destructive reset', () => resetStorageDestructive()],
    ['recovery page', () => clearClientStorage()]
  ])('retires a live permission synchronously before the %s wipe awaits storage', async (_name, wipe) => {
    const scope = () => `testnet:13:${getWalletAccessGeneration()}`;
    registerWalletAccessRuntime({ scope, refresh: async () => undefined });
    const before = scope();
    publishWalletAccessDecision(before, true);
    expect(() => assertWalletAccessAllowed()).not.toThrow();
    const pending = wipe();
    expect(() => assertWalletAccessAllowed()).toThrow();
    publishWalletAccessDecision(before, true);
    expect(() => assertWalletAccessAllowed()).toThrow();
    await pending;
  });
});
