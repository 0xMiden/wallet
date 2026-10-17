import { assertWalletRunsOnStoredOverride, LOCALNET_SDK_STORES, type StoredOverrideProbe } from './extension-network';

const LOCALNET_HARNESS = { name: 'localhost', rpcUrl: 'http://localhost:57291' };
const OVERRIDE_RPC_URL = 'http://127.0.0.1:57291';

describe('LOCALNET_SDK_STORES', () => {
  it("names the store the SDK opens for each of the localnet node's two URLs, and no other URL", () => {
    expect(LOCALNET_SDK_STORES).toEqual(
      new Map([
        ['http://localhost:57291', 'MidenClientDB_mlcl'],
        ['http://127.0.0.1:57291', 'MidenClientDB_mcst']
      ])
    );
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
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, OVERRIDE_RPC_URL)).resolves.toBeUndefined();
  });

  it('fails a build that ignored the override and created the account in the build default store', async () => {
    const probe = wallet(override(OVERRIDE_RPC_URL), { MidenClientDB_mlcl: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, OVERRIDE_RPC_URL)).rejects.toThrow(
      /no account in MidenClientDB_mcst.*1 in MidenClientDB_mlcl.*"yarn test:e2e:stored-override:build"/
    );
  });

  it('fails a stored override that is not the one the spec stored', async () => {
    // Every URL miden-client does not name opens MidenClientDB_mcst, so the account's store cannot tell them apart.
    const probe = wallet(override('http://127.0.0.1:57292'), { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, OVERRIDE_RPC_URL)).rejects.toThrow(
      "The stored endpoint override's RPC URL is http://127.0.0.1:57292, but this spec stored http://127.0.0.1:57291"
    );
  });

  it('fails an override URL the store map does not name, rather than guess its store', async () => {
    const probe = wallet(override('http://localhost:57292'), { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, 'http://localhost:57292')).rejects.toThrow(
      'No SDK store is known for http://localhost:57292'
    );
  });

  it('fails a harness URL the store map does not name, rather than guess its store', async () => {
    const harness = { name: 'testnet', rpcUrl: 'https://rpc.testnet.miden.io' };
    const probe = wallet(override(OVERRIDE_RPC_URL, 'testnet'), { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, harness, OVERRIDE_RPC_URL)).rejects.toThrow(
      'No SDK store is known for https://rpc.testnet.miden.io'
    );
  });

  it('fails an override that opens the build default store, where no realm could be told apart', async () => {
    const probe = wallet(override('http://localhost:57291'), { MidenClientDB_mlcl: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, 'http://localhost:57291')).rejects.toThrow(
      /opens MidenClientDB_mlcl, the same store as the build default/
    );
  });

  it('fails an override that names another network than the harness drives', async () => {
    const probe = wallet(override(OVERRIDE_RPC_URL, 'testnet'), { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, OVERRIDE_RPC_URL)).rejects.toThrow(
      /names network "testnet".*"localhost" harness \(wallet network "localnet"\)/
    );
  });

  it('fails when no override is stored', async () => {
    const probe = wallet(undefined, { MidenClientDB_mcst: 1 });
    await expect(assertWalletRunsOnStoredOverride(probe, LOCALNET_HARNESS, OVERRIDE_RPC_URL)).rejects.toThrow(
      'No endpoint override is stored'
    );
  });
});
