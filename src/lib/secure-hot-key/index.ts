/**
 * Platform-abstraction facade for the Guardian "hot" signing key.
 *
 * Hot keys live outside the WASM keystore. On mobile, they are wrapped under
 * a per-account hardware-backed key (iOS Secure Enclave via ECIES, Android
 * Keystore/StrongBox via RSA-OAEP) and unwrapped only inside a native plugin
 * during a biometric prompt. On extension and desktop, the JS fallback
 * serializes an `AuthSecretKey.ecdsaWithRNG(...)` blob and relies on the
 * surrounding vault envelope for at-rest protection.
 *
 * Callers should never need to know which path executed: all three operations
 * take/return strings.
 */

import { isMobile } from 'lib/platform';

import * as jsFallback from './jsFallback';
import * as nativePlugin from './nativePlugin';

export type { GeneratedHotKey } from './jsFallback';

function impl() {
  return isMobile() ? nativePlugin : jsFallback;
}

export async function generateHotKey() {
  return impl().generateHotKey();
}

export async function signHotDigest(ciphertext: string, wordHex: string): Promise<string> {
  return impl().signHotDigest(ciphertext, wordHex);
}

export async function deleteHotKey(ciphertext: string): Promise<void> {
  return impl().deleteHotKey(ciphertext);
}

/**
 * Unwrap the hot ciphertext and return the raw 32-byte secp256k1 secret hex.
 * On mobile this fires a biometric prompt (same SE/StrongBox unwrap path as
 * `signHotDigest`, minus the actual signing step). On extension/desktop the
 * JS fallback decodes the serialized `AuthSecretKey` and strips the 1-byte
 * scheme prefix so the format matches the native return.
 */
export async function revealHotKey(ciphertext: string): Promise<string> {
  return impl().revealHotKey(ciphertext);
}
