import { Buffer } from 'buffer';

import * as Passworder from 'lib/miden/passworder';
import { getStorageProvider, StorageProvider } from 'lib/platform/storage-adapter';

// Lazy-load storage provider to ensure platform detection has completed
// (Tauri injects __TAURI_INTERNALS__ after initial script execution)
let _storage: StorageProvider | null = null;
function getStorage(): StorageProvider {
  if (!_storage) {
    _storage = getStorageProvider();
  }
  return _storage;
}

export async function isStored(storageKey: string) {
  storageKey = await wrapStorageKey(storageKey);
  const value = await getPlain(storageKey);
  return value !== undefined;
}

/** Fetch and decrypt one item stored as iv (32 hex) + AES-GCM ciphertext under the vault key. */
export async function fetchAndDecryptOne<T>(storageKey: string, key: CryptoKey) {
  storageKey = await wrapStorageKey(storageKey);
  const payload = await fetchEncryptedOne<string>(storageKey);
  const iv = payload.slice(0, 32);
  const dt = payload.slice(32);
  return Passworder.decrypt<T>({ dt, iv }, key);
}

/** Encrypt and save several items under the vault key, each as iv (32 hex) + ciphertext. */
export async function encryptAndSaveMany(items: [string, any][], key: CryptoKey) {
  const encItems = await Promise.all(
    items.map(async ([storageKey, stuff]) => {
      storageKey = await wrapStorageKey(storageKey);
      const { dt, iv } = await Passworder.encrypt(stuff, key);
      return [storageKey, iv + dt] as [string, string];
    })
  );

  await saveEncrypted(encItems);
}

export async function removeMany(keys: string[]) {
  await getStorage().remove(await Promise.all(keys.map(wrapStorageKey)));
}

export async function getPlain<T>(key: string): Promise<T | undefined> {
  const items = await getStorage().get([key]);
  return items[key] as T | undefined;
}

export function savePlain<T>(key: string, value: T) {
  return getStorage().set({ [key]: value });
}

/**
 * How this layer signals ABSENCE, as opposed to a decrypt or storage failure. Exported so a caller
 * that must tell the two apart compares against the contract rather than a copied string literal.
 */
export const STORAGE_ITEM_NOT_FOUND = 'Some storage item not found';

async function fetchEncryptedOne<T>(key: string) {
  const items = await getStorage().get([key]);
  if (items[key] !== undefined) {
    return items[key] as T;
  } else {
    throw new Error(STORAGE_ITEM_NOT_FOUND);
  }
}

async function saveEncrypted<T>(items: { [k: string]: T } | [string, T][]) {
  if (Array.isArray(items)) {
    items = iterToObj(items);
  }
  await getStorage().set(items);
}

function iterToObj(iter: [string, any][]) {
  const obj: { [k: string]: any } = {};
  for (const [k, v] of iter) {
    obj[k] = v;
  }
  return obj;
}

async function wrapStorageKey(key: string) {
  const bytes = await crypto.subtle.digest('SHA-256', Buffer.from(key, 'utf-8'));
  return Buffer.from(bytes).toString('hex');
}
