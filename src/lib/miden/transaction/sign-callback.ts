// Sign-callback classification + the SW-side sign-reason slot (issue #260,
// slice 5).
//
// This is a LEAF module: it depends only on `Buffer` and a type-only import of
// `MidenClientCreateOptions`. It exists to break an import cycle that Slice 5
// would otherwise introduce. The reverse-IPC sign handler (SW-side, in
// `back/miden-client-proxy.ts`) must classify a failed sign the SAME way the
// inline path always has (`buildSignCallbackError`), and `readLastAuthReason`
// (`helper.ts`) must be able to read the classified reason. If those lived in
// `helper.ts` and the proxy imported `helper` while `helper` read the proxy's
// slot, `helper ↔ proxy` would cycle. Hosting the classifier + the reason slot
// in this leaf lets both the proxy and `helper` import it with no cycle.
//
// `helper.ts` re-exports the classifier types/functions, so every existing
// caller (`import { buildSignCallbackError } from './helper'` / `./index`)
// keeps working unchanged.

import { Buffer } from 'buffer';

import type { MidenClientCreateOptions } from '../sdk/miden-client-interface';

/**
 * Stable tags attached to errors the sign callback throws, so the catch
 * site for a failed executeTransaction can pattern-match on the raw
 * thrown value (recovered via `midenClient.lastAuthError()`) and treat
 * each failure mode differently — e.g. retry a `locked` failure after
 * the wallet unlocks instead of marking the tx permanently Failed.
 */
export type SignCallbackReason = 'locked' | 'rejected' | 'not_found' | 'internal';

export interface SignCallbackError extends Error {
  reason: SignCallbackReason;
}

/**
 * Wrap an underlying sign failure in a typed Error that the SDK will
 * capture verbatim (see `WebClient.lastAuthError`). Classifies by
 * inspecting the underlying error's shape — current signals are the
 * Zustand-store locked state (string "Not initialized" from
 * `assertInited`) and generic TypeError for null-vault access.
 */
export function buildSignCallbackError(err: unknown): SignCallbackError {
  const underlying = err instanceof Error ? err : new Error(String(err));
  let reason: SignCallbackReason = 'internal';
  const msg = underlying.message || '';
  if (/not initialized|locked|vault.*null|Cannot read propert/i.test(msg)) {
    reason = 'locked';
  }
  const wrapped = Object.assign(new Error(`Sign callback failed (${reason}): ${msg}`), {
    reason,
    cause: underlying
  }) as SignCallbackError;
  return wrapped;
}

/**
 * Build the `MidenClientCreateOptions` whose `signCallback` wraps a raw
 * `(publicKeyHex, signingInputsHex)` signer into the byte-shaped SDK keystore
 * callback, tagging any thrown value via {@link buildSignCallbackError}.
 *
 * This is the EXACT wrapper `generateTransaction` has always built inline for
 * the non-guardian write; extracting it (verbatim) means the flag-OFF offscreen
 * write proxy and the inline switch produce byte-identical `options`, and the
 * flag-off path stays a no-op vs. production (issue #260, slice 5, design §7.1).
 */
export function buildSignCallbackOptions(
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>
): MidenClientCreateOptions {
  return {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      try {
        return await signCallback(keyString, signingInputsString);
      } catch (err) {
        // The SDK (WebKeyStore) captures the raw thrown value and exposes
        // it via `midenClient.lastAuthError()`. Attach a stable `reason`
        // tag so callers that catch the eventual executeTransaction
        // failure can distinguish "wallet got locked mid-sign" from other
        // failure modes (user rejection, keystore IO error, etc.).
        throw buildSignCallbackError(err);
      }
    }
  };
}

// --- SW-side last-sign-reason slot (issue #260, slice 5, design §2.6) --------
//
// Under the flag-on offscreen write, a sign failure is captured on the OFFSCREEN
// client's `lastAuthError()` — the SW-inline client's `lastAuthError()` returns
// `undefined`, so `readLastAuthReason` (which reads the SW client) would miss a
// locked-mid-sign and mark the consume Failed instead of deferring it,
// re-opening issue #313 (note-loss). Because the sign ACTUALLY runs on the SW
// (the reverse-IPC handler drives the vault signer), the SW is the authoritative
// place to record the reason. The handler records it here; `readLastAuthReason`
// take-and-clears it (so a stale reason can never bleed into a later op) BEFORE
// falling back to the SW client's `lastAuthError()` for the still-inline write
// methods (send/swap/newTransaction under flag-on).
//
// Flag-OFF safety: nothing ever records into this slot when the offscreen write
// is disabled, so `readLastAuthReason` take-and-clears `undefined` and falls
// straight through to the exact SW-client read it does today — byte-identical.

let _lastSignReason: SignCallbackReason | undefined;

/** Record the classified reason of a failed reverse-IPC sign (SW-side). */
export function recordLastSignReason(reason: SignCallbackReason): void {
  _lastSignReason = reason;
}

/** Take-and-clear the last recorded sign reason (or `undefined` if none). */
export function takeLastSignReason(): SignCallbackReason | undefined {
  const reason = _lastSignReason;
  _lastSignReason = undefined;
  return reason;
}

/** Clear the slot (called at the START of each offscreen write dispatch so a
 * prior op's reason can never be misread by this op's failure handling). */
export function clearLastSignReason(): void {
  _lastSignReason = undefined;
}
