import {
  toSerializedSpendingLimitAssessment,
  type SerializedSpendingLimitAssessment
} from 'lib/miden/spending-limits/types';

export const DEFAULT_ERROR_MESSAGE = 'Unexpected error occured';

/** The two spending-limit refusals that need more than `code` to act on, JSON-safe for the wire. */
type SpendingLimitWirePayload = { assessment: SerializedSpendingLimitAssessment } | { symbol: string };

interface SerializedIntercomErrorPayload {
  message: string;
  errors?: any[];
  code?: string;
  spendingLimit?: SpendingLimitWirePayload;
}

export type SerializedError = string | [string, any[]] | SerializedIntercomErrorPayload;

/**
 * A JSON-safe carrier for a breach assessment (bigints as canonical decimal strings, via
 * `toSerializedSpendingLimitAssessment`) or an unpriceable asset's symbol. Anything else - a
 * malformed `assessment` field on an unrelated error, say - is silently dropped rather than
 * thrown: a transport helper must never fail to report the error it was building.
 */
function serializeSpendingLimitPayload(err: any): SpendingLimitWirePayload | undefined {
  if (err?.assessment !== undefined) {
    try {
      return { assessment: toSerializedSpendingLimitAssessment(err.assessment) };
    } catch {
      return undefined;
    }
  }
  if (typeof err?.symbol === 'string' && err.symbol.trim().length > 0) {
    return { symbol: err.symbol };
  }
  return undefined;
}

/**
 * Every error crossing the intercom port (extension SW <-> popup/content-script) goes through
 * this. Historically it kept only `message` (plus an `errors` array), which silently dropped
 * `code` and any domain payload for every rejection - including the spending-limit refusals below,
 * whose `code` and assessment/symbol are how the frontend tells a breach from an unpriceable asset
 * (see `isSpendingLimitPriceUnavailable` and `spendingLimitAssessmentFromError` in
 * `lib/miden/spending-limits/types.ts`). Mobile/desktop never call this - their in-process handler
 * rethrows the original error object with its fields intact - so the gap only ever showed up on
 * the extension.
 *
 * Only `code` and the spending-limit payload are carried across. This must not grow into copying
 * arbitrary error properties: that would ship whatever an unrelated error happens to hold.
 *
 * The old two wire shapes (a bare string, and `[message, errors]`) still decode exactly as before -
 * the object shape below is additive, taken only when there is a `code` or a payload to carry.
 *
 * IMPORTANT: This function is for the wallet-internal intercom only. DO NOT use it at the
 * untrusted-page boundary (contentScript.ts sending to a dApp). Use serializeErrorForPage instead.
 */
export function serializeError(err: any): SerializedError {
  const message = err?.message || DEFAULT_ERROR_MESSAGE;
  const errors = Array.isArray(err?.errors) && err.errors.length > 0 ? err.errors : undefined;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const spendingLimit = serializeSpendingLimitPayload(err);

  if (code === undefined && spendingLimit === undefined) {
    return errors !== undefined ? [message, errors] : message;
  }

  return {
    message,
    ...(errors !== undefined && { errors }),
    ...(code !== undefined && { code }),
    ...(spendingLimit !== undefined && { spendingLimit })
  };
}

/**
 * Serialize an error for posting to an untrusted page (a dApp), intentionally narrower than
 * serializeError. This function ONLY includes the message and errors array - never code,
 * assessment, symbol, or any other fields, even if the error carries them.
 *
 * This is the guard at the page boundary: before this change, a page could only receive
 * a message. If serializeError is used here instead, spending-limit assessments and asset
 * symbols would leak to an untrusted site. This narrower function restores that guarantee.
 *
 * For the wallet-internal intercom (SW <-> popup/content-script), use serializeError instead.
 */
export function serializeErrorForPage(err: any): SerializedError {
  const message = err?.message || DEFAULT_ERROR_MESSAGE;
  const errors = Array.isArray(err?.errors) && err.errors.length > 0 ? err.errors : undefined;
  return errors !== undefined ? [message, errors] : message;
}

export function deserializeError(data: any): IntercomError {
  if (Array.isArray(data)) return new IntercomError(data[0], data[1]);
  if (typeof data === 'object' && data !== null && typeof data.message === 'string') {
    const error = new IntercomError(data.message, data.errors);
    if (typeof data.code === 'string') error.code = data.code;
    const spendingLimit = data.spendingLimit;
    if (typeof spendingLimit === 'object' && spendingLimit !== null) {
      if (spendingLimit.assessment !== undefined) error.assessment = spendingLimit.assessment;
      else if (typeof spendingLimit.symbol === 'string') error.symbol = spendingLimit.symbol;
    }
    return error;
  }
  return new IntercomError(data);
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
  code?: string;
  /** Present only for a restored `SPENDING_LIMIT_AUTHORIZATION_REQUIRED` refusal. */
  assessment?: SerializedSpendingLimitAssessment;
  /** Present only for a restored `SPENDING_LIMIT_PRICE_UNAVAILABLE` refusal. */
  symbol?: string;

  constructor(
    message: string,
    public errors?: any[]
  ) {
    super(message);
    this.name = 'IntercomError';
  }
}
