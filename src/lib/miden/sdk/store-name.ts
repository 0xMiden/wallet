import { MIDEN_NETWORK_ENDPOINTS, MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

/**
 * The SDK names its IndexedDB store after the RPC host (`MidenClientDB_{network_id}`). 1.17.9 moved mainnet from
 * rpc.cedar.miden.io to rpc.mainnet.miden.io (#2066), so the default store went from `MidenClientDB_mcst` to
 * `MidenClientDB_mm` and every wallet set up before it opened an empty store: no account, a zero balance (#2086).
 */
export const CEDAR_MAINNET_STORE_NAME = 'MidenClientDB_mcst';
export const MAINNET_DEFAULT_STORE_NAME = 'MidenClientDB_mm';
// The SDK table keyed by account id (`&id`): one row per account the store holds.
const ACCOUNT_HEADERS_TABLE = 'latestAccountHeaders';

let resolved: Promise<string | undefined> | undefined;

function accountIdsIn(name: string): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    // Only ever called for a listed store; aborting the upgrade guarantees the check never creates one.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (!db.objectStoreNames.contains(ACCOUNT_HEADERS_TABLE)) {
        db.close();
        resolve(new Set());
        return;
      }
      const keys = db.transaction(ACCOUNT_HEADERS_TABLE, 'readonly').objectStore(ACCOUNT_HEADERS_TABLE).getAllKeys();
      keys.onsuccess = () => {
        db.close();
        resolve(new Set(keys.result.map(String)));
      };
      keys.onerror = () => {
        db.close();
        reject(keys.error);
      };
    };
  });
}

async function chooseMainnetStore(): Promise<string | undefined> {
  const names = new Set((await indexedDB.databases()).map(db => db.name));
  if (!names.has(CEDAR_MAINNET_STORE_NAME)) return undefined;
  const cedar = await accountIdsIn(CEDAR_MAINNET_STORE_NAME);
  if (cedar.size === 0) return undefined;
  if (!names.has(MAINNET_DEFAULT_STORE_NAME)) return CEDAR_MAINNET_STORE_NAME;
  // A wallet set up on 1.17.9 keeps the store it was set up in. One that only reopened on 1.17.9 holds nothing the
  // cedar store lacks (at most a Guardian snapshot of the same account), so the cedar store and its history win.
  const current = await accountIdsIn(MAINNET_DEFAULT_STORE_NAME);
  return [...current].every(id => cedar.has(id)) ? CEDAR_MAINNET_STORE_NAME : undefined;
}

/**
 * The store to open the SDK client with at `rpcUrl`, or undefined for the SDK default. Only the bundled mainnet
 * endpoint is redirected, and only to a cedar store that already holds this wallet's accounts. Resolved once per
 * realm; a failed check answers undefined, which is what 1.17.9 opened.
 */
export function sdkStoreNameFor(rpcUrl: string): Promise<string | undefined> {
  if (rpcUrl !== MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.MAINNET)) return Promise.resolve(undefined);
  resolved ??= chooseMainnetStore().catch(error => {
    console.warn('[store-name] could not inspect the mainnet stores; opening the SDK default', error);
    return undefined;
  });
  return resolved;
}

export function resetSdkStoreNameForTest(): void {
  resolved = undefined;
}
