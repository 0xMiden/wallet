import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';
import Dexie from 'dexie';

import { MidenClientInterface } from './miden-client-interface';

const STORE = 'MidenClientDB_genesis_test';
const ABSENT_STORE = 'MidenClientDB_genesis_absent';

/** The SDK's own connection to its store, with the block header table keyed as its schema declares it. */
const openSdkStore = async () => {
  const store = new Dexie(STORE);
  store.version(1).stores({ blockHeaders: 'blockNum,hasClientNotes' });
  await store.open();
  return store;
};

const clientOn = (storeName: string) =>
  MidenClientInterface.fromClient({ storeIdentifier: async () => storeName } as unknown as MidenClient, 'testnet');

describe('MidenClientInterface.genesisHeader', () => {
  let sdkStore: Dexie;

  beforeEach(async () => {
    sdkStore = await openSdkStore();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    sdkStore.close();
    await Dexie.delete(STORE);
  });

  it('reads the genesis header bytes from the store the client uses, beside the SDK connection', async () => {
    await sdkStore.table('blockHeaders').bulkPut([
      { blockNum: 0, header: new Uint8Array([1, 2, 3]), hasClientNotes: 'false' },
      { blockNum: 5, header: new Uint8Array([5]), hasClientNotes: 'true' }
    ]);
    const close = jest.spyOn(Dexie.prototype, 'close');

    await expect(clientOn(STORE).genesisHeader()).resolves.toEqual(new Uint8Array([1, 2, 3]));
    // Its own connection is closed again, and the SDK's is left as it was.
    expect(close).toHaveBeenCalledTimes(1);
    expect(sdkStore.isOpen()).toBe(true);
  });

  it('rejects when the store holds no genesis header', async () => {
    await sdkStore.table('blockHeaders').put({ blockNum: 5, header: new Uint8Array([5]), hasClientNotes: 'true' });

    await expect(clientOn(STORE).genesisHeader()).rejects.toThrow('The client store holds no genesis block header');
  });

  it('rejects a genesis row whose header is not bytes', async () => {
    await sdkStore.table('blockHeaders').put({ blockNum: 0, header: 'AQID', hasClientNotes: 'false' });

    await expect(clientOn(STORE).genesisHeader()).rejects.toThrow('The client store holds no genesis block header');
  });

  it('rejects without creating a store that does not exist', async () => {
    await expect(clientOn(ABSENT_STORE).genesisHeader()).rejects.toThrow();
    await expect(Dexie.exists(ABSENT_STORE)).resolves.toBe(false);
  });
});
