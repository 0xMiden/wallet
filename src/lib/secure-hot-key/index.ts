/**
 * Platform-abstraction facade for the Guardian "hot" signing key.
 *
 * Hot keys live outside the WASM keystore. On mobile (Phase 4) they will be
 * ECIES-wrapped under a per-account P-256 key in Secure Enclave / StrongBox
 * and unwrapped only inside a native plugin during a biometric prompt. On
 * extension and desktop (Phase 5) the JS fallback serializes an
 * `AuthSecretKey.ecdsaWithRNG(...)` blob and relies on the surrounding vault
 * envelope for at-rest protection.
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
