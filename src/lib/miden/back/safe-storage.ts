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

/**
 * Fetch and decrypt a single item.
 *
 * The key parameter can be either:
 * - A PBKDF2 key (legacy password-derived key) - expects salt + iv + ciphertext format
 * - An AES-GCM key (vault key) - expects iv + ciphertext format
 */
export async function fetchAndDecryptOne<T>(storageKey: string, key: CryptoKey) {
  storageKey = await wrapStorageKey(storageKey);
  const payload = await fetchEncryptedOne<string>(storageKey);

  // Check if this is a vault key (AES-GCM) or legacy passKey (PBKDF2)
  const isVaultKey = key.algorithm.name === 'AES-GCM';

  if (isVaultKey) {
    // Vault key model: iv (32 hex) + ciphertext
    const iv = payload.slice(0, 32);
    const dt = payload.slice(32);
    return Passworder.decrypt<T>({ dt, iv }, key);
  } else {
    // Legacy model: salt (64 hex) + iv (32 hex) + ciphertext
    let cursor = 0;
    const [saltHex, iv, dt] = [64, 32, -1].map(length =>
      payload.slice(cursor, length !== -1 ? (cursor += length) : undefined)
    ) as [string, string, string];
    const encrypted = { dt, iv };
    const salt = new Uint8Array(Buffer.from(saltHex, 'hex'));
    const derivedPassKey = await Passworder.deriveKey(key, salt);
    return Passworder.decrypt<T>(encrypted, derivedPassKey);
  }
}

/**
 * Encrypt and save multiple items.
 *
 * The key parameter can be either:
 * - A PBKDF2 key (legacy password-derived key) - will use salt + PBKDF2 derivation
 * - An AES-GCM key (vault key) - will use direct encryption with random IV
 *
 * The key type is determined by checking the algorithm property.
 */
export async function encryptAndSaveMany(items: [string, any][], key: CryptoKey) {
  // Check if this is a vault key (AES-GCM) or legacy passKey (PBKDF2)
  const isVaultKey = key.algorithm.name === 'AES-GCM';

  const encItems = await Promise.all(
    items.map(async ([storageKey, stuff]) => {
      storageKey = await wrapStorageKey(storageKey);

      let toSave: string;

      if (isVaultKey) {
        // Vault key model: direct AES-GCM encryption with random IV
        const { dt, iv } = await Passworder.encrypt(stuff, key);
        // Format: iv (32 hex chars = 16 bytes) + ciphertext
        toSave = iv + dt;
      } else {
        // Legacy model: PBKDF2 derivation from passKey
        const salt = Passworder.generateSalt();
        const derivedPassKey = await Passworder.deriveKey(key, salt);
        const { dt, iv } = await Passworder.encrypt(stuff, derivedPassKey);
        // Format: salt (64 hex chars = 32 bytes) + iv (32 hex chars) + ciphertext
        const saltHex = Buffer.from(salt).toString('hex');
        toSave = saltHex + iv + dt;
      }

      return [storageKey, toSave] as [typeof storageKey, typeof toSave];
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

async function fetchEncryptedOne<T>(key: string) {
  const items = await getStorage().get([key]);
  if (items[key] !== undefined) {
    return items[key] as T;
  } else {
    throw new Error('Some storage item not found');
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

export async function fetchAndDecryptOneWithLegacyFallBack<T>(storageKey: string, passKey: CryptoKey) {
  try {
    return await fetchAndDecryptOne<T>(storageKey, passKey);
  } catch (err: any) {
    return await fetchAndDecryptOneLegacy<T>(storageKey, passKey);
  }
}

/**
 * @deprecated
 */
export async function isStoredLegacy(storageKey: string) {
  const value = await getPlain(storageKey);
  return value !== undefined;
}

/**
 * @deprecated
 */
export async function removeManyLegacy(keys: string[]) {
  await getStorage().remove(keys);
}

/**
 * @deprecated
 */
export async function fetchAndDecryptOneLegacy<T>(storageKey: string, passKey: CryptoKey) {
  storageKey = await wrapStorageKey(storageKey);
  const payload = await fetchEncryptedOne<string>(storageKey);
  let cursor = 0;
  const [saltHex, iv, dt] = [64, 32, -1].map(length =>
    payload.slice(cursor, length !== -1 ? (cursor += length) : undefined)
  ) as [string, string, string];
  const encrypted = { dt, iv };
  const salt = new Uint8Array(Buffer.from(saltHex, 'hex'));
  let derivedPassKey = await Passworder.deriveKeyLegacy(passKey, salt);
  return Passworder.decrypt<T>(encrypted, derivedPassKey);
}

/**
 * @deprecated
 */
export async function encryptAndSaveManyLegacy(items: [string, any][], passKey: CryptoKey) {
  const encItems = await Promise.all(
    items.map(async ([storageKey, stuff]) => {
      const salt = Passworder.generateSalt();
      const derivedPassKey = await Passworder.deriveKeyLegacy(passKey, salt);
      const encrypted = await Passworder.encrypt(stuff, derivedPassKey);

      const encStorage = {
        encrypted,
        salt: Buffer.from(salt).toString('hex')
      };

      return [storageKey, encStorage] as [typeof storageKey, typeof encStorage];
    })
  );

  await saveEncrypted(encItems);
}
