import { rereadStorageCache } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { ENDPOINT_OVERRIDE_STORAGE_KEY } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId, resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { DESKTOP_STORAGE_PREFIX, getStorageProvider } from 'lib/platform/storage-adapter';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';

// Configuration, not wallet data, so every reset keeps it. The dev-settings endpoint override
// selects the network a wallet is created for and is set BEFORE creation; losing it mints the
// account on one network while the client resolves another. Developer Settings' "Reset to
// defaults" clears it explicitly.
export const PRESERVED_STORAGE_KEYS: readonly string[] = [ENDPOINT_OVERRIDE_STORAGE_KEY];

// A wallet-setup reset also keeps the frozen legacy guardian URL until a setup succeeds: a
// Guardian recovery with no pick and no probe result falls back to it, and a Retry after a
// failed attempt must find the value the first attempt did. See `dropLegacyGuardianUrl`.
export const SETUP_PRESERVED_STORAGE_KEYS: readonly string[] = [...PRESERVED_STORAGE_KEYS, GUARDIAN_URL_STORAGE_KEY];

// Removes every key but the kept ones. A kept key is never deleted and written back, so no
// failure can lose it, and a failure rejects the reset rather than being swallowed.
async function clearPlatformKeyValueStorage(keep: readonly string[]): Promise<void> {
  try {
    if (isMobile()) {
      const { Preferences } = await import('@capacitor/preferences');
      const { keys } = await Preferences.keys();
      for (const key of keys) {
        if (!keep.includes(key)) await Preferences.remove({ key });
      }
    } else if (isDesktop()) {
      removeLocalStorageExcept(keep);
    } else if (isExtension()) {
      const browser = await import('webextension-polyfill');
      const doomed = Object.keys(await browser.default.storage.local.get(null)).filter(key => !keep.includes(key));
      if (doomed.length > 0) await browser.default.storage.local.remove(doomed);
    }
  } finally {
    // A reader mounted after the wipe would otherwise render the previous wallet's value, and a wipe that
    // failed part way has still removed keys. The re-read never rejects, so the wipe's own error stands.
    await rereadStorageCache();
  }
}

// Desktop's key-value store lives in localStorage, so its kept keys carry DesktopStorage's prefix.
function removeLocalStorageExcept(keep: readonly string[]): void {
  const kept = new Set(keep.map(key => DESKTOP_STORAGE_PREFIX + key));
  for (const key of Object.keys(localStorage)) {
    if (!kept.has(key)) localStorage.removeItem(key);
  }
}

/**
 * Soft storage reset called during wallet creation / spawn.
 *
 * Empties the `transactions` table and every platform key-value entry except
 * `keep` (a setup keeps `SETUP_PRESERVED_STORAGE_KEYS`), but deliberately keeps the TridentMain Dexie
 * connection alive. Using `db.delete()` here would fire a `versionchange` event
 * to every other open handle (notably the page's, which was opened lazily by the
 * onboarding UI), force them closed, and leave no path to reopen them short of a
 * page reload - which is how we end up with `DatabaseClosedError` on every
 * subsequent page-side Dexie read and custom-faucet `fetchTokenMetadata` calls
 * racing against a partially-loaded SDK.
 *
 * If you need the full "throw away everything, including live connections
 * from other tabs/contexts" semantic, call `resetStorageDestructive` below.
 */
export async function clearStorage(clearDb: boolean = true, keep: readonly string[] = SETUP_PRESERVED_STORAGE_KEYS) {
  if (clearDb) {
    await Repo.transactions.clear();
    // The spend history and the caps computed from it go together. Recovery from the same mnemonic
    // reproduces the same account ids, so a surviving configuration would key-match the recovered
    // account and keep enforcing a cap over a total that was just zeroed - and the disclosure copy
    // promises that resetting app data removes both.
    await Repo.spendingLimits.clear();
  }
  await clearPlatformKeyValueStorage(keep);
  await resetNativeAssetCache();
  // Rediscover now rather than on first use: the wallet being created or imported reads its
  // balance the moment it is Ready, and that read would otherwise wait on this RPC (#1123).
  primeNativeAssetId();
}

// Called once a setup has published its vault: every Guardian account it wrote carries its own
// guardianEndpoint, so the fallback has nothing left to serve. A delete, never a write.
export async function dropLegacyGuardianUrl(): Promise<void> {
  await getStorageProvider().remove([GUARDIAN_URL_STORAGE_KEY]);
}

/**
 * Hard reset — explicitly what the options-page "Reset Wallet" button wants.
 * Deletes the Dexie database (forcing every live handle closed) AND every
 * platform key-value entry except `PRESERVED_STORAGE_KEYS`. Callers should only
 * use this when the user has explicitly opted into a full wipe; for wallet
 * creation flows use `clearStorage` above instead.
 */
export async function resetStorageDestructive() {
  await Repo.db.delete();
  await Repo.db.open();
  await clearPlatformKeyValueStorage(PRESERVED_STORAGE_KEYS);
  await resetNativeAssetCache();
}

// The recovery page's own wipe. On desktop localStorage is also the key-value store, so it keeps
// what a wallet-setup reset keeps, and re-reads the cache as every other wipe does; on the extension
// and mobile those names are not in it, and the re-read finds nothing changed.
export async function clearClientStorage(): Promise<void> {
  try {
    removeLocalStorageExcept(SETUP_PRESERVED_STORAGE_KEYS);
    sessionStorage.clear();
  } finally {
    await rereadStorageCache();
  }
}
