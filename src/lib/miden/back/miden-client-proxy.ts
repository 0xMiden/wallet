// SW-side `MidenClientProxy` — the thin forwarder half of the offscreen
// WASM-client rehost (issue #260, slice 1).
//
// Today the wallet's singleton WASM `MidenClient` runs inline on the MV3
// service-worker thread, so a wedged WASM op holds locks that only a full
// realm teardown (SW eviction) can clear. Slice 1 proves the mechanism that
// fixes this: move a method (`getAccount`, here) into the `chrome.offscreen`
// document and forward the call over IPC, carrying a per-op `deadline_ms`.
// When a deadline fires, the SW `closeDocument()`s the offscreen realm — the
// wedged WASM call dies with it — reopens a fresh doc, and rejects the
// in-flight op(s) with `OperationAbortedError`.
//
// This is behind `MIDEN_USE_OFFSCREEN_CLIENT`, DEFAULT OFF. With the flag off,
// every method here is a strict pass-through to the existing inline
// `getMidenClient()` singleton, so production behavior is unchanged.

import { Account, getWasmOrThrow, TransactionResult, type NoteQuery } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import type { NoteExportType } from 'lib/miden/sdk/constants';
import type { ConsumableNoteDto } from 'lib/miden/sdk/consumable-notes';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import type { InputNoteDetails } from 'lib/miden/sdk/miden-client-interface';

import {
  OFFSCREEN_CALL,
  OFFSCREEN_TARGET,
  OperationAbortedError,
  b64ToBytes,
  bytesToB64,
  encodeArg,
  type OffscreenCallRequest,
  type OffscreenCallResponse,
  type OffscreenSignRequest,
  type OffscreenSignResponse
} from './offscreen-codec';
import {
  decrementCriticalOp,
  ensureOffscreenDocument,
  forceCloseOffscreenDocument,
  incrementCriticalOp,
  isCriticalOpInFlight,
  isOffscreenAvailable
} from './offscreen-prover';
import type { ConsumeTransaction, SendTransaction, SwapTransaction } from '../db/types';
import {
  buildSignCallbackError,
  buildSignCallbackOptions,
  clearLastSignReason,
  recordLastSignReason,
  type SignCallbackReason
} from '../transaction/sign-callback';
import type { NoteType } from '../types';

/**
 * Feature flag: route proxied methods through the offscreen document.
 *
 * DEFAULT OFF. Read as a module constant (mirroring `USE_OFFSCREEN_PROVING`)
 * so a build with the flag off dead-code-eliminates the offscreen branch. All
 * vite configs default `MIDEN_USE_OFFSCREEN_CLIENT` to `'false'`; mobile
 * hardcodes it off (no `chrome.offscreen` in WKWebView / Android WebView).
 */
const USE_OFFSCREEN_CLIENT = process.env.MIDEN_USE_OFFSCREEN_CLIENT === 'true';

/**
 * Per-op deadline (ms) for a pure read. A `getAccount` that hasn't returned in
 * this long is a wedge candidate; the deadline kill reclaims the realm.
 */
const READ_DEADLINE_MS = 15_000;

/**
 * Per-op deadline (ms) for a `syncState`. Sync is legitimately slow on testnet
 * — the balance/notes sync loop already wraps it in its own 30s
 * `SYNC_TIMEOUT_MS` — so this backstop sits ABOVE that: the caller's own timeout
 * fires first for an ordinary-slow sync, and this deadline kill only reclaims a
 * genuinely-wedged realm (design §1.2 `SYNC_DEADLINE`).
 */
const SYNC_DEADLINE_MS = 45_000;

/**
 * Per-op deadline (ms) for a whole-op offscreen WRITE (`consumeNoteId`).
 *
 * This is the funds-risk knob (design §3.4). It must clear a legitimate
 * `execute (~1s) + prove (~3–10s MT) + submit + apply (~ms)` with wide margin,
 * yet sit far below the 30-min `MAX_WAIT_BEFORE_CANCEL` reaper. Crucially it is
 * PAUSED for the entire duration of every reverse-IPC sign round-trip
 * (`pauseDeadline`/`resumeDeadline`, design §2.5), so a slow Face-ID / unlock
 * sign is NEVER mistaken for a wedge — the deadline measures only WASM-execution
 * time between sign round-trips. When it does fire, the wedge is overwhelmingly
 * pre-submit (the multi-second WASM steps), which is fully safe (nothing on
 * chain); a mid-submit fire is left to node adjudication + `syncState` reconcile
 * (design §4), the same risk profile as today's eviction, now time-bounded.
 */
const WRITE_DEADLINE_MS = 90_000;

