import { CapacitorStorage, ExtensionStorage } from 'lib/platform/storage-adapter';
import {
  assertWalletAccessAllowed,
  invalidateWalletAccess,
  publishWalletAccessDecision,
  registerWalletAccessRuntime
} from 'lib/remote-config/wallet-access';

import { encryptAndSaveMany, fetchAndDecryptOne, isStored, removeMany } from './safe-storage';

jest.unmock('lib/remote-config/wallet-access');

jest.mock('lib/platform/index', () => ({
  isDesktop: () => false,
  isExtension: () => true,
  isMobile: () => false
}));

jest.mock('lib/platform/storage-adapter', () => {
  const actual = jest.requireActual<typeof import('lib/platform/storage-adapter')>(
    'lib/platform/storage-adapter'
  );
  return { ...actual, getStorageProvider: () => new actual.ExtensionStorage() };
});

const memory: Record<string, unknown> = {};
const mockNativeSet = jest.fn(async (items: Record<string, unknown>) => {
  Object.assign(memory, items);
});
const mockNativeRemove = jest.fn(async (keys: string[]) => {
  for (const key of keys) delete memory[key];
});
const mockPreferencesSet = jest.fn<Promise<void>, [{ key: string; value: string }]>();
const mockPreferencesRemove = jest.fn<Promise<void>, [{ key: string }]>();

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: {
        get: async () => ({ ...memory }),
        set: (items: Record<string, unknown>) => mockNativeSet(items),
        remove: (keys: string[]) => mockNativeRemove(keys)
      }
    }
  }
}));

jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    set: (item: { key: string; value: string }) => mockPreferencesSet(item),
    remove: (item: { key: string }) => mockPreferencesRemove(item)
  }
}));

const scope = 'storage-authority:testnet';
let vaultKey: CryptoKey;

beforeAll(async () => {
  vaultKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
});

beforeEach(() => {
  for (const key of Object.keys(memory)) delete memory[key];
  mockNativeSet.mockClear();
  mockNativeRemove.mockClear();
  mockPreferencesSet.mockReset().mockResolvedValue(undefined);
  mockPreferencesRemove.mockReset().mockResolvedValue(undefined);
  registerWalletAccessRuntime({ scope: () => scope, refresh: async () => undefined });
  publishWalletAccessDecision(scope, true);
});

afterEach(() => {
  invalidateWalletAccess();
});

function observe(pending: Promise<void>): Promise<unknown> {
  return pending.then(() => undefined, error => error);
}

function retireAfterAdmission(): () => void {
  let scheduled = false;
  return () => {
    assertWalletAccessAllowed();
    if (!scheduled) {
      scheduled = true;
      void Promise.resolve().then(() => publishWalletAccessDecision(scope, false));
    }
  };
}

describe('GEO028 guarded storage mutations', () => {
  it('refuses extension set when access retires during the lazy import', async () => {
    const storage = new ExtensionStorage();
    const pending: Promise<void> = Reflect.apply(storage.set, storage, [{ secret: 'new' }, assertWalletAccessAllowed]);
    const outcome = observe(pending);

    publishWalletAccessDecision(scope, false);

    const error = await outcome;
    expect(mockNativeSet).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
  });

  it('refuses extension remove when access retires during the lazy import', async () => {
    memory.secret = 'original';
    const storage = new ExtensionStorage();
    const pending: Promise<void> = Reflect.apply(storage.remove, storage, [['secret'], assertWalletAccessAllowed]);
    const outcome = observe(pending);

    publishWalletAccessDecision(scope, false);

    const error = await outcome;
    expect(mockNativeRemove).not.toHaveBeenCalled();
    expect(memory.secret).toBe('original');
    expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
  });

  it('forwards encrypted-write authority through the provider import wait', async () => {
    await encryptAndSaveMany([['secret', 'original']], vaultKey);
    mockNativeSet.mockClear();

    const error = await observe(encryptAndSaveMany([['secret', 'new']], vaultKey, retireAfterAdmission()));

    expect(mockNativeSet).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
    expect(await fetchAndDecryptOne('secret', vaultKey)).toBe('original');
  });

  it('forwards removal authority through the provider import wait', async () => {
    await encryptAndSaveMany([['secret', 'original']], vaultKey);
    mockNativeRemove.mockClear();

    const error = await observe(removeMany(['secret'], retireAfterAdmission()));

    expect(mockNativeRemove).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
    expect(await fetchAndDecryptOne('secret', vaultKey)).toBe('original');
  });

  it('persists encrypted data while the caller authority remains current', async () => {
    await encryptAndSaveMany([['secret', 'admitted']], vaultKey, assertWalletAccessAllowed);

    expect(mockNativeSet).toHaveBeenCalledTimes(1);
    expect(mockNativeSet.mock.calls[0]).toHaveLength(1);
    expect(await fetchAndDecryptOne('secret', vaultKey)).toBe('admitted');
  });

  it('removes encrypted data while the caller authority remains current', async () => {
    await encryptAndSaveMany([['secret', 'admitted']], vaultKey);
    await removeMany(['secret'], assertWalletAccessAllowed);

    expect(mockNativeRemove).toHaveBeenCalledTimes(1);
    expect(mockNativeRemove.mock.calls[0]).toHaveLength(1);
    expect(await isStored('secret')).toBe(false);
  });

  it('stops a native set batch after access retires during the first acknowledgement', async () => {
    mockPreferencesSet.mockImplementationOnce(async () => publishWalletAccessDecision(scope, false));
    const storage = new CapacitorStorage();
    const pending: Promise<void> = Reflect.apply(storage.set, storage, [
      { first: 'admitted', second: 'forbidden' },
      assertWalletAccessAllowed
    ]);

    const error = await observe(pending);

    expect(mockPreferencesSet).toHaveBeenCalledTimes(1);
    expect(mockPreferencesSet).toHaveBeenCalledWith({ key: 'first', value: 'admitted' });
    expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
  });

  it('stops a native remove batch after access retires during the first acknowledgement', async () => {
    mockPreferencesRemove.mockImplementationOnce(async () => publishWalletAccessDecision(scope, false));
    const storage = new CapacitorStorage();
    const pending: Promise<void> = Reflect.apply(storage.remove, storage, [
      ['first', 'second'],
      assertWalletAccessAllowed
    ]);

    const error = await observe(pending);

    expect(mockPreferencesRemove).toHaveBeenCalledTimes(1);
    expect(mockPreferencesRemove).toHaveBeenCalledWith({ key: 'first' });
    expect(error).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
  });

  it('finishes a native set batch while caller authority remains current', async () => {
    const storage = new CapacitorStorage();
    await Reflect.apply(storage.set, storage, [{ first: 'one', second: 'two' }, assertWalletAccessAllowed]);

    expect(mockPreferencesSet.mock.calls).toEqual([
      [{ key: 'first', value: 'one' }],
      [{ key: 'second', value: 'two' }]
    ]);
  });

  it('finishes a native remove batch while caller authority remains current', async () => {
    const storage = new CapacitorStorage();
    await Reflect.apply(storage.remove, storage, [['first', 'second'], assertWalletAccessAllowed]);

    expect(mockPreferencesRemove.mock.calls).toEqual([[{ key: 'first' }], [{ key: 'second' }]]);
  });
});
