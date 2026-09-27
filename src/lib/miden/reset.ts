import * as Repo from 'lib/miden/repo';
import { ENDPOINT_OVERRIDE_STORAGE_KEY } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId, resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { DESKTOP_STORAGE_PREFIX } from 'lib/platform/storage-adapter';

// Keys that are configuration, NOT wallet data, and are never removed by a
// storage reset. The dev-settings endpoint override selects the network the
// wallet is being created for - and it is set BEFORE creation. Without keeping
// it, creating a wallet on a custom network wipes the override, so the wallet
// silently reverts to the build-default network while the account was already
// minted on the custom one - leaving the account on one network and the client
// (balances, faucet, native token) on another. The wipe removes every other key
// instead of clearing everything and writing these back, so no failed read or
// write can lose them (#1093). The dedicated dev-settings "Reset to defaults"
// clears it explicitly.
const PRESERVED_STORAGE_KEYS = [ENDPOINT_OVERRIDE_STORAGE_KEY];

function localStorageKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

async function clearPlatformKeyValueStorage(): Promise<void> {
  if (isMobile()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { keys } = await Preferences.keys();
    for (const key of keys) {
      if (!PRESERVED_STORAGE_KEYS.includes(key)) await Preferences.remove({ key });
    }
  } else if (isDesktop()) {
    const preserved = PRESERVED_STORAGE_KEYS.map(key => `${DESKTOP_STORAGE_PREFIX}${key}`);
    for (const key of localStorageKeys()) {
      if (!preserved.includes(key)) localStorage.removeItem(key);
    }
  } else if (isExtension()) {
    const browser = await import('webextension-polyfill');
    const stored = await browser.default.storage.local.get(null);
    await browser.default.storage.local.remove(
      Object.keys(stored).filter(key => !PRESERVED_STORAGE_KEYS.includes(key))
    );
  }
}

/**
 * Soft storage reset called during wallet creation / spawn.
 *
 * Empties the `transactions` table and wipes the platform key-value store,
 * but deliberately keeps the TridentMain Dexie connection alive. Using
 * `db.delete()` here would fire a `versionchange` event to every other open
 * handle (notably the page's, which was opened lazily by the onboarding UI),
 * force them closed, and leave no path to reopen them short of a page reload
 * — which is how we end up with `DatabaseClosedError` on every subsequent
 * page-side Dexie read and custom-faucet `fetchTokenMetadata` calls racing
 * against a partially-loaded SDK.
 *
 * If you need the full "throw away everything, including live connections
 * from other tabs/contexts" semantic, call `resetStorageDestructive` below.
 */
export async function clearStorage(clearDb: boolean = true) {
  if (clearDb) {
    await Repo.transactions.clear();
    // The spend history and the caps computed from it go together. Recovery from the same mnemonic
    // reproduces the same account ids, so a surviving configuration would key-match the recovered
    // account and keep enforcing a cap over a total that was just zeroed - and the disclosure copy
    // promises that resetting app data removes both.
    await Repo.spendingLimits.clear();
  }
  await clearPlatformKeyValueStorage();
  await resetNativeAssetCache();
  // Rediscover now rather than on first use: the wallet being created or imported reads its
  // balance the moment it is Ready, and that read would otherwise wait on this RPC (#1123).
  primeNativeAssetId();
}

/**
 * Hard reset — explicitly what the options-page "Reset Wallet" button wants.
 * Deletes the Dexie database (forcing every live handle closed) AND clears
 * the platform key-value store. Callers should only use this when the user
 * has explicitly opted into a full wipe; for wallet creation flows use
 * `clearStorage` above instead.
 */
export async function resetStorageDestructive() {
  await Repo.db.delete();
  await Repo.db.open();
  await clearPlatformKeyValueStorage();
  await resetNativeAssetCache();
}

// Leaves desktop's platform key-value store to Vault.spawn, which reads the legacy
// guardian URL from it before its clearStorage wipes all but the preserved keys.
export function clearClientStorage() {
  for (const key of localStorageKeys()) {
    if (!key.startsWith(DESKTOP_STORAGE_PREFIX)) localStorage.removeItem(key);
  }
  sessionStorage.clear();
}
