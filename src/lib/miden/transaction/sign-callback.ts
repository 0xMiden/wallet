// Sign-callback classification (issue #260, slice 5).
//
// This is a LEAF module: it depends only on `Buffer` and a type-only import of
// `MidenClientCreateOptions`. It exists to break an import cycle that Slice 5
// would otherwise introduce. The reverse-IPC sign handler (SW-side, in
// `back/miden-client-proxy.ts`) must classify a failed sign the SAME way the
// inline path always has (`buildSignCallbackError`). If the classifier lived in
// `helper.ts` and the proxy imported `helper` while `helper` imported the proxy,
// `helper ↔ proxy` would cycle. Hosting the classifier in this leaf lets both the
// proxy and `helper` import it with no cycle.
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

// NOTE (issue #260 flip-prep #1): there is NO global "last sign reason" slot. A
// flag-on offscreen write's locked-mid-sign signal is carried entirely by the
// OP-KEYED error tag — `dispatchOffscreenWrite` (back/miden-client-proxy.ts)
// re-tags the thrown error with `.reason='locked'` for the exact failing op, and
// `isLockedError(e)` (helper.ts) reads that tag. A single un-keyed global slot
// (the old `_lastSignReason`) could bleed one concurrent op's reason into
// another (the IPC layer permits >1 in-flight op), so it was removed in favour of
// the op-keyed tag, which is inherently isolated per op.