interface InFlightOp {
  /** Resolve the caller's promise with the raw `resultB64` (or `null`). */
  resolveResult: (resultB64: string | null) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
  /** The op's full deadline (ms), retained so a paused deadline can be re-armed
   * from scratch after a sign round-trip. `null` ⇒ no deadline. */
  deadlineMs: number | null;
  /** True for a whole-op offscreen WRITE. A critical op's OWN deadline MAY kill
   * the realm (the wedge case, design §3.3); a NON-critical (read) op's deadline
   * coincident with a critical op in flight downgrades to reject-without-kill. */
  critical: boolean;
  /** True while a reverse-IPC sign round-trip is outstanding for this op — its
   * deadline timer is cleared and re-armed on the sign response (design §2.5). */
  paused: boolean;
}

/**
 * op_id → in-flight op. A `closeDocument()` kill rejects EVERY entry, because
 * closing the doc kills every concurrent op's realm (design §1.3, §3.2).
 */
const inFlight = new Map<string, InFlightOp>();

/** The RAW hex-in/bytes-out sign callback shape the tx loop supplies (the SW's
 * `swSignCallback`). It is what crosses into the reverse-IPC handler; the SDK
 * keystore's byte-shaped `sign` is built from it via `buildSignCallbackOptions`. */
type RawSignCallback = (publicKey: string, signingInputs: string) => Promise<Uint8Array>;

/**
 * op_id → the RAW `(publicKeyHex, signingInputsHex) => signatureBytes` callback
 * for that write op's mid-execute signing (design §2.7). The write dispatch
 * registers it before sending the OFFSCREEN_CALL and deletes it on settle/kill,
 * so the secret-touching callback is scoped to the op's lifetime. The reverse-IPC
 * handler looks it up (falling back to the caller-supplied default) when the
 * offscreen doc requests a signature.
 */
const opSignCallbacks = new Map<string, RawSignCallback>();

/**
 * op_id → the classified reason of that op's LAST failed reverse-IPC sign
 * (design §2.6). Recorded by the reverse-IPC handler; read by the write path so
 * a locked-mid-sign failure can be re-tagged onto the thrown error, making
 * `isLockedError(err)` in the tx loop DEFER (not Fail) the consume — the issue
 * #313 note-loss guard. Op-scoped (keyed by op_id) so it cannot bleed across ops.
 */
const opSignReasons = new Map<string, SignCallbackReason>();

function newOpId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for environments without crypto.randomUUID; op ids only need to be
  // unique within this SW, not cryptographically strong.
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Remove and return an op, clearing its deadline timer. Returns undefined if
 * it was already settled (e.g. a kill got there first) — callers no-op then. */
function takeInFlight(op_id: string): InFlightOp | undefined {
  const op = inFlight.get(op_id);
  if (!op) return undefined;
  if (op.timer) clearTimeout(op.timer);
  inFlight.delete(op_id);
  return op;
}

/** Settle an op from a well-formed offscreen response (or `undefined` = doc
 * closed/reaped → treat as an abort, design §3.1). */
function finishOp(op_id: string, resp: OffscreenCallResponse | undefined): void {
  const op = takeInFlight(op_id);
  if (!op) return;
  if (resp === undefined) {
    op.reject(new OperationAbortedError(op_id, 'doc-closed'));
    return;
  }
  if (resp.ok) op.resolveResult(resp.resultB64);
  else {
    // Preserve the SDK's stable `errorCode` end-to-end (issue #260, funds-critical).
    // Re-attach it onto the rejection in the EXACT shape the SW tx classifier reads
    // (`extractSdkErrorCode` → `err.errorCode`), so a round-tripped
    // `ApplyTransactionAfterSubmitFailed` from a failed offscreen write is classified
    // identically to the flag-off inline path (marked Completed, NOT Failed → requeue
    // → double-spend). Shared by all four writes via `dispatchOffscreenWrite`/this
    // single choke point. A code-less failure (`undefined`) leaves the error
    // untagged, exactly as before.
    const err = new Error(`Offscreen call '${op.method}' failed: ${resp.error}`);
    if (resp.errorCode !== undefined) (err as { errorCode?: string }).errorCode = resp.errorCode;
    op.reject(err);
  }
}

/** Settle an op that failed at the transport layer (sendMessage rejected). */
function finishOpError(op_id: string, err: unknown): void {
  const op = takeInFlight(op_id);
  if (!op) return;
  op.reject(err instanceof Error ? err : new Error(String(err)));
}

/** Reject every still-in-flight op with a fresh abort error (its own op_id). */
function rejectAllInFlight(reason: string): void {
  for (const op_id of Array.from(inFlight.keys())) {
    const op = takeInFlight(op_id);
    op?.reject(new OperationAbortedError(op_id, reason));
  }
}

