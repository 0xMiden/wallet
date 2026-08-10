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
 * Native reject codes that are ordinary, expected outcomes of an interactive
 * or transient state — the user tapped Cancel on the biometric sheet, no OS
 * authenticator is enrolled, another prompt is already up, the device is
 * locked, or biometric auth simply failed. None of these indicate defective
 * secure hardware, so they must never seed the "secure hardware failure"
 * report prompt (a normal Cancel reading as a hardware failure is worse than
 * no signal at all). AUTH_UNAVAILABLE in particular is the reveal gate
 * working as designed on a device with no OS lock enrolled — the native
 * plugins intentionally refuse to reveal without OS-level authentication
 * (see confirmPresenceThenReveal in HotKeyPlugin.kt / revealHotKey in
 * HotKeyPlugin.swift); do not route it to a fallback that skips the gate.
 */
const BENIGN_NATIVE_CODES = new Set([
  'USER_CANCELLED',
  'AUTH_UNAVAILABLE',
  'AUTH_FAILED',
  'BIOMETRIC_BUSY',
  'DEVICE_LOCKED'
]);

/**
 * Native reject codes whose remedy is a hot-key ROTATION, not a hardware
 * report: the wrapper key exists but can no longer decrypt this blob
 * (UNWRAP_FAILED — e.g. an OS upgrade dropped an OAEP authorization) or the
 * OS invalidated the key outright (KEY_INVALIDATED — e.g. biometric
 * re-enrollment on a legacy auth-bound key). Routed to the rotation prompt so
 * the user gets an actionable "rotate your device key" instead of a
 * "defective hardware" report.
 */
const ROTATION_NATIVE_CODES = new Set(['UNWRAP_FAILED', 'KEY_INVALIDATED']);

/**
 * Run a native hot-key op and, if it fails on mobile, surface the matching
 * user-facing signal before re-throwing (the caller still sees the failure —
 * this only adds the prompt). Failures are triaged by the native plugins'
 * stable codes: benign interactive/transient outcomes surface nothing,
 * blob/key mismatches seed the rotation prompt, and everything else — a
 * genuine HARDWARE_UNAVAILABLE or an unclassified native error (a stuck
 * transaction can come from any plugin failure) — records the raw error and
 * seeds the hardware-failure report prompt. Recovered failures (a
 * HARDWARE_UNAVAILABLE that falls back to JS at generate time) never reach
 * here, because the wrapped op resolves instead of throwing. The report
 * module is imported lazily so the wallet-prompts / faucet / React dependencies
 * never enter the facade's static graph (e.g. the extension service-worker bundle).
 */
async function withHardwareFailureReport<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    const code = readErrorField(error, 'code');
    if (isMobile() && !(code !== undefined && BENIGN_NATIVE_CODES.has(code))) {
      try {
        if (code !== undefined && ROTATION_NATIVE_CODES.has(code)) {
          const { reportHotKeyRotationNeeded } = await import('lib/wallet-prompts');
          await reportHotKeyRotationNeeded();
        } else {
          const { reportHotKeyHardwareFailure } = await import('lib/wallet-prompts');
          await reportHotKeyHardwareFailure(describeError(error));
        }
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
