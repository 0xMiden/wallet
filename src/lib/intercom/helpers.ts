import type { SerializedSpendingLimitAssessment } from 'lib/miden/spending-limits/types';

/**
 * This file is bundled into the extension CONTENT SCRIPT (`src/contentScript.ts` imports it
 * both directly and via `./client`), which runs on every page the user visits. A `lib/miden`
 * or `@miden-sdk` RUNTIME import here drags the WASM SDK into that bundle - see the content
 * script's own vite config for why that's catastrophic: it breaks `window.midenWallet`
 * injection everywhere, for every dApp, silently. `import type` is erased at build and is
 * fine; a value import is not. `helpers.test.ts` pins this with a source-level guard.
 */

export const DEFAULT_ERROR_MESSAGE = 'Unexpected error occured';

/** The two spending-limit refusals that need more than `code` to act on, JSON-safe for the wire. */
type SpendingLimitWirePayload = { assessment: SerializedSpendingLimitAssessment } | { symbol: string };

/** What `serializeErrorForPage` posts to a dApp: the message, and the `errors` array when there is one. */
export type SerializedError = string | [string, any[]];

/**
 * Turn every `bigint` in an assessment into its canonical decimal string, dependency-free (no
 * `lib/miden` import - see the file-level comment). This intentionally does NOT validate the
 * shape the way `toSerializedSpendingLimitAssessment` does: the receiver,
 * `parseSerializedSpendingLimitAssessment`, already validates every field and fails closed, so
 * nothing about safety depends on the sender re-validating here.
 */