/**
 * The deadline handler (design §3.2, §3.3). Who may kill during a critical op:
 *   - a NON-critical (read) op's deadline while ANY critical op is in flight →
 *     DOWNGRADE to a reject-without-kill of just this op; the realm (and the live
 *     write / prove) survives. This is the whole point of `criticalOpCount`.
 *   - a critical op's OWN deadline (the wedge case #260 targets) → MAY kill.
 *   - a read deadline with no critical op in flight → kill + reopen as before.
 */
async function onDeadline(op_id: string): Promise<void> {
  const op = inFlight.get(op_id);
  if (!op) return; // already settled
  // Defensive: a paused op's timer is cleared, so onDeadline shouldn't fire for
  // it — but if a stale timer callback races the pause, do nothing.
  if (op.paused) return;

  if (!op.critical && isCriticalOpInFlight()) {
    // A cheap read's deadline while a value-moving critical op owns the doc.
    // Fail only this read — never tear down the realm running the write
    // (design §3.3). The offscreen op keeps running; its result is dropped.
    takeInFlight(op_id)?.reject(new OperationAbortedError(op_id, 'deadline-no-kill'));
    return;
  }

  // Either this IS the critical op whose own deadline fired (kill the wedge), or
  // a read deadline with no critical op in flight (kill + reopen).
  const closed = await forceCloseOffscreenDocument();
  // Closing the doc killed every concurrent op's realm — reject them all.
  // TODO(slice 4): there is a small window where an op whose sendMessage is
  // mid-flight (but whose result would have been fine) gets rejected as a
  // collateral 'deadline' abort. Harmless for idempotent reads; slice 4 must
  // weigh this against the write kill-window taxonomy (design §5) before routing
  // writes through here.
  rejectAllInFlight('deadline');
  if (closed) {
    // Reopen eagerly so the next call doesn't pay the cold start on its own
    // critical path. Best-effort: the next call's ensureOffscreenDocument()
    // would recreate it anyway.
    await ensureOffscreenDocument().catch(() => {});
  }
}

/**
 * The low-level dispatch (design §1.2 `call` + §3). Forwards a method call to
 * the offscreen doc under a caller-supplied `op_id` and enforces the per-op
 * deadline. `critical` marks a whole-op write so `onDeadline` treats its own
 * deadline as killable while shielding it from coincident read deadlines.
 * Resolves with the raw `resultB64` (base64 result, or `null`).
 */
async function dispatchOp(
  op_id: string,
  method: string,
  args: unknown[],
  deadlineMs: number | null,
  critical: boolean
): Promise<string | null> {
  await ensureOffscreenDocument();
  return new Promise<string | null>((resolve, reject) => {
    const timer =
      deadlineMs != null
        ? setTimeout(() => {
            void onDeadline(op_id);
          }, deadlineMs)
        : null;
    inFlight.set(op_id, { resolveResult: resolve, reject, timer, method, deadlineMs, critical, paused: false });

    const envelope: OffscreenCallRequest = {
      target: OFFSCREEN_TARGET,
      type: OFFSCREEN_CALL,
      op_id,
      method,
      argsB64: args.map(encodeArg),
      deadline_ms: deadlineMs
    };
    // `sendMessage` may resolve with the response, resolve `undefined` (doc
    // closed), or reject ("message port closed"). All three are handled: a
    // late settle for an already-killed op no-ops via takeInFlight().
    Promise.resolve(chrome.runtime.sendMessage(envelope)).then(
      resp => finishOp(op_id, resp as OffscreenCallResponse | undefined),
      err => finishOpError(op_id, err)
    );
  });
}

/** The generic (non-critical) RPC entry: generate an op_id and dispatch a read. */
function dispatchWithDeadline(method: string, args: unknown[], deadlineMs: number | null): Promise<string | null> {
  return dispatchOp(newOpId(), method, args, deadlineMs, false);
}

// --- Reverse-IPC sign channel (issue #260, slice 5, design §2) --------------

/**
 * PAUSE an op's deadline for the duration of an outstanding sign round-trip
 * (design §2.5). A sign can block indefinitely on the user (Face ID, an unlock
 * prompt); the write's deadline must not count that wall-clock, or a slow sign
 * would be mistaken for a wedge and kill a healthy write. Clears the timer and
 * marks the op paused; no-op if the op already settled.
 */
function pauseDeadline(op_id: string): void {
  const op = inFlight.get(op_id);
  if (!op || op.paused) return;
  if (op.timer) clearTimeout(op.timer);
  op.timer = null;
  op.paused = true;
}

