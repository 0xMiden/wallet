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
// The SDK's own bound on the same listing: WebKit can leave the first `databases()` call pending.
const LISTING_TIMEOUT_MS = 1_000;

let resolved: Promise<string | undefined> | undefined;

function accountIdsIn(name: string): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    // Only ever called for a listed store; aborting the upgrade guarantees the check never creates one.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
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
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

async function listStores(): Promise<Set<string | undefined>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('indexedDB.databases() did not answer')), LISTING_TIMEOUT_MS);
  });
  try {
    return new Set((await Promise.race([indexedDB.databases(), timeout])).map(db => db.name));
  } finally {
    clearTimeout(timer);
  }
}

async function chooseMainnetStore(): Promise<string | undefined> {
  const names = await listStores();
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
 * endpoint is redirected, and only to a cedar store that already holds this wallet's accounts. An answer is kept for
 * the realm; a failed check answers undefined (what 1.17.9 opened) and is asked again by the next build, so one
 * transient IndexedDB error cannot pin a realm to the empty store.
 */
export function sdkStoreNameFor(rpcUrl: string): Promise<string | undefined> {
  if (rpcUrl !== MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.MAINNET)) return Promise.resolve(undefined);
  if (!resolved) {
    const attempt: Promise<string | undefined> = chooseMainnetStore().catch(error => {
      console.warn('[store-name] could not inspect the mainnet stores; opening the SDK default', error);
      if (resolved === attempt) resolved = undefined;
      return undefined;
    });
    resolved = attempt;
  }
  return resolved;
}

export function resetSdkStoreNameForTest(): void {
  resolved = undefined;
}
