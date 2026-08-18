// Shared SDK-error-code extractor (issue #260).
//
// The SDK attaches a stable `errorCode` string to thrown errors for the variants
// callers are expected to dispatch on (e.g. `ApplyTransactionAfterSubmitFailed`,
// `InputNoteAlreadyConsumedOnChain`). It is set from Rust via `Reflect::set` on
// the thrown `JsError` — see `js_error_with_context` / `error_code_from_client_error`
// in miden-client — so it rides the raw error as a plain string property, NOT part
// of the message.
//
// This lives in its own zero-dependency leaf module so BOTH realms can read the
// SAME extraction without duplicating the shape (issue #260 offscreen rehost):
//   - the SW-side tx classifier (`transaction/index.ts`) reads it off a thrown
//     write error to decide Completed-vs-Failed;
//   - the offscreen worker (`offscreen/main.ts`) reads it off the raw WASM error it
//     catches — its client runs `useWorker:false`, so the error is the raw
//     main-thread `JsError` still carrying `errorCode` (not a worker-postMessage
//     copy that structured-clone would have stripped the property from) — and ships
//     it across the bus so the SW re-attaches it to the rejection.
// Reusing one definition guarantees the flag-ON offscreen round-trip classifies a
// failed write IDENTICALLY to the flag-OFF inline path (the funds-critical
// invariant: an apply-after-submit failure must mark Completed, never Failed →
// requeue → double-spend).

/**
 * Pulls the stable SDK error code off a thrown value, if present. Returns
 * `undefined` for non-objects or when no string `errorCode` is set.
 */
export function extractSdkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : undefined;
}