/**
 * RE-ARM an op's deadline after its sign round-trip resolved (design §2.5). The
 * deadline restarts from scratch, so it measures only WASM-execution time
 * BETWEEN sign round-trips. No-op if the op already settled while paused (e.g. a
 * kill got there first).
 */
function resumeDeadline(op_id: string): void {
  const op = inFlight.get(op_id);
  if (!op || !op.paused) return;
  op.paused = false;
  if (op.deadlineMs != null) {
    op.timer = setTimeout(() => {
      void onDeadline(op_id);
    }, op.deadlineMs);
  }
}

/**
 * SW-side reverse-IPC sign handler (design §2.4). The offscreen client's
 * `keystore.sign` stub posts an {@link OffscreenSignRequest}; this signs via the
 * op's registered callback (or `fallbackSignCallback`) — the EXISTING vault
 * signer — and returns raw signature bytes. Only bytes cross; no SDK handle.
 *
 * Deadline pause (§2.5): the op's deadline is cleared on entry and re-armed on
 * exit, so a slow/blocked sign never trips a kill.
 *
 * Locked-defer (§2.6, issue #313): on a sign failure the raw error is classified
 * exactly as the inline path does (`buildSignCallbackError`) and the reason is
 * recorded both per-op (so the write path can re-tag the thrown error for
 * `isLockedError`) and in the SW-side slot (so `readLastAuthReason` sees it).
 */
export async function handleOffscreenSignRequest(
  msg: OffscreenSignRequest,
  fallbackSignCallback: RawSignCallback
): Promise<OffscreenSignResponse> {
  const { op_id, sign_id } = msg;
  pauseDeadline(op_id);
  try {
    const cb = opSignCallbacks.get(op_id) ?? fallbackSignCallback;
    const publicKeyHex = Buffer.from(b64ToBytes(msg.publicKeyB64)).toString('hex');
    const signingInputsHex = Buffer.from(b64ToBytes(msg.signingInputsB64)).toString('hex');
    try {
      const signature = await cb(publicKeyHex, signingInputsHex);
      return { ok: true, sign_id, signatureB64: bytesToB64(signature) };
    } catch (rawErr) {
      // Classify identically to the inline path so a locked vault DEFERS.
      const classified = buildSignCallbackError(rawErr);
      opSignReasons.set(op_id, classified.reason);
      recordLastSignReason(classified.reason);
      return { ok: false, sign_id, error: classified.message, reason: classified.reason };
    }
  } finally {
    resumeDeadline(op_id);
  }
}

/**
 * The minimal, JSON-clean write DTOs that cross to the offscreen realm
 * (design §6.1). Each write method reads ONLY a handful of fields off its tx
 * row, and the full tx carries a BigInt `amount` that `JSON.stringify` can't
 * encode — so we ship exactly what the op needs, no more. BigInt amounts cross
 * as decimal strings and are re-widened to BigInt inside the offscreen dispatch.
 */
type OffscreenConsumeDto = {
  accountId: string;
  noteId: string;
  noteIds: string[];
  delegateTransaction?: boolean;
};

/** `sendTransaction` reads exactly these fields off the `SendTransaction` row
 * (verified against `MidenClientInterface.sendTransaction`). `amount` is the
 * row's BigInt as a decimal string; `noteType` is the plain 'public'/'private'
 * string enum; `extraInputs.recallBlocks` (when present) turns the send into a
 * recallable P2IDE — all JSON-safe. */
type OffscreenSendDto = {
  accountId: string;
  secondaryAccountId: string;
  faucetId: string;
  noteType: NoteType;
  amount: string;
  delegateTransaction?: boolean;
  extraInputs: { recallBlocks?: number };
};

/** `swapTransaction` reads exactly these fields off the `SwapTransaction` row
 * (verified against `MidenClientInterface.swapTransaction`). Both the offered
 * `amount` and the requested `extraInputs.requestedAmount` are the row's BigInts
 * as decimal strings. */
type OffscreenSwapDto = {
  accountId: string;
  faucetId: string;
  amount: string;
  delegateTransaction?: boolean;
  extraInputs: { requestedFaucetId: string; requestedAmount: string };
};

