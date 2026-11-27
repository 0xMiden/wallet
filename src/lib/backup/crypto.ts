/**
 * Encryption of backup entries (wallet-api contract, envelope 1).
 *
 * - storageKey = sha256(sync signature over "miden-sync:storage-key:" + profileId)
 * - encKey = scrypt(storageKey, profile salt, N = 2^17, r = 8, p = 1, dkLen = 32)
 * - hashedKey = sha256(utf8(entryKey) || storageKey), lowercase hex
 * - blob = nonce (12) || AES-256-GCM ciphertext || tag (16), base64 on the wire
 *
 * Every function is pure apart from the random nonce, which a caller can give.
 * No function here keeps a key.
 */
import { scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

/** The only envelope version. */
export const ENVELOPE_VERSION = 1;

export const AES_GCM_NONCE_LENGTH = 12;
export const AES_GCM_TAG_LENGTH = 16;
export const SALT_LENGTH = 16;

/** The decoded blob cap of a `history` entry. */
export const HISTORY_BLOB_CAP = 25600;
/** The decoded blob cap of every other feature. */
export const DEFAULT_BLOB_CAP = 4096;

export interface ScryptParams {
  /** log2 of the scrypt cost N. */
  logN: number;
  r: number;
  p: number;
  dkLen: 16 | 32;
  saltLen: number;
}

/** The parameters of envelope 1. They pack to 36624. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { logN: 17, r: 8, p: 1, dkLen: 32, saltLen: SALT_LENGTH };

/** The wire shape of one encrypted entry, in both directions. */
export interface EncryptedEntry {
  envelope: number;
  kdfParams: number;
  blob: string;
}

const KDF_ID_SCRYPT = 0;
const RESERVED_BITS_MASK = 0xffe00000;

/**
 * Pack scrypt parameters into `kdf_params` (architecture doc 5.2), least
 * significant bit first: KDF id (0..3), log2 N (4..8), r - 1 (9..12),
 * p - 1 (13..14), dkLen 32 flag (15), saltLen - 16 (16..20). Bits 21..31 are 0.
 */
export function packKdfParams(params: ScryptParams): number {
  return (
    KDF_ID_SCRYPT |
    (params.logN << 4) |
    ((params.r - 1) << 9) |
    ((params.p - 1) << 13) |
    ((params.dkLen === 32 ? 1 : 0) << 15) |
    ((params.saltLen - SALT_LENGTH) << 16)
  );
}

/** Unpack `kdf_params`. Returns null for a reserved bit, an unknown KDF or a value out of the contract's ranges. */
export function unpackKdfParams(value: number): ScryptParams | null {
  if (!Number.isSafeInteger(value) || value < 0 || (value & RESERVED_BITS_MASK) !== 0) return null;
  if ((value & 0xf) !== KDF_ID_SCRYPT) return null;
  const params: ScryptParams = {
    logN: (value >>> 4) & 0x1f,
    r: ((value >>> 9) & 0xf) + 1,
    p: ((value >>> 13) & 0x3) + 1,
    dkLen: ((value >>> 15) & 0x1) === 1 ? 32 : 16,
    saltLen: ((value >>> 16) & 0x1f) + SALT_LENGTH
  };
  if (params.logN < 14 || params.logN > 20) return null;
  return params;
}

/** The storage key: SHA-256 of the 64-byte sync signature over the storage-key message. */
export function storageKeyFromSignature(signature: Uint8Array): Uint8Array {
  return sha256(signature);
}

/** The hashed entry key the server sees: sha256(utf8(entryKey) || storageKey), lowercase hex. */
export function hashedEntryKey(entryKey: string, storageKey: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes(entryKey), storageKey)));
}

/** A lowercase hex SHA-256 of a plaintext, to tell a changed entry from an unchanged one. */
export function plaintextDigest(plaintext: string): string {
  return bytesToHex(sha256(utf8ToBytes(plaintext)));
}

/**
 * Stretch the storage key into the 32 raw bytes of the AES key. The scrypt run
 * at 2^17 uses about 128 MiB and runs once per unlock. The async form yields to
 * the event loop between blocks.
 */
export function deriveEncryptionKeyBytes(
  storageKey: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS
): Promise<Uint8Array> {
  if (salt.length !== params.saltLen) {
    return Promise.reject(new Error(`The profile salt must be ${params.saltLen} bytes`));
  }
  return scryptAsync(storageKey, salt, { N: 2 ** params.logN, r: params.r, p: params.p, dkLen: params.dkLen });
}

/** Import 32 raw bytes as a non-extractable AES-GCM key. */
export async function importEncryptionKey(raw: Uint8Array): Promise<CryptoKey> {
  const copy = toArrayBuffer(raw);
  try {
    return await crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    new Uint8Array(copy).fill(0);
  }
}

/** The decoded blob size a plaintext of `plaintextBytes` bytes encrypts to. */
export function encryptedBlobLength(plaintextBytes: number): number {
  return AES_GCM_NONCE_LENGTH + plaintextBytes + AES_GCM_TAG_LENGTH;
}

/**
 * Encrypt one plaintext into a wire entry. Each call takes a fresh random
 * 12-byte nonce; a test can give its own. Never give the same nonce twice
 * under one key.
 */
export async function encryptEntry(
  key: CryptoKey,
  plaintext: string,
  kdfParams: number,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_LENGTH))
): Promise<EncryptedEntry> {
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new Error(`The AES-GCM nonce must be ${AES_GCM_NONCE_LENGTH} bytes`);
  }
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: AES_GCM_TAG_LENGTH * 8 },
    key,
    toArrayBuffer(utf8ToBytes(plaintext))
  );
  return {
    envelope: ENVELOPE_VERSION,
    kdfParams,
    blob: u8ToB64(concatBytes(nonce, new Uint8Array(sealed)))
  };
}

/**
 * Decrypt one wire entry. Refuses an unknown envelope, a blob shorter than a
 * nonce and a tag, or a blob over `maxBlobBytes`. A wrong key or a changed
 * byte fails the GCM tag check and rejects.
 */
export async function decryptEntry(key: CryptoKey, entry: EncryptedEntry, maxBlobBytes: number): Promise<string> {
  if (entry.envelope !== ENVELOPE_VERSION) {
    throw new Error(`Unknown backup envelope ${entry.envelope}`);
  }
  const blob = b64ToU8(entry.blob);
  if (blob.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH || blob.length > maxBlobBytes) {
    throw new Error(`Backup blob length ${blob.length} is out of range`);
  }
  const nonce = blob.subarray(0, AES_GCM_NONCE_LENGTH);
  const sealed = blob.subarray(AES_GCM_NONCE_LENGTH);
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: AES_GCM_TAG_LENGTH * 8 },
    key,
    toArrayBuffer(sealed)
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(opened);
}

/** Copy bytes into a fresh ArrayBuffer, the type WebCrypto takes. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
