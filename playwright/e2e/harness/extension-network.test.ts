import { assertWalletRunsOnStoredOverride, sdkStoreName, type StoredOverrideProbe } from './extension-network';

const LOCALNET_HARNESS = { name: 'localhost', rpcUrl: 'http://localhost:57291' };
const OVERRIDE_RPC_URL = 'http://127.0.0.1:57291';

describe('sdkStoreName', () => {
  // The cases miden-client's own `Endpoint::to_network_id` tests pin, plus the two URLs of the localnet node.
  it.each([
    ['https://rpc.mainnet.miden.io', 'MidenClientDB_mm'],
    ['https://rpc.testnet.miden.io', 'MidenClientDB_mtst'],
    ['https://rpc.devnet.miden.io', 'MidenClientDB_mdev'],
    ['http://localhost:57291', 'MidenClientDB_mlcl'],
    ['http://localhost:57291/', 'MidenClientDB_mlcl'],
    ['http://127.0.0.1:57291', 'MidenClientDB_mcst'],
    ['https://rpc.mainnet.miden.io:8080', 'MidenClientDB_mcst'],
    ['https://rpc.cedar.miden.io', 'MidenClientDB_mcst']
  ])('%s opens %s', (rpcUrl, store) => {
    expect(sdkStoreName(rpcUrl)).toBe(store);
  });

  it('refuses a URL without a protocol rather than guess the store', () => {
    expect(() => sdkStoreName('localhost')).toThrow('"localhost" is not a protocol://host[:port] URL');
  });
});

/** A wallet whose extension storage holds `stored` and whose IndexedDB stores hold `accounts` accounts each. */
function wallet(stored: unknown, accounts: Record<string, number>): StoredOverrideProbe {
  return {
    dumpChromeStorage: () => Promise.resolve(stored === undefined ? {} : { endpoint_overrides: stored }),
    listIndexedDBStores: () =>
      Promise.resolve(
        Object.keys(accounts).flatMap(db => [
          { db, version: 1, store: 'latestAccountHeaders' },
          { db, version: 1, store: 'inputNotes' }
        ])
      ),
    dumpIndexedDBStore: (db: string, store: string) =>
      Promise.resolve({
        json: '[]',
        count: store === 'latestAccountHeaders' ? (accounts[db] ?? 0) : 0,
        truncated: false
      })
  };
}

const override = (rpcUrl: string, networkName = 'localnet') => ({ rpcUrl, networkName, presetName: 'custom' });

describe('assertWalletRunsOnStoredOverride', () => {
  it('passes when the service worker created the account in the override store', async () => {
    const probe = wallet(override(OVERRIDE_RPC_URL), { MidenClientDB_mlcl: 0, MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS)).resolves.toBeUndefined();
  });

  it('fails a build that ignored the override and created the account in the build default store', async () => {
    const probe = wallet(override(OVERRIDE_RPC_URL), { MidenClientDB_mlcl: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS)).rejects.toThrow(
      /no account in MidenClientDB_mcst.*1 in MidenClientDB_mlcl.*MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES=true/
    );
  });

  it('fails an override that opens the build default store, where no realm could be told apart', async () => {
    const probe = wallet(override('http://localhost:57291'), { MidenClientDB_mlcl: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS)).rejects.toThrow(
      /opens MidenClientDB_mlcl, the same store as the build default/
    );
  });

  it('fails an override that names another network than the harness drives', async () => {
    const probe = wallet(override(OVERRIDE_RPC_URL, 'testnet'), { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS)).rejects.toThrow(
      /names network "testnet".*"localhost" harness \(wallet network "localnet"\)/
    );
  });

  it('fails when no override is stored', async () => {
    const probe = wallet(undefined, { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS)).rejects.toThrow(
      'No endpoint override is stored'
    );
  });
});
