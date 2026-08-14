export const DEFAULT_ERROR_MESSAGE = 'Unexpected error occured';

export function serializeError(err: any) {
  const message = err?.message || DEFAULT_ERROR_MESSAGE;
  return Array.isArray(err?.errors) && err.errors.length > 0 ? [message, err.errors] : message;
}

export function deserializeError(data: any) {
  return Array.isArray(data) ? new IntercomError(data[0], data[1]) : new IntercomError(data);
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
