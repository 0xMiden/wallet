import { gcm } from '@noble/ciphers/aes';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

import { fromBase64Url, toBase64Url } from './base64url.js';
import { ID_BYTES, KEY_BYTES, NONCE_BYTES } from './constants.js';

const SALT = utf8ToBytes('bread-connect/v1');
const INFO = utf8ToBytes('session');

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** The app key seals what the app sends, the wallet key what Bread sends. */
export interface SessionKeys {
  appKey: Uint8Array;
  walletKey: Uint8Array;
}

export class ProtocolCryptoError extends Error {
  name = 'ProtocolCryptoError';
}

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

export function deriveSessionKeys(
  ownSecretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  appPublicKey: Uint8Array,
  walletPublicKey: Uint8Array
): SessionKeys {
  if (peerPublicKey.length !== KEY_BYTES || appPublicKey.length !== KEY_BYTES || walletPublicKey.length !== KEY_BYTES) {
    throw new ProtocolCryptoError('A public key is not 32 bytes');
  }
  let shared: Uint8Array;
  try {
    // noble refuses a shared secret of all zeros, the answer to a low-order public key.
    shared = x25519.getSharedSecret(ownSecretKey, peerPublicKey);
  } catch {
    throw new ProtocolCryptoError('The shared secret is zero');
  }
  const keys = hkdf(sha256, shared, SALT, concatBytes(INFO, appPublicKey, walletPublicKey), 2 * KEY_BYTES);
  return { appKey: keys.slice(0, KEY_BYTES), walletKey: keys.slice(KEY_BYTES) };
}

export function additionalData(type: string, session: string, id: string): Uint8Array {
  return utf8ToBytes(`bread-connect/v1|${type}|${session}|${id}`);
}

export function seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: string): Uint8Array {
  return gcm(key, nonce, aad).encrypt(utf8ToBytes(plaintext));
}

/** Throws ProtocolCryptoError when the tag does not match the key, nonce and additional data. */
export function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): string {
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, nonce, aad).decrypt(sealed);
  } catch {
    throw new ProtocolCryptoError('The sealed payload does not open');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new ProtocolCryptoError('The sealed payload is not UTF-8');
  }
}

export function randomNonce(): Uint8Array {
  return randomBytes(NONCE_BYTES);
}

export function randomId(): string {
  return toBase64Url(randomBytes(ID_BYTES));
}

export function encodeBytes(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

/** The bytes of a base64url field, or null when it is malformed or not `length` bytes long. */
export function decodeBytes(text: string, length?: number): Uint8Array | null {
  const bytes = fromBase64Url(text);
  if (!bytes || (length !== undefined && bytes.length !== length)) return null;
  return bytes;
}
