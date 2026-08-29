export const DEFAULT_ERROR_MESSAGE = 'Unexpected error occured';

export function serializeError(err: any) {
  const message = err?.message || DEFAULT_ERROR_MESSAGE;
  return Array.isArray(err?.errors) && err.errors.length > 0 ? [message, err.errors] : message;
}

export function deserializeError(data: any) {
  return Array.isArray(data) ? new IntercomError(data[0], data[1]) : new IntercomError(data);
}

/**
 * The same thing for the WALLET-INTERNAL port, which — unlike `serializeError` —
 * may change shape freely.
 *
 * `serializeError` keeps only `message`, so every rejection arrives at the
 * frontend as an `IntercomError` and every classifier that tests the CLASS of a
 * backend failure is dead code on the extension. That is not a cosmetic loss:
 * `isWasmClientPoisonedError` is how a caller learns the WASM client was evicted
 * under a backend action, and an eviction that reads as an ordinary failure lets
 * the pass take another hold — a second borrow of a client somebody else is
 * inside — and lets a fuse SUCCESS be booked for a pass that actually evicted.
 * On mobile and desktop the same call is in-process and keeps its class, so the
 * bug existed only on the platform that carries most users.
 *
 * Deliberately NOT folded into `serializeError`: that one also feeds the dApp
 * content script, whose payload crosses into page context where third-party code
 * reads it as a string. This pair is only ever `IntercomServer` -> `IntercomClient`.
 *
 * `reason` rides along with `name` because the two answer different questions and
 * only one of them survives a class rebuild. `isWasmClientPoisonedError` reads the
 * name and decides whether to stop taking holds; `isSyncWatchdogEviction` reads the
 * REASON and decides whether the node is parked — and a `realm-error` eviction
 * deliberately fails that second test, because its client is replaced in
 * milliseconds. Carrying only the name made the reason-reading predicate
 * unconditionally false for anything that crossed this port, so the sync fuse could
 * not be fed from a backend action at all. Same shape as the offscreen wire's
 * `errorReason`, which solved this one hop earlier.
 *
 * An ARRAY rather than an object, and that is the compatibility direction that
 * actually occurs: a service worker updated under an open port is a NEW server
 * talking to an OLD client, and the old `deserializeError` hands an object straight
 * to `Error` — "[object Object]", with the reason lost. It destructures an array
 * correctly, so an old client degrades to exactly the message and errors it
 * understood before.
 */
const INTERNAL_ERROR_ENVELOPE_LENGTH = 4;

export function serializeInternalError(err: any) {
  return [err?.message || DEFAULT_ERROR_MESSAGE, err?.errors, err?.name, err?.reason];
}

const rebuildInternalError = (message: unknown, errors: unknown, name: unknown, reason: unknown): IntercomError => {
  const error = new IntercomError(
    typeof message === 'string' ? message : DEFAULT_ERROR_MESSAGE,
    Array.isArray(errors) ? errors : undefined
  );
  // The whole point of the pair: nothing between the two realms rebuilds the
  // class, so the classifiers read these two fields off the rebuilt error.
  if (typeof name === 'string' && name.length > 0) error.name = name;
  if (typeof reason === 'string' && reason.length > 0) error.reason = reason;
  return error;
};

export function deserializeInternalError(data: any): IntercomError {
  // Tolerates the legacy shapes in the other direction too — a client updated
  // ahead of its server would otherwise turn every backend error into
  // "Unexpected error occured". A legacy array is `[message, errors]`, which is
  // shorter than this envelope.
  if (Array.isArray(data) && data.length === INTERNAL_ERROR_ENVELOPE_LENGTH) {
    const [message, errors, name, reason] = data;
    return rebuildInternalError(message, errors, name, reason);
  }
  // The OBJECT envelope this pair itself shipped with before the array. Every
  // OTHER legacy shape reaching `deserializeError` degrades gracefully — a
  // string and a `[message, errors]` array are both exactly what that function
  // was written for — but an object hits its `new IntercomError(data)` branch,
  // where `Error` coerces it to the literal "[object Object]" and `name` and
  // `reason`, the only two fields the poison and eviction classifiers read, are
  // dropped. So the one shape a bare fallback cannot carry is the one this
  // module used to emit, and the direction is the same one the array was chosen
  // for: a client updated ahead of the service worker still holding the port.
  //
  // Arrays are excluded rather than merely falling through the check above: a legacy
  // `[message, errors]` array is an object to `typeof`, and reading `.message` off it
  // yields `undefined`, which would turn the one legacy shape `deserializeError`
  // handles perfectly into the default message.
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return rebuildInternalError(data.message, data.errors, data.name, data.reason);
  }
  return deserializeError(data);
}

/**
 * A backend rejection carried back to the frontend caller over the intercom port.
 *
 * MUST `extend` Error, not merely `implement` it. `implements` is a compile-time
 * contract that TypeScript erases, so instances used to be plain objects with no
 * Error in their prototype chain — and every consumer of a rejected request is
 * written as `e instanceof Error ? e.message : String(e)`. That test was false,
 * so those consumers fell through to `String(e)` and rendered the literal
 * "[object Object]" instead of the reason. The worst instance was
 * `ForgotPassword.tsx`, which surfaces exactly this string to a user whose wallet
 * has just been irreversibly wiped by a recovery that then failed (#630); ~25
 * other call sites share the same ternary.
 */
export class IntercomError extends Error {
  /**
   * The eviction mechanism, when this error is a rebuilt `WasmClientPoisonedError`.
   * Read through `poisonReasonOf`, which narrows it; declared here so
   * `deserializeInternalError` can restore it without a cast.
   */
  reason?: string;

  constructor(
    message: string,
    public errors?: any[]
  ) {
    super(message);
    this.name = 'IntercomError';
  }
}
