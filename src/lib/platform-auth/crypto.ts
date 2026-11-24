import { Buffer } from 'buffer';

import { importVaultKey } from 'lib/miden/passworder';

import { PlatformCredentialMetadata, PlatformUnlockRecord } from './types';

export function encodePlatformBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePlatformBytes(value: string): Uint8Array<ArrayBuffer> {
  if (value.length > 1364 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid platform credential');
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  // Ownership comparisons use the encoded ID, so alternate spellings must not identify the same credential.
  if (encodePlatformBytes(bytes) !== value) throw new Error('Invalid platform credential');
  return bytes;
}

export function parsePlatformCredentialMetadata(value: unknown): PlatformCredentialMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const credentialId: unknown = Reflect.get(value, 'credentialId');
  const prfSalt: unknown = Reflect.get(value, 'prfSalt');
  const backupEligible: unknown = Reflect.get(value, 'backupEligible');
  if (typeof credentialId !== 'string' || typeof prfSalt !== 'string' || typeof backupEligible !== 'boolean')
    return null;
  try {
    if (decodePlatformBytes(credentialId).length > 1023 || decodePlatformBytes(prfSalt).length !== 32) return null;
    return { credentialId, prfSalt, backupEligible };
  } catch {
    return null;
  }
}

export function parsePlatformUnlockRecord(value: unknown): PlatformUnlockRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const metadata = parsePlatformCredentialMetadata(value);
  const version: unknown = Reflect.get(value, 'version');
  const wrappedKey: unknown = Reflect.get(value, 'wrappedKey');
  if (metadata === null || version !== 1 || typeof wrappedKey !== 'string') return null;
  try {
    if (decodePlatformBytes(wrappedKey).length !== 60) return null;
    return { ...metadata, version, wrappedKey };
  } catch {
    return null;
  }
}

async function deriveWrappingKey(prfSecret: Uint8Array, credentialId: Uint8Array): Promise<CryptoKey> {
  if (prfSecret.byteLength !== 32 || credentialId.byteLength < 1 || credentialId.byteLength > 1023) {
    throw new Error('Invalid platform credential');
  }
  const material = await crypto.subtle.importKey('raw', new Uint8Array(prfSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(credentialId),
      info: new TextEncoder().encode('miden-wallet:vault-key-platform:v1')
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapPlatformVaultKey(
  vaultKey: Uint8Array,
  prfSecret: Uint8Array,
  credentialId: Uint8Array
): Promise<string> {
  if (vaultKey.byteLength !== 32) throw new Error('Invalid vault key');
  const key = await deriveWrappingKey(prfSecret, credentialId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(vaultKey));
  const payload = new Uint8Array(60);
  payload.set(iv);
  payload.set(new Uint8Array(ciphertext), 12);
  return encodePlatformBytes(payload);
}

export async function unwrapPlatformVaultKey(
  wrappedKey: string,
  prfSecret: Uint8Array,
  credentialId: Uint8Array
): Promise<CryptoKey> {
  const payload = decodePlatformBytes(wrappedKey);
  if (payload.length !== 60) throw new Error('Invalid wrapped vault key');
  const key = await deriveWrappingKey(prfSecret, credentialId);
  const bytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, key, payload.slice(12))
  );
  try {
    return await importVaultKey(bytes);
  } finally {
    bytes.fill(0);
  }
}
