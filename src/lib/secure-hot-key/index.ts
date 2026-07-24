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
 * Mobile devices whose secure hardware is genuinely unusable (the native
 * plugins reject with code HARDWARE_UNAVAILABLE) fall back to the JS
 * implementation at generate time so onboarding still succeeds — the key is
 * then only as protected as the vault envelope, same trade-off as extension.
 * Per-key operations route by blob format, not platform: native ciphertexts
 * are "<b64-tag>:<b64-payload>" (always contain ':'), JS-fallback ones are
 * plain hex (never do), so a mobile account minted via the fallback keeps
 * signing with it while hardware-backed accounts stay native.
 *
 * Callers should never need to know which path executed: all operations
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
 * any plugin failure, and the native codes are only best-effort — so the
 * isMobile() gate is the whole condition. Recovered failures (a
 * HARDWARE_UNAVAILABLE that falls back to JS at generate time) never reach
 * here, because the wrapped op resolves instead of throwing. The report
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

// Reject code raised by both native HotKey plugins when Keystore/StrongBox
// (Android) or the Secure Enclave (iOS) genuinely cannot be used — distinct
// from transient states (DEVICE_LOCKED) and user-driven ones (USER_CANCELLED).
const HARDWARE_UNAVAILABLE_CODE = 'HARDWARE_UNAVAILABLE';

function isHardwareUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return Reflect.get(error, 'code') === HARDWARE_UNAVAILABLE_CODE;
}

function implFor(ciphertext: string) {
  return ciphertext.includes(':') ? nativePlugin : jsFallback;
}

export async function generateHotKey() {
  if (!isMobile()) return jsFallback.generateHotKey();
  return withHardwareFailureReport(async () => {
    try {
      return await nativePlugin.generateHotKey();
    } catch (error) {
      if (!isHardwareUnavailable(error)) throw error;
      console.warn('[secure-hot-key] secure hardware unavailable, generating JS-fallback hot key:', error);
      return jsFallback.generateHotKey();
    }
  });
}

export async function signHotDigest(ciphertext: string, wordHex: string): Promise<string> {
  return withHardwareFailureReport(() => implFor(ciphertext).signHotDigest(ciphertext, wordHex));
}

export async function deleteHotKey(ciphertext: string): Promise<void> {
  return implFor(ciphertext).deleteHotKey(ciphertext);
}

/**
 * Unwrap the hot ciphertext and return the raw 32-byte secp256k1 secret hex.
 * On native-wrapped keys this runs the SE/StrongBox unwrap path (same as
 * `signHotDigest`, minus the actual signing step). On JS-fallback keys it
 * decodes the serialized `AuthSecretKey` and strips the 1-byte scheme prefix
 * so the format matches the native return.
 */
export async function revealHotKey(ciphertext: string): Promise<string> {
  return withHardwareFailureReport(() => implFor(ciphertext).revealHotKey(ciphertext));
}
