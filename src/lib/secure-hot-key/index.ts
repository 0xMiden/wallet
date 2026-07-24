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

function readErrorField(error: unknown, key: string): string | undefined {
  if (typeof error === 'object' && error !== null && key in error) {
    const value = Reflect.get(error, key);
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  const code = readErrorField(error, 'code');
  const message = readErrorField(error, 'message') ?? String(error);
  return code ? `[${code}] ${message}` : message;
}

/**
 * Run a native hot-key op and, if it fails on mobile, record the raw error and
 * surface the report prompt before re-throwing (the caller still sees the
 * failure — this only adds the user-facing signal). We report on ANY native
 * rejection, not just a specific error code: a stuck transaction can come from
 * any plugin failure, and the native codes (e.g. HARDWARE_UNAVAILABLE) are only
 * best-effort — so the isMobile() gate is the whole condition. The report
 * module is imported lazily so the wallet-prompts / faucet / React dependencies
 * never enter the facade's static graph (e.g. the extension service-worker bundle).
 */
async function withHardwareFailureReport<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isMobile()) {
      try {
        const { reportHotKeyHardwareFailure } = await import('lib/wallet-prompts');
        await reportHotKeyHardwareFailure(describeError(error));
      } catch (reportError) {
        console.warn('[secure-hot-key] failed to surface hot-key failure prompt:', reportError);
      }
    }
    throw error;
  }
}

function impl() {
  return isMobile() ? nativePlugin : jsFallback;
}

export async function generateHotKey() {
  return withHardwareFailureReport(() => impl().generateHotKey());
}

export async function signHotDigest(ciphertext: string, wordHex: string): Promise<string> {
  return withHardwareFailureReport(() => impl().signHotDigest(ciphertext, wordHex));
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
  return withHardwareFailureReport(() => impl().revealHotKey(ciphertext));
}
