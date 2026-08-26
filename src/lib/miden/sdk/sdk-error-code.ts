// Shared SDK-error classification (issue #260).
//
// This lives in its own zero-dependency leaf module so BOTH realms can read the
// SAME classification without duplicating the shape (issue #260 offscreen rehost):
//   - the SW-side tx classifier (`transaction/index.ts`) reads it off a thrown
//     write error to decide Completed-vs-Failed;
//   - the offscreen worker (`offscreen/main.ts`) reads it off the raw WASM error it
//     catches — its client runs `useWorker:false`, so the error is the raw
//     main-thread `JsError` — and ships it across the bus so the SW re-attaches it
//     to the rejection.
// Reusing one definition guarantees the flag-ON offscreen round-trip classifies a
// failed write IDENTICALLY to the flag-OFF inline path (the funds-critical
// invariant: an apply-after-submit failure must mark Completed, never Failed →
// requeue → double-spend).
//
// The one import is `wasm-client-poison`, itself a zero-dependency leaf, so this
// module stays realm- and cycle-safe.

import { isWasmClientPoisonedError } from './wasm-client-poison';

/**
 * Pulls a stable SDK error code off a thrown value, if present.
 *
 * Two property names are accepted. web-sdk sets **`code`** — `js_error_with_context`
 * does `Reflect::set(&js_error, "code", …)` and the worker shim mirrors it as
 * `code: error.code`. `errorCode` is the name this wallet's own offscreen bus uses
 * when it re-attaches a forwarded code onto the rejection (`miden-client-proxy.ts`),
 * so both are read here. Returns `undefined` for non-objects or when neither is a
 * string.
 *
 * Note that the set of codes web-sdk 0.16 actually maps is small (`code_from_error`
 * covers account-tracking cases only) — do NOT assume an arbitrary Rust variant name
 * arrives here. For apply-after-submit specifically, use
 * {@link isApplyAfterSubmitError}, which also matches the SDK's error text.
 */
export function extractSdkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const raw = err as { errorCode?: unknown; code?: unknown };
  if (typeof raw.errorCode === 'string') return raw.errorCode;
  if (typeof raw.code === 'string') return raw.code;
  return undefined;
}

/** How many `cause` links to follow when flattening an error chain. */
const MAX_CAUSE_DEPTH = 5;

/**
 * An error's own message plus each message down its `cause` chain, one entry per
 * link and in order, so a text match still fires when the SDK error has been
 * wrapped (the offscreen bus re-wraps it as `Offscreen call 'X' failed:
 * <message>`, and callers may attach a cause).
 *
 * Kept as separate entries rather than joined into one blob because it matters,
 * for some classifiers, WHICH link a phrase came from: a classifier requiring
 * two phrases can be satisfied by two unrelated errors once they are joined,
 * assembling a match that describes no single failure. A single-phrase
 * classifier can use `.some()` over these just as safely, so nothing needs the
 * joined form.
 */
export function errorMessageParts(err: unknown): string[] {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const node = current as { message?: unknown; cause?: unknown };
    // Property reads are guarded: `message`/`cause` can be accessors, and a
    // classifier that throws while classifying an error turns a handled failure
    // into an unhandled one at the worst possible moment.
    let message: unknown;
    try {
      message = node.message;
    } catch {
      message = undefined;
    }
    if (typeof message === 'string') parts.push(message);
    // Read separately from `message`: sharing one guard would let a throwing
    // `cause` discard the message this node already yielded, so an error that
    // classifies perfectly well on its own text would stop being recognised
    // because of a property nothing has looked at yet.
    let cause: unknown;
    try {
      cause = node.cause;
    } catch {
      break;
    }
    current = cause;
  }
  return parts;
}

/**
 * True when the SDK reports "the node accepted this transaction but the LOCAL
 * store update failed" (miden-client's `ApplyTransactionAfterSubmitFailed`).
 *
 * This is funds-critical: the transaction IS on chain, so the row must be marked
 * Completed (or, for types whose caller awaits a `TransactionResult`, Failed) —
 * never left to be blindly re-queued into a second submit.
 *
 * Classification is by ERROR TEXT, not by a property name. web-sdk 0.16.0-rc.4
 * does not attach any code for this variant: `code_from_error` maps only the
 * account-tracking cases, and the literal string `ApplyTransactionAfterSubmitFailed`
 * exists in the SDK only as a Rust variant name inside the .wasm — it never reaches
 * JS. What DOES reach JS is the variant's `Display` text, which is present verbatim
 * in the shipped wasm:
 *
 *   "Transaction <id> was accepted into the node's mempool at block <n> but the
 *    local store update failed. …"
 *
 * The code check is kept first so a future SDK that starts mapping the variant
 * (under either property name) keeps working without a wallet change.
 */
export function isApplyAfterSubmitError(err: unknown): boolean {
  // A lock-recovery eviction is never an apply-after-submit report, but its
  // `cause` carries the raw realm error VERBATIM — and this classifier walks
  // the cause chain. Without the type check a trap whose text happened to
  // embed the SDK's mempool phrasing would mark a row Completed that never
  // submitted (issue #775). Checked first, mirroring isLockedError.
  if (isWasmClientPoisonedError(err)) return false;
  if (extractSdkErrorCode(err) === 'ApplyTransactionAfterSubmitFailed') return true;
  // Both phrases must come from the SAME error in the chain, not from the
  // flattened join. On the flattened form the `[\s\S]*` spans the separator, so
  // a wrapper contributing "accepted into the node's mempool" and an unrelated
  // inner error contributing "local store update failed" assemble a match out of
  // two errors that never described one event — and this classifier's verdict is
  // that the write DID reach the chain, which marks the row Completed. A
  // never-submitted write reported as success is the worse direction of the two.
  return errorMessageParts(err).some(part =>
    /accepted into the node's mempool[\s\S]*local store update failed/i.test(part)
  );
}
