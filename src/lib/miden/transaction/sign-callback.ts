// Sign-callback classification (issue #260, slice 5).
//
// This is a LEAF module: it depends only on `Buffer`. It exists to break an
// import cycle that Slice 5
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

/**
 * Stable tags attached to errors the sign callback throws. Only the message
 * crosses the SDK boundary, so the tag reaches the transaction loop two ways:
 * the offscreen path records it per op and `dispatchOffscreenWrite` re-tags the
 * op's rejection; the inline path records it per WASM lock hold and
 * `withWasmClientLock` tags the hold's rejection. `isLockedError` then defers a
 * `locked` failure until the wallet unlocks instead of marking the tx Failed.
 */
export type SignCallbackReason = 'locked' | 'rejected' | 'not_found' | 'internal';

export interface SignCallbackError extends Error {
  reason: SignCallbackReason;
}

/**
 * Wrap an underlying sign failure in a typed Error. Classifies by inspecting
 * the underlying error's shape; the current signals are the store's locked state
 * (`Wallet is locked` from `assertUnlocked`, "Not initialized" from
 * `assertInited`) and a generic TypeError for null-vault access. The reason is
 * also written into the message, since that is all the SDK forwards.
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
 * Wrap a raw `(publicKeyHex, signingInputsHex)` signer into the byte-shaped SDK
 * keystore callback, tagging any thrown value via {@link buildSignCallbackError}.
 * `Actions.init` installs it once per realm as the realm signer
 * (`installRealmKeystore`, #878); the offscreen document wraps its reverse-IPC
 * signer the same way, so both paths classify a failure identically.
 */
export function buildSdkSignCallback(
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>
): (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array> {
  return async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
    const keyString = Buffer.from(publicKey).toString('hex');
    const signingInputsString = Buffer.from(signingInputs).toString('hex');
    try {
      return await signCallback(keyString, signingInputsString);
    } catch (err) {
      // Classified here, on the wallet's side of the boundary: the client's sign
      // trampoline records the reason for the hold that asked, and the message
      // carries it too. Callers that catch the eventual executeTransaction failure
      // can then tell "wallet got locked mid-sign" from a user rejection or a
      // keystore IO error.
      throw buildSignCallbackError(err);
    }
  };
}

/**
 * Carry a locked sign onto the operation's own error, so `isLockedError` in the
 * transaction loop DEFERS the write instead of failing it (issue #313). Only
 * 'locked' matters there; any other reason leaves a genuine failure to Fail. The
 * offscreen path calls this from its op-keyed record, `withWasmClientLock` from
 * the record keyed by the hold (sdk/miden-client.ts).
 */
export function tagLockedSignReason(err: unknown, reason: SignCallbackReason | undefined): void {
  if (reason === 'locked' && err && typeof err === 'object' && (err as { reason?: unknown }).reason === undefined) {
    (err as { reason?: SignCallbackReason }).reason = reason;
  }
}

// NOTE (issue #260 flip-prep #1): there is NO global "last sign reason" slot. A
// flag-on offscreen write's locked-mid-sign signal is carried entirely by the
// OP-KEYED error tag — `dispatchOffscreenWrite` (back/miden-client-proxy.ts)
// re-tags the thrown error with `.reason='locked'` for the exact failing op, and
// `isLockedError(e)` (helper.ts) reads that tag. A single un-keyed global slot
// (the old `_lastSignReason`) could bleed one concurrent op's reason into
// another (the IPC layer permits >1 in-flight op), so it was removed in favour of
// the op-keyed tag, which is inherently isolated per op. The INLINE path keys the
// same record by the WASM lock hold the sign ran under, and `withWasmClientLock`
// itself tags the hold's rejection (#878).