/**
 * Run a whole-op offscreen WRITE (design §6.2, Option A): the entire
 * execute→prove→submit→apply chain runs inside ONE offscreen op, so a wedge
 * anywhere in it is killable via `closeDocument()`. Only plain bytes cross — a
 * JSON/bytes DTO in, the serialized `TransactionResult` out; the intermediate
 * `TransactionResult`/`ProvenTransaction`/request handles stay opaque in-realm.
 *
 * Shared by EVERY non-guardian write — `consumeNoteId` (slice 5a) and
 * `sendTransaction`/`swapTransaction`/`newTransaction` (slice 5b) — so each runs
 * on the SAME proven machinery: an op-scoped reverse-IPC sign callback (§2.7),
 * the clear-then-record locked-reason slot (§2.6, issue #313), `criticalOpCount`
 * bracketing (§3), and the sign-paused 90s `WRITE_DEADLINE_MS` kill (§3.4). The
 * ONLY per-method variation is the `method` name and the DTO/bytes `args`.
 *
 * The SW WASM lock is deliberately NOT held: the write serializes inside the
 * offscreen doc's own mutex, and holding the SW lock would both stall SW sync /
 * balance for the whole (multi-second) op and block the reverse-IPC sign handler
 * that must run SW-side mid-op (design §7.1).
 */
async function dispatchOffscreenWrite(
  method: string,
  args: unknown[],
  signCallback: RawSignCallback
): Promise<TransactionResult> {
  const op_id = newOpId();
  // Register BEFORE dispatch so a sign request (which can only arrive AFTER the
  // OFFSCREEN_CALL is sent, from inside the offscreen execute) always finds it.
  opSignCallbacks.set(op_id, signCallback);
  // Fresh slate for the SW-side reason slot so `readLastAuthReason` reads only
  // THIS op's sign outcome (design §2.6).
  clearLastSignReason();
  incrementCriticalOp();
  try {
    const resultB64 = await dispatchOp(op_id, method, args, WRITE_DEADLINE_MS, /* critical */ true);
    if (resultB64 == null) {
      // Every offscreen write yields a TransactionResult; a null here means the
      // offscreen op produced nothing, a hard error.
      throw new Error(`${method}: offscreen document returned no TransactionResult bytes`);
    }
    // The SW needs its own WASM instance to re-hydrate the result for the
    // completion handlers (`.executedTransaction()...`, `.serialize()`).
    // Deserialize is fast + non-wedging — the expensive work ran offscreen.
    await getWasmOrThrow();
    return TransactionResult.deserialize(b64ToBytes(resultB64));
  } catch (err) {
    // If this op's failure was a LOCKED sign, re-tag the thrown error so
    // `isLockedError(err)` in the tx loop DEFERS (not Fails) the write — the
    // issue #313 note-loss guard. Only 'locked' matters to `isLockedError`;
    // other reasons are left untagged (a genuine failure should Fail).
    const reason = opSignReasons.get(op_id);
    if (reason === 'locked' && err && typeof err === 'object' && (err as { reason?: unknown }).reason === undefined) {
      (err as { reason?: SignCallbackReason }).reason = reason;
    }
    throw err;
  } finally {
    decrementCriticalOp();
    opSignCallbacks.delete(op_id);
    opSignReasons.delete(op_id);
  }
}

/**
 * Run a GUARDIAN write LEAF PIPELINE offscreen (issue #260, slice 6a).
 *
 * A guardian tx's co-signature is contributed BEFORE execute, so by the time the
 * SW reaches this point `tr` is a fully-signed, guardian-co-signed
 * `TransactionRequest` whose `serialize()` preserves the extended advice map (the
 * co-signatures). Only the leaf `executeRequest → prove → submit → apply` crosses
 * — the identical op-shape as every non-guardian write — so this delegates to the
 * SAME `dispatchOffscreenWrite` machinery: the op-scoped reverse-IPC sign callback
 * (the executeRequest keystore sign, over the EXISTING OFFSCREEN_SIGN_REQUEST
 * channel), `criticalOp` bracketing, the sign-paused 90s `WRITE_DEADLINE_MS` kill,
 * and `finishOp`'s `errorCode` re-attach (so a round-tripped
 * `ApplyTransactionAfterSubmitFailed` reaches the SW GUARDIAN classifier intact).
 * `trBytes` is `tr.serialize()`; it crosses as raw bytes (`encodeArg`), never JSON.
 *
 * The whole guardian graph — `MultisigService`, guardian HTTP co-sign, cold-key
 * co-sign, `signWord`, `abandonCandidate`, `waitForTransactionCommit` — stays on
 * the SW thread, unmodified, before/after this call.
 */
export function dispatchGuardianPipeline(
  accountId: string,
  trBytes: Uint8Array,
  delegateTransaction: boolean | undefined,
  signCallback: RawSignCallback
): Promise<TransactionResult> {
  return dispatchOffscreenWrite('guardianPipeline', [accountId, trBytes, delegateTransaction], signCallback);
}

/**
 * The SW-side proxy. Presents (a slice of) the `MidenClientInterface` surface
 * but forwards to the offscreen doc when the flag is on. With the flag off it
 * is a strict pass-through to the inline singleton — a no-op vs. today.
 */