function serializeBigints(value: unknown): any {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * A JSON-safe carrier for a breach assessment (bigints as canonical decimal strings, via
 * `serializeBigints`) or an unpriceable asset's symbol. Anything else - a malformed
 * `assessment` field on an unrelated error, say - is silently dropped rather than thrown: a
 * transport helper must never fail to report the error it was building.
 */
function serializeSpendingLimitPayload(err: any): SpendingLimitWirePayload | undefined {
  if (err?.assessment !== undefined) {
    try {
      return { assessment: serializeBigints(err.assessment) };
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
 * Serialize an error for posting to an untrusted page (a dApp). This function ONLY includes the
 * message and errors array - never code, assessment, symbol, or any other fields, even if the
 * error carries them. It is the guard at the page boundary: spending-limit assessments and asset
 * symbols must never reach an untrusted site.
 *
 * For the wallet-internal intercom (IntercomServer -> IntercomClient), use serializeInternalError.
 */
export function serializeErrorForPage(err: any): SerializedError {
  const message = err?.message || DEFAULT_ERROR_MESSAGE;
  const errors = Array.isArray(err?.errors) && err.errors.length > 0 ? err.errors : undefined;
  return errors !== undefined ? [message, errors] : message;
}

function restoreDomainFields(error: IntercomError, code: unknown, spendingLimit: unknown): void {
  if (typeof code === 'string') error.code = code;
  if (typeof spendingLimit === 'object' && spendingLimit !== null) {
    const payload = spendingLimit as { assessment?: SerializedSpendingLimitAssessment; symbol?: unknown };
    if (payload.assessment !== undefined) error.assessment = payload.assessment;
    else if (typeof payload.symbol === 'string') error.symbol = payload.symbol;
  }
}

/**
 * The reader for the wire shapes a released build's `IntercomServer` sends: a bare string,
 * `[message, errors]`, and the `{ message, errors?, code?, spendingLimit? }` object 1.16.2 sends
 * for a spending-limit refusal. This tree no longer writes any of them - `deserializeInternalError`
 * falls back here for a server older than this one.
 */
export function deserializeError(data: any): IntercomError {
  if (Array.isArray(data)) return new IntercomError(data[0], data[1]);
  if (typeof data === 'object' && data !== null && typeof data.message === 'string') {
    const error = new IntercomError(data.message, data.errors);
    restoreDomainFields(error, data.code, data.spendingLimit);
    return error;
  }
  return new IntercomError(data);
}

/**
 * The serializer for the WALLET-INTERNAL port (`IntercomServer` -> `IntercomClient`),
 * which may change shape freely.
 *
 * The released shapes `deserializeError` reads carry no `name` or `reason`, so every rejection arrives at the
 * frontend as an `IntercomError` and every classifier that tests the CLASS of a
 * backend failure is dead code on the extension. That is not a cosmetic loss:
 * `isWasmClientPoisonedError` is how a caller learns the WASM client was evicted
 * under a backend action, and an eviction that reads as an ordinary failure lets
 * the pass take another hold - a second borrow of a client somebody else is
 * inside - and lets a fuse SUCCESS be booked for a pass that actually evicted.
 * On mobile and desktop the same call is in-process and keeps its class, so the
 * bug existed only on the platform that carries most users.
 *
 * Never used at the dApp content script, whose payload crosses into page context
 * where third-party code reads it: that boundary is `serializeErrorForPage`.
 *
 * `reason` rides along with `name` because the two answer different questions and
 * only one of them survives a class rebuild. `isWasmClientPoisonedError` reads the
 * name and decides whether to stop taking holds; `isSyncWatchdogEviction` reads the
 * REASON and decides whether the node is parked - and a `realm-error` eviction
 * deliberately fails that second test, because its client is replaced in
 * milliseconds. Carrying only the name made the reason-reading predicate
 * unconditionally false for anything that crossed this port, so the sync fuse could
 * not be fed from a backend action at all. Same shape as the offscreen wire's
 * `errorReason`, which solved this one hop earlier.
 *
 * An ARRAY rather than an object, and that is the compatibility direction that
 * actually occurs: a service worker updated under an open port is a NEW server
 * talking to an OLD client. A 1.16.1 client's decoder hands an object straight to
 * `Error` - "[object Object]", with the reason lost - but destructures an array, so
 * it keeps the message and errors. A 1.16.2 client also reads the array as
 * `[message, errors]`: it keeps the message but loses `code` and the spending-limit
 * payload its own object shape carried, so until the page reloads a refusal shows
 * as its message instead of the authorization prompt or the explanation.
 *
 * The fifth slot carries `code` and the spending-limit assessment or symbol payload,
 * because this is the port those refusals cross. Only these two are carried: this
 * must not grow into copying arbitrary error properties, which would ship whatever an
 * unrelated error happens to hold.
 */
const INTERNAL_ERROR_ENVELOPE_MIN_LENGTH = 4;

export function serializeInternalError(err: any) {
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const spendingLimit = serializeSpendingLimitPayload(err);
  const domain =
    code === undefined && spendingLimit === undefined
      ? undefined
      : { ...(code !== undefined && { code }), ...(spendingLimit !== undefined && { spendingLimit }) };
  return [err?.message || DEFAULT_ERROR_MESSAGE, err?.errors, err?.name, err?.reason, domain];
}

const rebuildInternalError = (
  message: unknown,
  errors: unknown,
  name: unknown,
  reason: unknown,
  domain: unknown
): IntercomError => {
  const error = new IntercomError(
    typeof message === 'string' ? message : DEFAULT_ERROR_MESSAGE,
    Array.isArray(errors) ? errors : undefined
  );
  // The whole point of the pair: nothing between the two realms rebuilds the
  // class, so the classifiers read these two fields off the rebuilt error.
  if (typeof name === 'string' && name.length > 0) error.name = name;
  if (typeof reason === 'string' && reason.length > 0) error.reason = reason;
  if (typeof domain === 'object' && domain !== null) {
    const { code, spendingLimit } = domain as { code?: unknown; spendingLimit?: unknown };
    restoreDomainFields(error, code, spendingLimit);
  }
  return error;
};

export function deserializeInternalError(data: any): IntercomError {
  // Tolerates the legacy shapes in the other direction too - a client updated
  // ahead of its server would otherwise turn every backend error into
  // "Unexpected error occured". A legacy array is `[message, errors]`, which is
  // shorter than this envelope.
  if (Array.isArray(data) && data.length >= INTERNAL_ERROR_ENVELOPE_MIN_LENGTH) {
    const [message, errors, name, reason, domain] = data;
    return rebuildInternalError(message, errors, name, reason, domain);
  }
  // Everything else is a shape a released build's server sends: `deserializeError`.
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
