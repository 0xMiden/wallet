import { EXPLORE_CONFIG_FLOOR_KEY } from 'lib/explore-config/floor-key';
import { rereadStorageCache } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { ENDPOINT_OVERRIDE_STORAGE_KEY } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId, resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { DESKTOP_STORAGE_PREFIX } from 'lib/platform/storage-adapter';
import { BRIDGE_CONFIG_FLOOR_KEY } from 'lib/remote-config/source';
import { storageCleared } from 'lib/storage-cleared';

// Configuration, not wallet data, so a reset keeps it. The dev-settings endpoint override
// selects the network a wallet is created for and is set BEFORE creation; losing it mints the
// account on one network while the client resolves another. Developer Settings' reset takes it
// with the wipe through `keepEndpointOverride: false` rather than clearing it afterwards. The
// bridge config and Explore catalog floors are the highest document versions each network has
// accepted; losing one would let a reset wallet accept an older, superseded document.
export const PRESERVED_STORAGE_KEYS: readonly string[] = [
  ENDPOINT_OVERRIDE_STORAGE_KEY,
  BRIDGE_CONFIG_FLOOR_KEY,
  EXPLORE_CONFIG_FLOOR_KEY
];

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
    // No storage event fires in the document that wipes, so off the extension this announces it to every
    // onStorageChanged subscriber; the extension's browser.storage.onChanged already reports the removals.
    if (isMobile() || isDesktop()) storageCleared();
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
 * Removes every platform key-value entry except `keep` (by default `PRESERVED_STORAGE_KEYS`) and
 * then empties the `transactions` and `spendingLimits` tables, but deliberately keeps the TridentMain Dexie
 * connection alive. Using `db.delete()` here would fire a `versionchange` event
 * to every other open handle (notably the page's, which was opened lazily by the
 * onboarding UI), force them closed, and leave no path to reopen them short of a
 * page reload - which is how we end up with `DatabaseClosedError` on every
 * subsequent page-side Dexie read and custom-faucet `fetchTokenMetadata` calls
 * racing against a partially-loaded SDK.
 *
 * The key-value clear comes first, as in `resetStorageDestructive`, because the vault lives there: a clear
 * that rejects, even part way, leaves the caps and the history as they were, so a vault it did not reach
 * keeps them, and a table clear that rejects leaves no vault. `clearStorage(false)` clears only the
 * key-value store.
 *
 * If you need the full "throw away everything, including live connections
 * from other tabs/contexts" semantic, call `resetStorageDestructive` below.
 */
export async function clearStorage(clearDb: boolean = true, keep: readonly string[] = PRESERVED_STORAGE_KEYS) {
  await clearPlatformKeyValueStorage(keep);
  if (clearDb) {
    await Repo.transactions.clear();
    // The spend history and the caps computed from it go together. Recovery from the same mnemonic
    // reproduces the same account ids, so a surviving configuration would key-match the recovered
    // account and keep enforcing a cap over a total that was just zeroed - and the disclosure copy
    // promises that resetting app data removes both.
    await Repo.spendingLimits.clear();
  }
  await resetNativeAssetCache();
  // Rediscover now rather than on first use: the wallet being created or imported reads its
  // balance the moment it is Ready, and that read would otherwise wait on this RPC (#1123).
  primeNativeAssetId();
}

/**
 * Hard reset - explicitly what the options-page "Reset Wallet" button wants.
 * Deletes the Dexie database (forcing every live handle closed) AND every
 * platform key-value entry except `PRESERVED_STORAGE_KEYS`. Callers should only
 * use this when the user has explicitly opted into a full wipe; for wallet
 * creation flows use `clearStorage` above instead.
 *
 * The endpoint override survives the key-value clear unless `keepEndpointOverride` is false,
 * which takes it with the wipe instead of leaving it to a separate step that can fail after it.
 *
 * The key-value clear comes first, so a partial wipe leaves no vault. The delete closes every storage handle;
 * this realm reopens its own at once, and a reload reopens the other realms' handles (and this realm's, when
 * no reopen succeeded) and drops in-memory state, so a caller reports a rejected wipe and then reloads, and
 * reports a reload that cannot start. The reload does not depend on the page staying open at any point: on the
 * extension, where closing the page leaves the service worker running, a caller arms a `pagehide` reload before
 * the wipe and keeps it until its own reload has been attempted, and the extension reloads once either way.
 *
 * It fails closed. The vault lives in the key-value store, so a step after the clear that rejects leaves no
 * wallet to unlock, and a clear that rejects, even part way, leaves the database untouched, so a vault it did
 * not reach keeps its caps. A delete or reopen that rejects would leave the old rows to whatever runs next (a
 * restore from an encrypted file keeps the tables), so it reopens the database and clears the transactions and
 * spending limits, each step best effort, then rethrows the original error. A caller's re-entry guard stays set
 * through its report until the reload has been attempted.
 */
export async function resetStorageDestructive({
  keepEndpointOverride = true
}: { keepEndpointOverride?: boolean } = {}) {
  await clearPlatformKeyValueStorage(
    keepEndpointOverride
      ? PRESERVED_STORAGE_KEYS
      : PRESERVED_STORAGE_KEYS.filter(key => key !== ENDPOINT_OVERRIDE_STORAGE_KEY)
  );
  try {
    await Repo.db.delete();
    await Repo.db.open();
  } catch (err) {
    await Repo.db.open().catch(() => {});
    await Repo.transactions.clear().catch(() => {});
    await Repo.spendingLimits.clear().catch(() => {});
    throw err;
  }
  await resetNativeAssetCache();
}

// The recovery page's own wipe. On desktop localStorage is also the key-value store, so it keeps
// what a wallet-setup reset keeps, and re-reads the cache as every other wipe does; on the extension
// and mobile those names are not in it, and the re-read finds nothing changed.
export async function clearClientStorage(): Promise<void> {
  try {
    removeLocalStorageExcept(PRESERVED_STORAGE_KEYS);
    sessionStorage.clear();
  } finally {
    await rereadStorageCache();
    // localStorage was cleared in this document, which gets no storage event for it (activity-read caches it).
    storageCleared();
  }
}
