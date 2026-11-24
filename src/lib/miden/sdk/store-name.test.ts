import { MIDEN_NETWORK_ENDPOINTS, MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import {
  CEDAR_MAINNET_STORE_NAME,
  MAINNET_DEFAULT_STORE_NAME,
  resetSdkStoreNameForTest,
  sdkStoreNameFor
} from './store-name';

const MAINNET_RPC = MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.MAINNET)!;

function createStore(name: string, accountIds: string[], withAccountTable = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (withAccountTable) request.result.createObjectStore('latestAccountHeaders', { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!withAccountTable || accountIds.length === 0) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction('latestAccountHeaders', 'readwrite');
      for (const id of accountIds) tx.objectStore('latestAccountHeaders').put({ id, accountCommitment: '0x1' });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function deleteStore(name: string): Promise<void> {
  return new Promise(resolve => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

const storeNames = async () => (await indexedDB.databases()).map(db => db.name).sort();

describe('sdkStoreNameFor', () => {
  beforeEach(() => resetSdkStoreNameForTest());
  afterEach(async () => {
    jest.restoreAllMocks();
    await deleteStore(CEDAR_MAINNET_STORE_NAME);
    await deleteStore(MAINNET_DEFAULT_STORE_NAME);
  });

  it('reopens the cedar store of a wallet set up before 1.17.9 (#2086)', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    // What 1.17.9 left behind: an empty store under the new host's name.
    await createStore(MAINNET_DEFAULT_STORE_NAME, []);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBe(CEDAR_MAINNET_STORE_NAME);
  });

  it('reopens the cedar store when 1.17.9 never ran', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBe(CEDAR_MAINNET_STORE_NAME);
  });

  it('reopens the cedar store when 1.17.9 only wrote a snapshot of the same account', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount', '0xother']);
    await createStore(MAINNET_DEFAULT_STORE_NAME, ['0xaccount']);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBe(CEDAR_MAINNET_STORE_NAME);
  });

  it('keeps the default store of a wallet set up on 1.17.9', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xold']);
    await createStore(MAINNET_DEFAULT_STORE_NAME, ['0xnew']);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
    // One account the cedar store lacks is enough: switching would hide it.
    resetSdkStoreNameForTest();
    await deleteStore(MAINNET_DEFAULT_STORE_NAME);
    await createStore(MAINNET_DEFAULT_STORE_NAME, ['0xold', '0xnew']);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
  });

  it('keeps the default when there is no cedar store, or it holds no account', async () => {
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
    resetSdkStoreNameForTest();
    await createStore(CEDAR_MAINNET_STORE_NAME, []);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
    resetSdkStoreNameForTest();
    await deleteStore(CEDAR_MAINNET_STORE_NAME);
    await createStore(CEDAR_MAINNET_STORE_NAME, [], false);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
  });

  it('never redirects another network or a developer endpoint, and never inspects the stores for them', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    const databases = jest.spyOn(indexedDB, 'databases');
    for (const url of [
      MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.TESTNET)!,
      MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.DEVNET)!,
      'https://rpc.cedar.miden.io'
    ]) {
      await expect(sdkStoreNameFor(url)).resolves.toBeUndefined();
    }
    expect(databases).not.toHaveBeenCalled();
  });

  it('creates no store while checking', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    const before = await storeNames();
    await sdkStoreNameFor(MAINNET_RPC);
    expect(await storeNames()).toEqual(before);
  });

  it('opens the SDK default when the stores cannot be listed, and asks again on the next build', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    const databases = jest.spyOn(indexedDB, 'databases').mockRejectedValueOnce(new Error('denied'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBe(CEDAR_MAINNET_STORE_NAME);
    expect(databases).toHaveBeenCalledTimes(2);
  });

  it('opens the SDK default when the listing never answers', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    jest.spyOn(indexedDB, 'databases').mockReturnValue(new Promise(() => undefined));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const answer = sdkStoreNameFor(MAINNET_RPC);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(answer).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back, and holds no connection open, when a listed store is already gone', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    // Listed, then deleted before the check opens it.
    const listed = [CEDAR_MAINNET_STORE_NAME, MAINNET_DEFAULT_STORE_NAME].map(name => ({ name, version: 1 }));
    jest.spyOn(indexedDB, 'databases').mockResolvedValue(listed);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sdkStoreNameFor(MAINNET_RPC)).resolves.toBeUndefined();
    // A connection left open would block the SDK's upgrade of the store; here it would block this upgrade.
    await expect(createStore(MAINNET_DEFAULT_STORE_NAME, ['0xnew'])).resolves.toBeUndefined();
  });

  it('answers once per realm', async () => {
    await createStore(CEDAR_MAINNET_STORE_NAME, ['0xaccount']);
    const databases = jest.spyOn(indexedDB, 'databases');
    await Promise.all([sdkStoreNameFor(MAINNET_RPC), sdkStoreNameFor(MAINNET_RPC)]);
    await sdkStoreNameFor(MAINNET_RPC);
    expect(databases).toHaveBeenCalledTimes(1);
  });
});
