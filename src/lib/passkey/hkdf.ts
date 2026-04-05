const INFO = new TextEncoder().encode('miden-wallet-backup');

/**
 * Derive a 32-byte AES-256 key from WebAuthn PRF output using HKDF-SHA256.
 *
 * @param ikm - Input key material (PRF output from WebAuthn)
 * @param salt - Random 32-byte salt (stored alongside the backup)
 * @returns 32-byte derived key suitable for AES-256-GCM
 */
export async function hkdfDerive(ikm: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, baseKey, 256);
  return new Uint8Array(bits);
}
