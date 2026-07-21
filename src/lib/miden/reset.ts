import * as Repo from 'lib/miden/repo';
import { resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { isDesktop, isExtension, isMobile } from 'lib/platform';

async function clearPlatformKeyValueStorage(): Promise<void> {
  if (isMobile()) {
    // On mobile, use native Capacitor Preferences.clear()
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.clear();
    // Also delete the Secure Enclave hardware key. It lives in the iOS Keychain,
    // NOT in Preferences, so Preferences.clear() leaves it behind. Without this a
    // "Reset Wallet" can't recover from an orphaned/unusable hardware key: the next
    // onboarding sees `hasHardwareKey() === true` and reuses the stale key, so the
    // biometric-unlock dead-end survives the only escape button. Best-effort — the
    // key may not exist, and non-iOS mobile platforms may not implement it.
    try {
      const { deleteHardwareKey } = await import('lib/biometric');
      await deleteHardwareKey();
    } catch {
      // no hardware key / not supported on this platform — nothing to clean up
    }
  } else if (isDesktop()) {
    // On desktop, use localStorage
    localStorage.clear();
  } else if (isExtension()) {
    // On extension, use browser.storage.local.clear()
    const browser = await import('webextension-polyfill');
    await browser.default.storage.local.clear();
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
  }
  await clearPlatformKeyValueStorage();
  await resetNativeAssetCache();
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

export function clearClientStorage() {
  localStorage.clear();
  sessionStorage.clear();
}
