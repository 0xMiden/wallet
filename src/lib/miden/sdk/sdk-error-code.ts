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
 * Flattens an error's own message plus its `cause` chain into one string, so a
 * text match still fires when the SDK error has been wrapped (the offscreen bus
 * re-wraps it as `Offscreen call 'X' failed: <message>`, and callers may attach
 * a cause).
 */
function errorMessageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const node = current as { message?: unknown; cause?: unknown };
    if (typeof node.message === 'string') parts.push(node.message);
    current = node.cause;
  }
  return parts.join(' | ');
}

/**
 * True when the SDK reports "the node accepted this transaction but the LOCAL
 * store update failed" (miden-client's `ApplyTransactionAfterSubmitFailed`).
 *
 * This is funds-critical: the transaction IS on chain, so the row must be marked
 * Completed (or, for types whose caller awaits a `TransactionResult`, Failed) —
 * never left to be blindly re-queued into a second submit.
 *
 * Classification is by ERROR TEXT, not by a property name. web-sdk 0.16.0-rc.2
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
  if (extractSdkErrorCode(err) === 'ApplyTransactionAfterSubmitFailed') return true;
  return /accepted into the node's mempool[\s\S]*local store update failed/i.test(errorMessageChain(err));
}
