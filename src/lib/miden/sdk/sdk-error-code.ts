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
 * Detect the eventually-consistent guardian canonicalization refusal. The pinned
 * multisig client (0.17.0) throws it from `syncState` in two forms:
 *
 *   "Refusing to overwrite local state: incoming nonce N equals local nonce N but
 *    commitments differ for account X"
 *   "Refusing to overwrite local state: incoming commitment does not match
 *    on-chain commitment for account X"
 *
 * The second pattern below, "is not greater than local nonce", is the wording older
 * clients used; 0.17.0 returns false for a lower nonce instead of throwing.
 *
 * The client raises this when asked to import a guardian's view it will not take
 * over the local one: the local nonce with another commitment, or a commitment
 * that does not match the chain (a guardian behind local is kept quietly). It
 * says something specific: the guardian's state diverges from the local one or
 * from the chain. It does NOT say the read failed.
 *
 * It is never a landed shape: every post-submit failure reaches the transaction
 * loop as `ApplyAfterSubmitError`, so this refusal there was raised before submit
 * (#1233). The callers that read it treat it as an answer about the guardian's
 * view. The pre-rotation sync builds on local state. The guardian self-heal treats
 * it as permission to proceed: a device that had been rotated out would be looking
 * at a guardian holding the NEWER state, so a guardian that is behind is the stale
 * registration the re-register repairs. They need the same test, so it lives in
 * this leaf rather than in any of them.
 */
export function isGuardianCanonicalizationError(error: unknown): boolean {
  // Same ordering rationale as the two classifiers below: an eviction's `message`
  // is a closed wallet set but its `cause` carries the raw realm error verbatim,
  // and this walks the chain. A trap whose cause happened to be an SDK
  // canonicalization refusal (the guardian sync that raises it runs
  // fire-and-forget on a 3s tick, and an uncaught realm rejection is precisely
  // what the recovery listener evicts on) would read an abandoned hold as the
  // guardian's answer, and the self-heal would re-register on it. Poison is never
  // a statement about the guardian's view of the account.
  if (isWasmClientPoisonedError(error)) return false;
  return errorMessageParts(error).some(
    part => /Refusing to overwrite local state/i.test(part) || /is not greater than local nonce/i.test(part)
  );
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

/**
 * A local store update that failed after the wallet's own `submitProven` resolved,
 * which is the moment the node accepted the transaction (#945).
 *
 * A staged `submitProven` then `apply()` rejects with the raw store error, which
 * says nothing about the submit. This carries both signals `isApplyAfterSubmitError`
 * reads - the code, which the offscreen reply forwards as `errorCode`, and the
 * mempool text - so the write classifies as submitted and is never requeued into a
 * second submit.
 */
export class ApplyAfterSubmitError extends Error {
  readonly code = 'ApplyTransactionAfterSubmitFailed';
  /** The executed transaction's id, when it could be read: a landed row's only record of it (#1233). */
  readonly transactionId: string | undefined;
  /** How many private user output notes it produced, when that could be read: notes no relay handed over (#1233). */
  readonly privateOutputNotes: number | undefined;

  constructor(cause: unknown, transactionId?: string, privateOutputNotes?: number) {
    super("This transaction was accepted into the node's mempool but the local store update failed", { cause });
    this.name = 'ApplyAfterSubmitError';
    this.transactionId = transactionId;
    this.privateOutputNotes = privateOutputNotes;
  }
}

/**
 * Read one landed field off this realm's `ApplyAfterSubmitError` or off the rejection the service
 * worker rebuilds from an offscreen reply (#1233). Guarded like `errorMessageParts`: the property can
 * be an accessor, and a throw here would cost the verdict.
 */
const readLandedField = (err: unknown, field: 'transactionId' | 'privateOutputNotes'): unknown => {
  if (!err || typeof err !== 'object') return undefined;
  try {
    return Reflect.get(err, field);
  } catch {
    return undefined;
  }
};

/** The landed transaction's id an `ApplyAfterSubmitError` carries, or `undefined`. */
export function extractLandedTransactionId(err: unknown): string | undefined {
  const id = readLandedField(err, 'transactionId');
  return typeof id === 'string' ? id : undefined;
}

/** The private output note count an `ApplyAfterSubmitError` carries, or `undefined` for anything but a count. */
export function extractLandedPrivateOutputNotes(err: unknown): number | undefined {
  const count = readLandedField(err, 'privateOutputNotes');
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : undefined;
}

/**
 * True when a commit wait ended because the node DISCARDED the transaction —
 * a definitive "this will never land", as opposed to the indeterminate
 * timeout the same call throws when the poll window simply expires.
 *
 * The distinction is what lets a caller decide whether "submitted, outcome
 * unknown" is a safe assumption. A timeout leaves the transaction possibly on
 * chain, so optimistically finalizing is the better trade; a discard means the
 * chain state provably did NOT change, so finalizing would report a failure as
 * a success and persist local state describing a rotation that never happened.
 *
 * Both realms produce the same text, from the same `isDiscarded()` branch:
 * flag-off the SDK's `TransactionsResource.waitFor` throws
 * `Transaction rejected: <id>`, and the offscreen realm's in-realm poll loop
 * (`offscreen/main.ts`) reproduces it verbatim for exactly that reason — so one
 * matcher covers extension, mobile and desktop.
 */
export function isTransactionDiscardedError(err: unknown): boolean {
  // Same ordering rationale as isApplyAfterSubmitError: an eviction carries the
  // raw realm error in its `cause`, and this walks the chain, so a trap whose
  // text happened to embed the phrase must not be read as a node verdict.
  if (isWasmClientPoisonedError(err)) return false;
  return errorMessageParts(err).some(part => /transaction rejected/i.test(part));
}

/**
 * True when the node refused a transaction because the account state it was
 * built on is no longer the account's current state:
 *
 *   "... initial account commitment 0x... does not match the current commitment 0x... for account 0x..."
 *
 * The node answers this at admission, so the refused transaction never entered
 * the mempool. A recovered Guardian device meets it when it built on state it
 * adopted before the old device's last transaction settled (#904).
 *
 * Same rules as `isApplyAfterSubmitError`: both phrases must come from ONE error
 * in the chain, and a lock-recovery eviction is never a node verdict.
 */
export function isStaleInitialCommitmentError(error: unknown): boolean {
  if (isWasmClientPoisonedError(error)) return false;
  return errorMessageParts(error).some(part =>
    /initial account commitment[\s\S]*does not match the current commitment/i.test(part)
  );
}

/**
 * True when importing a public account failed because the node has no such
 * account, as opposed to the node being unreachable.
 *
 * web-sdk sets `ACCOUNT_NOT_FOUND_ON_CHAIN` only when the node attaches its
 * error code, and 0.16 nodes do not: their miss arrives as a generic
 * `get_account` InvalidArgument whose chain text contains "RPC error", which
 * the connectivity heuristic reads as an outage (#1127). Both phrases must come
 * from ONE link: the verdict lets a restore fall through to creating a fresh
 * wallet, so a match assembled from two unrelated errors would hide a real
 * account behind an empty one.
 */
export function isAccountNotFoundOnChainError(err: unknown): boolean {
  if (isWasmClientPoisonedError(err)) return false;
  if (extractSdkErrorCode(err) === 'ACCOUNT_NOT_FOUND_ON_CHAIN') return true;
  return errorMessageParts(err).some(
    part =>
      /account with id \S+ not found on the network/i.test(part) ||
      (/grpc request failed for get_account: invalid request parameters/i.test(part) &&
        /not found at block \d+/i.test(part))
  );
}
