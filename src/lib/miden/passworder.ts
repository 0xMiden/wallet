import { Buffer } from 'buffer';

/**
 * password => passKey
 * passKey + salt => derivedPassKey
 * stuff + derivedPassKey => enc_stuff
 * enc_stuff + derivedPassKey => stuff
 *
 * Encrypt
 * 1) salt = generateSalt()
 * 2) passKey = generateKey(password*)
 * 3) derivedPassKey = deriveKey(passKey, salt)
 * 3) encryptedStuff = encrypt(stuff*, derivedPassKey)
 * 4) persist*(salt, encryptedStuff)
 *
 * Decrypt
 * 1) load*(salt, encryptedStuff)
 * 2) derivedPassKey = deriveKey(passKey*, salt)
 * 3) stuff = decrypt(encryptedStuff*, derivedPassKey)
 *
 */

export type EncryptedPayload = { dt: string; iv: string };

export async function encrypt(stuff: any, key: CryptoKey): Promise<EncryptedPayload> {
  const stuffStr = JSON.stringify(stuff);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const encryptedStuff = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    Buffer.from(stuffStr)
  );

  return {
    dt: Buffer.from(encryptedStuff).toString('hex'),
    iv: Buffer.from(iv).toString('hex')
  };
}

export async function decrypt<T = any>(
  { dt: encryptedStuffHex, iv: ivHex }: EncryptedPayload,
  key: CryptoKey
): Promise<T> {
  const stuffBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(ivHex, 'hex') },
    key,
    Buffer.from(encryptedStuffHex, 'hex')
  );
  const stuffStr = Buffer.from(stuffBuf).toString();
  return JSON.parse(stuffStr);
}

export async function encryptJson(jsonStuff: any, key: CryptoKey): Promise<EncryptedPayload> {
  const encoder = new TextEncoder();
  const stuffStr = JSON.stringify(jsonStuff);
  const stuffBytes = encoder.encode(stuffStr);

  const iv = crypto.getRandomValues(new Uint8Array(16));

  const data = new Uint8Array(stuffBytes);
  const encryptedStuff = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer
    },
    key,
    data
  );

  const arrayBufferToBase64 = (buffer: ArrayBuffer | Uint8Array) => {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(b => (binary += String.fromCharCode(b)));
    return btoa(binary);
  };

  return {
    dt: arrayBufferToBase64(encryptedStuff),
    iv: arrayBufferToBase64(iv)
  };
}

export async function decryptJson(payload: EncryptedPayload, key: CryptoKey): Promise<any> {
  const { dt, iv } = payload;

  // Convert Base64 to ArrayBuffer
  const base64ToArrayBuffer = (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  };

  const encryptedData = base64ToArrayBuffer(dt);
  const ivBytes = base64ToArrayBuffer(iv);

  const decryptedStuff = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, encryptedData);

  const decoder = new TextDecoder();
  const decryptedStr = decoder.decode(decryptedStuff);

  try {
    const parsedData = JSON.parse(decryptedStr);
    return parsedData;
  } catch (err) {
    console.error('Failed to parse decrypted JSON:', err);
    throw new Error('Decryption succeeded but JSON parsing failed.');
  }
}

// This is deterministic given the string, per Evan
export async function generateKey(password: string) {
  const hash = await crypto.subtle.digest('SHA-256', Buffer.from(password, 'utf-8'));
  return importKey(hash);
}

export function deriveKey(key: CryptoKey, salt: Uint8Array, iterations = 1_310_000) {
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(new Uint8Array(salt));
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations,
      hash: 'SHA-256'
    },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function generateSalt(byteCount = 32) {
  const view = new Uint8Array(byteCount);
  crypto.getRandomValues(view);
  return view;
}