export const midenClientProxy = {
  /** Generic RPC — forward `method(args)` to the offscreen doc, deadline-guarded. */
  call(method: string, args: unknown[], opts?: { deadlineMs?: number | null }): Promise<string | null> {
    return dispatchWithDeadline(method, args, opts?.deadlineMs ?? null);
  },

  /**
   * Read an account by id.
   *
   * Flag off (default): inline `getMidenClient().getAccount(id)` — identical to
   * production today. Flag on: forward to the offscreen doc, which serializes
   * the `Account` to bytes; the SW re-hydrates it here (via `Account.deserialize`)
   * so callers still get a live `Account` they can reach through
   * (`.vault().fungibleAssets()` etc.).
   */
  async getAccount(accountId: string): Promise<Account | null> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      // W2 — CALLER-SIDE LOCKING IS THE CALLER'S JOB ON THIS PATH. This raw
      // `getMidenClient().getAccount(id)` does NOT take the WASM client lock.
      // That is correct because it exactly preserves today's behavior: every
      // current caller supplies its own serialization around getAccount — the
      // hot balance poll uses `tryWithWasmClientLock` (fetchBalances), and
      // vault / guardian-sync use `withWasmClientLock`. An unlocked read fired
      // inside a transaction's `_withInnerWebClient` window double-borrows the
      // WASM RefCell and crashes (see `sdk/miden-client.ts` isWasmClientBusy).
      // => Slice 2, when it rewires call sites onto this proxy, MUST keep the
      //    caller-side lock wrapping the proxy call, or it reintroduces that
      //    crash on the flag-OFF path. (Flag-ON serializes inside the offscreen
      //    doc via its own mutex; flag-OFF has no such safety net here.)
      return (await getMidenClient()).getAccount(accountId);
    }
    const resultB64 = await this.call('getAccount', [accountId], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return null;
    // The SW no longer owns the client, but still needs its own WASM instance
    // loaded to reconstruct the returned Account object. `Account.deserialize`
    // is a fast, non-wedging op — the expensive DB read ran offscreen.
    await getWasmOrThrow();
    return Account.deserialize(b64ToBytes(resultB64));
  },

  /**
   * Sync local state against the node.
   *
   * Flag off (default): inline `getMidenClient().syncState()` — identical to
   * production today, and (like getAccount, W2) the CALLER owns the WASM lock;
   * this method never takes one on the flag-off path. Every rewired call site
   * wraps this in its existing `withWasmClientLock`, so flag-off is byte-for-byte
   * the same as before.
   *
   * Flag on: forward to the offscreen doc. Every SW-side caller `await`s and
   * DISCARDS the returned `SyncSummary` (verified across all call sites), so the
   * offscreen side runs the sync and returns `null` — nothing is serialized and
   * nothing is re-hydrated back on the SW thread. That is deliberate: the whole
   * point of the rehost is to keep WASM work OFF the SW, and re-hydrating a
   * `SyncSummary` no caller reads would drag a WASM call back onto it.
   */
  async syncState(): Promise<void> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      await (await getMidenClient()).syncState();
      return;
    }
    await this.call('syncState', [], { deadlineMs: SYNC_DEADLINE_MS });
  },

  /**
   * Export a note to serialized bytes.
   *
   * Flag off: inline (caller owns the lock). Flag on: forward — the SDK's
   * `exportNote` already returns note bytes, so they ride the wire base64 and
   * are handed back verbatim (no live SDK object to re-hydrate; the caller wants
   * the raw bytes to ship over the intercom).
   */
  async exportNote(noteId: string, exportType: NoteExportType): Promise<Uint8Array> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return (await getMidenClient()).exportNote(noteId, exportType);
    }
    const resultB64 = await this.call('exportNote', [noteId, exportType], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) {
      // exportNote always yields bytes; a null here means the offscreen op
      // produced nothing, which is a hard error rather than an empty result.
      throw new Error('exportNote: offscreen document returned no bytes');
    }
    return b64ToBytes(resultB64);
  },

  /**
   * Read reduced note details.
   *
   * This exercises the §1.4-rule-"a" serialization path — a PLAIN DTO — distinct
   * from getAccount's serialize()-bytes path. The interface method already
   * reduces each live `InputNoteRecord` to a JSON-safe `InputNoteDetails` (string
   * ids/assets/nullifier, NUMERIC `NoteType` / `InputNoteState` enums), so the
   * offscreen side JSON-encodes that DTO to bytes and the SW parses it back.
   * Nothing reaches through to a live wasm-bindgen object, so there is nothing to
   * re-hydrate — which is exactly why (unlike `getConsumableNotes` /
   * `getInputNote`, whose raw `InputNoteRecord` has no serializer and IS
   * reached-through) this method CAN cross the boundary.
   *
   * Flag off: inline (caller owns the lock). Flag on: forward + JSON round-trip.
   */
  async getInputNoteDetails(query?: NoteQuery): Promise<InputNoteDetails[]> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return (await getMidenClient()).getInputNoteDetails(query);
    }
    const resultB64 = await this.call('getInputNoteDetails', [query], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return [];
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as InputNoteDetails[];
  },

  /**
   * Read consumable notes as plain {@link ConsumableNoteDto}s (issue #260, slice 4).
   *
   * This is the behavior-AFFECTING move: the return shape changes from live
   * `InputNoteRecord[]` (which callers reached through via `.id()/.metadata()/…`)
   * to a plain DTO that carries every field those callers read. It is
   * behavior-PRESERVING because both flag paths reduce through the SAME
   * `getConsumableNoteDtos` reducer:
   *   - flag off (default): the SW-inline client reduces — the reclaim gate uses
   *     the SW client's own sync height, exactly as before this slice (the
   *     reduction just relocated out of each caller into one place).
   *   - flag on: the OFFSCREEN client reduces — the reclaim gate uses the
   *     offscreen (sync-running) realm's height, which is the whole fix: a single
   *     client owns the sync state, so the gate can't go stale (was: SW-inline
   *     gate reading a stale height after an offscreen sync → wrongly filtered
   *     funds-bearing notes). The DTO array JSON-round-trips across the boundary.
   *
   * Callers are flag-agnostic: they consume the DTO and apply their own per-note
   * skip rule (some skip on `!noteId`, the dApp handler on `!noteId || !nullifier`).
   */
  async getConsumableNotes(accountId: string): Promise<ConsumableNoteDto[]> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return (await getMidenClient()).getConsumableNoteDtos(accountId);
    }
    const resultB64 = await this.call('getConsumableNotes', [accountId], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return [];
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as ConsumableNoteDto[];
  },

  /**
   * Consume (claim) notes — the first WRITE moved offscreen (issue #260, slice 5a).
   *
   * `signCallback` is the RAW `(publicKeyHex, signingInputsHex) => signatureBytes`
   * the tx loop supplies (the SW's `swSignCallback`). It is used two ways:
   *
   *   Flag OFF (default) / offscreen unavailable: BYTE-IDENTICAL to production
   *   today. The consume runs inline on the SW client under the WASM lock, with
   *   the exact wrapped `signCallback` options `generateTransaction` has always
   *   built (`buildSignCallbackOptions`). This is the same `withWasmClientLock(
   *   () => getMidenClient(options).consumeNoteId(tx))` the switch ran before this
   *   slice pulled consume out — same lock, same options, same call.
   *
   *   Flag ON: the whole execute→prove→submit→apply chain runs in the offscreen
   *   realm as ONE killable op; the SDK keystore reaches the vault mid-execute via
   *   the reverse-IPC sign channel (which invokes THIS `signCallback` on the SW).
   *   The SW WASM lock is NOT held (design §7.1) — the offscreen doc's own mutex
   *   serializes the write.
   */
  async consumeNoteId(transaction: ConsumeTransaction, signCallback: RawSignCallback): Promise<TransactionResult> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () =>
        (await getMidenClient(buildSignCallbackOptions(signCallback))).consumeNoteId(transaction)
      );
    }
    const dto: OffscreenConsumeDto = {
      accountId: transaction.accountId,
      noteId: transaction.noteId,
      noteIds: transaction.noteIds,
      delegateTransaction: transaction.delegateTransaction
    };
    return dispatchOffscreenWrite('consumeNoteId', [dto], signCallback);
  },

  /**
   * Send (create a P2ID / recallable-P2IDE note) — moved offscreen (issue #260,
   * slice 5b). Same shape as {@link consumeNoteId}: flag-OFF is BYTE-IDENTICAL to
   * production (inline under the WASM lock with the exact wrapped sign options
   * `generateTransaction` has always built — same lock, same `getMidenClient(
   * options)`, same `sendTransaction(tx)`); flag-ON runs the whole
   * execute→prove→submit→apply chain in the offscreen realm as one killable op.
   *
   * The minimal DTO carries EXACTLY the fields `MidenClientInterface.sendTransaction`
   * reads off the row — `accountId`, `secondaryAccountId`, `faucetId`, `noteType`,
   * `amount` (BigInt → decimal string), `delegateTransaction`, and
   * `extraInputs.recallBlocks` — no more. `completeSendTransaction` (SW-side)
   * consumes the round-tripped `TransactionResult` identically; any private-note
   * relay it does runs on the SW's own inline client (no further offscreen call).
   */
  async sendTransaction(transaction: SendTransaction, signCallback: RawSignCallback): Promise<TransactionResult> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () =>
        (await getMidenClient(buildSignCallbackOptions(signCallback))).sendTransaction(transaction)
      );
    }
    const dto: OffscreenSendDto = {
      accountId: transaction.accountId,
      secondaryAccountId: transaction.secondaryAccountId,
      faucetId: transaction.faucetId,
      noteType: transaction.noteType,
      amount: transaction.amount.toString(),
      delegateTransaction: transaction.delegateTransaction,
      extraInputs: { recallBlocks: transaction.extraInputs?.recallBlocks }
    };
    return dispatchOffscreenWrite('sendTransaction', [dto], signCallback);
  },

  /**
   * Create a partial-swap (PSWAP) note — moved offscreen (issue #260, slice 5b).
   * Same flag-OFF byte-identity + flag-ON whole-op contract as {@link sendTransaction}.
   * The DTO carries EXACTLY what `MidenClientInterface.swapTransaction` reads —
   * `accountId`, `faucetId`, the offered `amount` (BigInt → string),
   * `delegateTransaction`, and `extraInputs.{requestedFaucetId, requestedAmount}`
   * (BigInt → string). `completeSwapTransaction` consumes the round-tripped
   * `TransactionResult` identically (no further client call).
   */
  async swapTransaction(transaction: SwapTransaction, signCallback: RawSignCallback): Promise<TransactionResult> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () =>
        (await getMidenClient(buildSignCallbackOptions(signCallback))).swapTransaction(transaction)
      );
    }
    const dto: OffscreenSwapDto = {
      accountId: transaction.accountId,
      faucetId: transaction.faucetId,
      amount: transaction.amount.toString(),
      delegateTransaction: transaction.delegateTransaction,
      extraInputs: {
        requestedFaucetId: transaction.extraInputs.requestedFaucetId,
        requestedAmount: transaction.extraInputs.requestedAmount.toString()
      }
    };
    return dispatchOffscreenWrite('swapTransaction', [dto], signCallback);
  },

  /**
   * Execute a pre-built custom `TransactionRequest` (custom-tx / execute) —
   * moved offscreen (issue #260, slice 5b). Same flag-OFF byte-identity + flag-ON
   * whole-op contract as the other writes. This one takes POSITIONAL args
   * mirroring `MidenClientInterface.newTransaction(accountId, requestBytes,
   * delegateTransaction)` — `requestBytes` crosses as raw bytes (`encodeArg`
   * base64), never JSON — because the request is opaque serialized bytes, not a
   * field-set. `completeCustomTransaction` consumes the round-tripped
   * `TransactionResult` identically; any private-note relay it does runs on the
   * SW's own inline client.
   */
  async newTransaction(
    accountId: string,
    requestBytes: Uint8Array,
    delegateTransaction: boolean | undefined,
    signCallback: RawSignCallback
  ): Promise<TransactionResult> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () =>
        (await getMidenClient(buildSignCallbackOptions(signCallback))).newTransaction(
          accountId,
          requestBytes,
          delegateTransaction
        )
      );
    }
    return dispatchOffscreenWrite('newTransaction', [accountId, requestBytes, delegateTransaction], signCallback);
  }
};

