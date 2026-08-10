import { ENDPOINT_OVERRIDE_STORAGE_KEY } from 'lib/miden-chain/effective-endpoints';
import { resetNativeAssetCache } from 'lib/miden-chain/native-asset';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { isDesktop, isExtension, isMobile } from 'lib/platform';

// Keys that are configuration, NOT wallet data, and must survive a storage
// reset. The dev-settings endpoint override selects the network the wallet is
// being created for — and it is set BEFORE creation. Without preserving it,
// creating a wallet on a custom network wipes the override (the wipe below is a
// blanket `clear()`), so the wallet silently reverts to the build-default
// network while the account was already minted on the custom one — leaving the
// account on one network and the client (balances, faucet, native token) on
// another. The dedicated dev-settings "Reset to defaults" clears it explicitly.
const PRESERVED_STORAGE_KEYS = [ENDPOINT_OVERRIDE_STORAGE_KEY];

async function clearPlatformKeyValueStorage(): Promise<void> {
  // Snapshot preserved config before the blanket wipe, restore it after.
  const preserved: Record<string, unknown> = {};
  for (const key of PRESERVED_STORAGE_KEYS) {
    const value = await fetchFromStorage(key).catch(() => null);
    if (value != null) preserved[key] = value;
  }

  if (isMobile()) {
    // On mobile, use native Capacitor Preferences.clear()
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.clear();
  } else if (isDesktop()) {
    // On desktop, use localStorage
    localStorage.clear();
  } else if (isExtension()) {
    // On extension, use browser.storage.local.clear()
    const browser = await import('webextension-polyfill');
    await browser.default.storage.local.clear();
  }

  for (const [key, value] of Object.entries(preserved)) {
    await putToStorage(key, value).catch(() => {});
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