function importKey(keyData: ArrayBuffer) {
  return crypto.subtle.importKey('raw', keyData, 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}

/**
 * @deprecated
 */
export function generateKeyLegacy(password: string) {
  const buf = Buffer.alloc(32, password);
  return importKey(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * @deprecated
 */
export function deriveKeyLegacy(key: CryptoKey, salt: Uint8Array) {
  return deriveKey(key, salt, 310_000);
}

/**
 * Generate the key hash from a password (for keychain storage)
 *
 * This generates the same SHA-256 hash used by generateKey, but returns
 * the raw hash as a base64 string for secure storage in the OS keychain.
 *
 * @param password - The user's password
 * @returns Base64-encoded SHA-256 hash of the password
 */
export async function generateKeyHash(password: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Buffer.from(password, 'utf-8'));
  return Buffer.from(hash).toString('base64');
}

/**
 * Generate a CryptoKey from a stored key hash
 *
 * This recreates the passKey from a hash that was previously stored
 * in the OS keychain. Used for biometric unlock on desktop.
 *
 * @param keyHash - Base64-encoded SHA-256 hash from generateKeyHash
 * @returns CryptoKey that can be used with deriveKey for encryption/decryption
 */
export async function generateKeyFromHash(keyHash: string): Promise<CryptoKey> {
  const hashBuffer = Buffer.from(keyHash, 'base64');
  return importKey(hashBuffer.buffer.slice(hashBuffer.byteOffset, hashBuffer.byteOffset + hashBuffer.byteLength));
}

// ============================================================================
// Binary Encryption (for cloud backup payloads)
// ============================================================================

/** AES-GCM encrypt raw bytes. Returns iv (16 bytes) + ciphertext. */
export async function encryptBytes(data: Uint8Array<ArrayBuffer>, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(16 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 16);
  return out;
}

/** Decrypt bytes produced by encryptBytes. Expects iv (16 bytes) + ciphertext. */
export async function decryptBytes(data: Uint8Array<ArrayBuffer>, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const iv = data.subarray(0, 16);
  const ciphertext = data.subarray(16);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

// ============================================================================
// Vault Key Model
// ============================================================================

/**
 * Generate a random 256-bit vault key
 *
 * The vault key is a random key used to encrypt all wallet data.
 * It is NOT derived from the password - this makes offline brute-force
 * attacks impossible even if the encrypted data is stolen.
 *
 * @returns Random 32-byte (256-bit) key as Uint8Array
 */
export function generateVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Import raw vault key bytes into a CryptoKey for AES-GCM operations
 */
export async function importVaultKey(vaultKeyBytes: Uint8Array): Promise<CryptoKey> {
  // Copy to new ArrayBuffer to satisfy TypeScript's BufferSource type
  const buffer = new ArrayBuffer(vaultKeyBytes.byteLength);
  new Uint8Array(buffer).set(vaultKeyBytes);
  return crypto.subtle.importKey('raw', buffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Export CryptoKey back to raw bytes (for encryption/storage)
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  // Create a new extractable key for export since vault keys are non-extractable by default
  const keyData = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(keyData);
}

/**
 * Encrypt the vault key with a password-derived passKey
 *
 * Uses AES-GCM with a random IV. The output format is:
 * salt (32 bytes) + iv (16 bytes) + ciphertext
 * All encoded as base64.
 *
 * @param vaultKey - The vault key bytes to encrypt
 * @param password - User's password
 * @returns Base64-encoded encrypted vault key
 */
export async function encryptVaultKeyWithPassword(vaultKey: Uint8Array, password: string): Promise<string> {
  const salt = generateSalt();
  const passKey = await generateKey(password);
  const derivedKey = await deriveKey(passKey, salt);

  const iv = crypto.getRandomValues(new Uint8Array(16));
  // Copy to new ArrayBuffer to satisfy TypeScript's BufferSource type
  const vaultKeyBuffer = new ArrayBuffer(vaultKey.byteLength);
  new Uint8Array(vaultKeyBuffer).set(vaultKey);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derivedKey, vaultKeyBuffer);

  // Concatenate: salt (32) + iv (16) + ciphertext
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt the vault key with a password-derived passKey
 *
 * @param encryptedVaultKey - Base64-encoded encrypted vault key from encryptVaultKeyWithPassword
 * @param password - User's password
 * @returns The decrypted vault key bytes
 * @throws If password is incorrect or data is corrupted
 */
export async function decryptVaultKeyWithPassword(encryptedVaultKey: string, password: string): Promise<Uint8Array> {
  const combined = Buffer.from(encryptedVaultKey, 'base64');

  // Extract: salt (32) + iv (16) + ciphertext
  const salt = new Uint8Array(combined.slice(0, 32));
  const iv = new Uint8Array(combined.slice(32, 48));
  const ciphertext = new Uint8Array(combined.slice(48));

  const passKey = await generateKey(password);
  const derivedKey = await deriveKey(passKey, salt);

  const vaultKeyBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derivedKey, ciphertext);

  return new Uint8Array(vaultKeyBuffer);
}

/**
 * Verify a password is correct by attempting to decrypt the vault key
 *
 * @param encryptedVaultKey - Base64-encoded encrypted vault key
 * @param password - Password to verify
 * @returns true if password is correct, false otherwise
 */
export async function verifyPassword(encryptedVaultKey: string, password: string): Promise<boolean> {
  try {
    await decryptVaultKeyWithPassword(encryptedVaultKey, password);
    return true;
  } catch {
    return false;
  }
}
