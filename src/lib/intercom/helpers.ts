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
 */
export function serializeInternalError(err: any) {
  return { message: err?.message || DEFAULT_ERROR_MESSAGE, name: err?.name, errors: err?.errors };
}

export function deserializeInternalError(data: any): IntercomError {
  // Tolerates the legacy string/array shapes: a service worker updated while a
  // page kept its port open would otherwise turn every backend error into
  // "Unexpected error occured".
  if (typeof data === 'string' || Array.isArray(data)) return deserializeError(data);
  const error = new IntercomError(data?.message ?? DEFAULT_ERROR_MESSAGE, data?.errors);
  // The whole point of the pair. `name` is what the poison classifier reads, and
  // it survives here because nothing between the two realms rebuilds the class.
  if (typeof data?.name === 'string' && data.name.length > 0) error.name = data.name;
  return error;
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
  constructor(
    message: string,
    public errors?: any[]
  ) {
    super(message);
    this.name = 'IntercomError';
  }
}