// Test-only accessors for the in-flight bookkeeping. Not part of the public
// contract; used to assert the kill path rejects every pending op and to drive
// the reverse-IPC sign + deadline-pause machinery deterministically.
export const __test = {
  inFlightSize: () => inFlight.size,
  inFlightOpIds: () => Array.from(inFlight.keys()),
  isOpPaused: (op_id: string) => inFlight.get(op_id)?.paused ?? false,
  hasOpTimer: (op_id: string) => inFlight.get(op_id)?.timer != null,
  opSignCallbacksSize: () => opSignCallbacks.size,
  isOffscreenClientEnabled: () => USE_OFFSCREEN_CLIENT,
  writeDeadlineMs: () => WRITE_DEADLINE_MS,
  /**
   * Dispatch a CRITICAL op with a caller-chosen deadline — a test hook that
   * exercises the real `dispatchOp` + `onDeadline` critical path (own-deadline
   * kill, sign-pause) without waiting the production 90s `WRITE_DEADLINE_MS`.
   * Mirrors the `criticalOp` bracketing `dispatchOffscreenConsume` performs.
   */
  dispatchCritical: (method: string, args: unknown[], deadlineMs: number | null) => {
    incrementCriticalOp();
    const op_id = newOpId();
    const promise = dispatchOp(op_id, method, args, deadlineMs, true).finally(() => decrementCriticalOp());
    return { op_id, promise };
  }
};
