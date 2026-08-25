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
// This is behind `MIDEN_USE_OFFSCREEN_CLIENT` (see the flag's own doc below for
// the per-bundle defaults — ON in the extension service worker, off elsewhere).
// With the flag off, every method here is a strict pass-through to the inline
// `getMidenClient()` singleton.

import { Account, getWasmOrThrow, Note, TransactionResult, type NoteQuery } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import type { NoteExportType } from 'lib/miden/sdk/constants';
import type { ConsumableNoteDto } from 'lib/miden/sdk/consumable-notes';
import { collectInputNoteDetails } from 'lib/miden/sdk/input-note-detail';
import type { InputNoteSummaryDto } from 'lib/miden/sdk/input-note-summary';
import { reduceInputNoteSummary } from 'lib/miden/sdk/input-note-summary';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import type { InputNoteDetails, RecoveryRangeResult } from 'lib/miden/sdk/miden-client-interface';
import type { PswapLineageDto } from 'lib/miden/sdk/pswap-lineage';
import { reducePswapLineage } from 'lib/miden/sdk/pswap-lineage';
import type { SerializedInputNoteDetail } from 'lib/shared/types';

import {
  OFFSCREEN_CALL,
  OFFSCREEN_RELOAD_ENDPOINTS,
  OFFSCREEN_TARGET,
  OperationAbortedError,
  b64ToBytes,
  bytesToB64,
  encodeArg,
  type OffscreenCallRequest,
  type OffscreenCallResponse,
  type OffscreenReloadEndpointsRequest,
  type OffscreenReloadEndpointsResponse,
  type OffscreenSignRequest,
  type OffscreenSignResponse
} from './offscreen-codec';
import {
  decrementCriticalOp,
  ensureOffscreenDocument,
  forceCloseOffscreenDocument,
  hasOffscreenDocument,
  incrementCriticalOp,
  isCriticalOpInFlight,
  isOffscreenAvailable
} from './offscreen-prover';
import type { ConsumeTransaction, ITransactionStage, SendTransaction, SwapTransaction } from '../db/types';
import {
  buildSignCallbackError,
  buildSignCallbackOptions,
  type SignCallbackReason
} from '../transaction/sign-callback';
import type { NoteType } from '../types';

/**
 * Feature flag: route proxied methods through the offscreen document.
 *
 * Read as a module constant (mirroring `USE_OFFSCREEN_PROVING`) so a build with
 * the flag off dead-code-eliminates the offscreen branch.
 *
 * Defaults per bundle, which decide whether an op has a deadline at all:
 *   - extension service worker (`vite.background.config.ts`): ON. Ops are
 *     dispatched to the offscreen realm and DO get their `deadlineMs`.
 *   - extension UI, desktop, content scripts: OFF (env-overridable).
 *   - mobile: hardcoded off (no `chrome.offscreen` in WKWebView / Android
 *     WebView).
 *
 * So a backend op runs offscreen-with-deadline on the extension and INLINE WITH
 * NO DEADLINE on mobile and desktop. Anything long-running has to bound itself;
 * it cannot rely on a deadline to cut it off.
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
 * Per-op deadline (ms) for one pending-note recovery chunk (transport drain,
 * proposal-note import, scan-range resolution, or one bounded public-backfill
 * range). Recovery is deliberately chunked into ops of this size — a single
 * long-held op starves queued reads past their dispatch-armed deadlines and
 * gets the realm killed.
 */
const NOTE_RECOVERY_CHUNK_DEADLINE_MS = 60_000;

/**
 * Decode one recovery chunk's JSON payload. Recovery decides whether to clear
 * the one-shot pending flag from these numbers, so a malformed payload has to
 * throw rather than degrade: an absent `failures` would otherwise make the
 * orchestrator's `sourceFailures` accumulator NaN, and `NaN > 0` is false —
 * reading as "every source succeeded" over a chunk that reported nothing.
 */
function parseRecoveryResult(method: string, resultB64: string | null): unknown {
  if (resultB64 == null) throw new Error(`${method}: offscreen document returned no result`);
  return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64)));
}

function readRecoveryCount(method: string, parsed: unknown, field: string): number {
  const value = parsed && typeof parsed === 'object' ? Reflect.get(parsed, field) : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${method}: offscreen document returned a malformed ${field}`);
  }
  return value;
}

function parseRecoveryCounts(method: string, resultB64: string | null): { imported: number; failures: number } {
  const parsed = parseRecoveryResult(method, resultB64);
  return {
    imported: readRecoveryCount(method, parsed, 'imported'),
    failures: readRecoveryCount(method, parsed, 'failures')
  };
}

/**
 * `saturated` drives the caller's range-splitting loop, so a non-boolean has to
 * throw rather than be coerced: a truthy string would make it split forever.
 */
function readRecoverySaturated(method: string, parsed: unknown): boolean {
  const value = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'saturated') : undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${method}: offscreen document returned a malformed saturated`);
  }
  return value;
}

/**
 * `nextNoteOffset` re-offers the same block range, so like `saturated` it can
 * loop: absent means finished, and anything present that is not a non-negative
 * integer throws rather than being coerced into a cursor that never advances.
 */
function readRecoveryNoteOffset(method: string, parsed: unknown): number | undefined {
  const value = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'nextNoteOffset') : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${method}: offscreen document returned a malformed nextNoteOffset`);
  }
  return value;
}

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
 *
 * Overridable by the build ONLY so the E2E stack can retune it (#718). Every
 * shipping bundle leaves it at 90s: raising the shipping default on the strength
 * of a CI timing would trade a visible CI failure for an invisible production
 * hang, which is the one thing this knob exists to prevent.
 *
 * The E2E override must stay BELOW the Playwright per-test timeout (300s,
 * playwright.e2e.config.ts), or this deadline can never fire inside a test and
 * the wedge-reclaim built for exactly that case is dead code there — the spec
 * always dies first, turning a bounded, logged abort into an unexplained 300s
 * timeout with no Failed row. An earlier 600s override did precisely that.
 * Sizing it does NOT need runner headroom: the two consumes that completed on
 * that same 2-core runner took 12.1s and 9.9s end to end, so the healthy worst
 * case is seconds, not minutes.
 */
const WRITE_DEADLINE_MS = Number(process.env.MIDEN_WRITE_DEADLINE_MS ?? '90000');

/**
 * Per-op deadline (ms) for the private-note transport relay.
 *
 * Sized as a WRITE, not a read, because of what a lost relay costs. The relay is a
 * network round-trip to the transport service carrying the only copy of a private
 * note's body the recipient can ever receive; the transaction has already landed
 * when it runs, so an abort here does not undo a spend — it strands one. It
 * previously carried `READ_DEADLINE_MS` (15s) on the reasoning that a transport
 * call does no prove or sign, which is true of the WORK but not of the STAKES.
 *
 * 45s, matching `SYNC_DEADLINE_MS`: the closest peer, being the other op whose
 * budget is dominated by a remote service rather than local WASM. Well below the
 * write ceiling, since no proving happens here.
 *
 * The deadline VALUE is the smaller half of the fix. The relay also dispatches as a
 * `criticalOp`, which is what moves the budget to execution start (`markOpStarted`)
 * so queue-wait behind other ops is off-budget, and what stops a coincident cheap
 * read's deadline from tearing the realm down mid-relay. Under the old arrangement
 * a busy realm could burn the entire 15s in the queue and abort the relay before it
 * had made a single request — the reported `OperationAbortedError`, whose error is
 * indistinguishable from a transport failure that DID reach the outbox.
 */
const RELAY_DEADLINE_MS = 45_000;

/**
 * Dispatch-time BACKSTOP deadline (ms) for a whole-op offscreen WRITE (issue #260
 * flip-prep, defense-in-depth).
 *
 * A critical write's REAL {@link WRITE_DEADLINE_MS} is armed only at EXECUTION
 * START (`markOpStarted`, on the offscreen doc's `OFFSCREEN_OP_STARTED` signal),
 * so queue-wait behind other ops is off-budget and can't false-kill a healthy
 * queued write. But if that start signal is ever DROPPED while the SW stays alive,
 * the write would run — or wait — with NO timer and could hang until SW eviction
 * (a funds-path write stuck forever). To bound that, `dispatchOp` arms THIS
 * generous backstop at dispatch, which `markOpStarted` REPLACES with the real
 * `WRITE_DEADLINE_MS` on start. It is set far ABOVE any legitimate queue-wait so it
 * CANNOT false-kill a write merely queued behind slow ops — the exact bug arm-on-start
 * fixed — yet is bounded so a dropped-start op is eventually reclaimed instead of
 * hanging forever. The worst-case contiguous mutex-hold by other ops is a full
 * `syncState` (~45s) plus a write (~90s) ≈ 135s; the commit-wait, though its own
 * ceiling is now 150s, YIELDS the mutex during its inter-poll sleeps (follow-up #1),
 * so a queued write runs DURING those sleeps rather than waiting the whole poll — it
 * does not dominate queue-wait. 5min keeps ample headroom above 135s.
 * Normal path: dispatch → backstop(5min) → start → real(~90s). Dropped start:
 * dispatch → backstop(5min) fires → op killed (bounded, not hung).
 */
const CRITICAL_DISPATCH_BACKSTOP_MS = 300_000;

/**
 * Per-op deadline (ms) for `waitForTransactionCommit`. This op BLOCKS inside the
 * offscreen realm on an in-realm poll loop that reproduces the SDK's
 * `transactions.waitFor(id)` semantics (chain sync → id filter →
 * committed/discarded/timeout), throwing "Transaction confirmation timed out"
 * after its own ~60s poll window.
 *
 * WHY 150s and not the SDK's ~60s + a little: the offscreen commit-wait now YIELDS
 * the offscreen WASM mutex during each WASM-free inter-poll sleep (issue #260
 * post-flip follow-up #1), so other ops (balance polls, reads, queued writes) run
 * during those ~55s of sleep instead of being blocked for the whole poll. The
 * flip side is that THIS op's wall-clock — which this deadline measures from
 * execution start — now also includes the time OTHER ops hold the mutex during its
 * sleeps. On a busy realm that inflates a legitimate 60s poll's wall-clock well
 * beyond 70s, which the old value would false-kill. 150s gives clear headroom above
 * the 60s poll window plus realistic contention, while still bounding a genuinely
 * wedged realm. A killed commit-wait is recoverable, not funds-critical: the op
 * rejects with `OperationAbortedError`, which the structural guardian path treats
 * exactly like flag-off's waitFor timeout (→ cancelTransaction → Failed → completion
 * not run, recoverable by re-run) — so raising the ceiling trades a slightly later
 * reclaim of a truly-wedged wait for not false-killing a healthy contended one.
 * NOT a read's short `READ_DEADLINE_MS` (15s).
 */
const COMMIT_WAIT_DEADLINE_MS = 150_000;

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

/** The per-step stage stamp the tx loop supplies for a staged write (PR #524) —
 * in practice `stage => setTransactionStage(row.id, stage)`. Same shape the SDK's
 * `MidenClientInterface.sendTransaction(tx, onStage)` takes, so the flag-OFF path
 * can hand it straight through unmodified. */
/**
 * A per-step stage stamp (PR #524).
 *
 * `opts.reliable === false` marks a stamp REPLAYED FROM THE OFFSCREEN REALM: it
 * crossed `chrome.runtime` fire-and-forget, so it carries no delivery or ordering
 * guarantee relative to the op's own reply. The stamp is still good enough to time
 * a step, but NOT to drive a control decision — see the funds-safety note in
 * `setTransactionStage`. An inline caller omits `opts` entirely.
 */
type StageCallback = (stage: ITransactionStage, opts?: { readonly reliable?: boolean }) => Promise<void> | void;

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

/**
 * op_id → the per-step stage stamp for that write op (PR #524, preserved across
 * the rehost). Registered and torn down on the EXACT same lines as
 * {@link opSignCallbacks} — before dispatch, deleted in the write's `finally` —
 * because it is the same op-scoped-map pattern: the offscreen realm knows only
 * the `op_id`, so an inbound {@link OFFSCREEN_STAGE_EVENT} is mapped back to the
 * right transaction row purely through this entry.
 *
 * Consequences of the op-scoped lifetime, both deliberate: a stamp for an op that
 * already settled (or was killed) finds no entry and is dropped, and an op whose
 * caller passed no `onStage` registers nothing at all. Both are silent — a stage
 * stamp is TELEMETRY for the timing UI, never transaction state, so it must not be
 * able to fail a write.
 */
const opStageCallbacks = new Map<string, StageCallback>();

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
    // Preserve the SDK's stable error code end-to-end (issue #260, funds-critical).
    // Re-attach it onto the rejection under `errorCode`, one of the two names
    // `extractSdkErrorCode` reads. The rejection's MESSAGE also embeds the offscreen
    // realm's verbatim error text, which is what lets the SW classify a round-tripped
    // apply-after-submit failure (`isApplyAfterSubmitError`) identically to the
    // flag-off inline path — marked Completed, NOT Failed → requeue → double-spend —
    // even though web-sdk 0.16 attaches no code for that variant. Shared by all four
    // writes via `dispatchOffscreenWrite`/this single choke point. A code-less failure
    // (`undefined`) leaves the error untagged, exactly as before.
    const err = new Error(`Offscreen call '${op.method}' failed: ${resp.error}`);
    if (resp.errorCode !== undefined) (err as { errorCode?: string }).errorCode = resp.errorCode;
    op.reject(err);
  }
}

/**
 * Settle an op that failed at the TRANSPORT layer (`sendMessage` rejected).
 *
 * This is the same physical event as {@link finishOp}'s `resp === undefined`
 * branch — the offscreen document went away before it could answer — so it
 * settles with the same error TYPE. The runtime picks between the two shapes
 * (an `undefined` resolution vs. a "message channel closed" rejection) for
 * reasons the SW cannot observe, and a bare `Error` here classified differently
 * from an `OperationAbortedError` everywhere downstream: `tryCompleteKilledConsume`
 * would skip its node check, and the offscreen-kill reason would not be
 * recognizable in the persisted `rawError`. The original message is preserved as
 * `cause` so nothing diagnostic is lost.
 */
function finishOpError(op_id: string, err: unknown): void {
  const op = takeInFlight(op_id);
  if (!op) return;
  const aborted = new OperationAbortedError(op_id, 'transport');
  aborted.cause = err;
  op.reject(aborted);
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
    // A whole-op WRITE (critical) does NOT arm its REAL deadline at dispatch: that
    // is armed at EXECUTION START via `markOpStarted` when the op wins the offscreen
    // WASM mutex (issue #260 flip-prep #3), so queue-wait behind other ops on that
    // single mutex is off-budget and can't false-kill a healthy write. Instead it
    // arms a GENEROUS `CRITICAL_DISPATCH_BACKSTOP_MS` backstop here (defense-in-depth):
    // if the `OFFSCREEN_OP_STARTED` signal is ever dropped, the write can't hang
    // timer-less until SW eviction — the backstop eventually reclaims it — yet the
    // backstop sits far above any legitimate queue-wait, so it can't false-kill a
    // merely-queued write. `markOpStarted` REPLACES it with the real `deadlineMs`.
    // A read (non-critical) keeps arming its real deadline at dispatch — it covers
    // the whole round-trip — and `markOpStarted` merely re-arms it fresh at start.
    // Either way `op.deadlineMs` retains the REAL deadline, so the on-start re-arm
    // uses it, not the backstop.
    const timer =
      deadlineMs != null
        ? setTimeout(
            () => {
              void onDeadline(op_id);
            },
            critical ? CRITICAL_DISPATCH_BACKSTOP_MS : deadlineMs
          )
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
 * ARM (or re-arm) an op's deadline at EXECUTION START (issue #260 flip-prep #3).
 * Called from the SW reverse-IPC listener when the offscreen doc posts
 * `OFFSCREEN_OP_STARTED` — i.e. the op has won the single offscreen WASM mutex and
 * is about to execute. This is where a WRITE's REAL deadline is armed: writes are
 * not armed with their real deadline at dispatch (only the generous
 * `CRITICAL_DISPATCH_BACKSTOP_MS` backstop is), so their queue-wait is off-budget;
 * this REPLACES that backstop with the real `op.deadlineMs`. For a read it resets
 * the dispatch-armed timer so the read's budget also measures only execution time,
 * not queue-wait. Clears any existing timer (backstop or real) and unpauses first
 * (defensive — a sign round-trip can only begin after execution starts), then arms
 * the REAL `op.deadlineMs` afresh. No-op for an op that already settled or was
 * never dispatched here.
 */
export function markOpStarted(op_id: string): void {
  const op = inFlight.get(op_id);
  if (!op) return;
  if (op.timer) clearTimeout(op.timer);
  op.paused = false;
  op.timer =
    op.deadlineMs != null
      ? setTimeout(() => {
          void onDeadline(op_id);
        }, op.deadlineMs)
      : null;
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
 * recorded PER-OP (so the write path can re-tag the thrown error for
 * `isLockedError`; issue #260 flip-prep #1 removed the redundant global slot).
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
      return { ok: false, sign_id, error: classified.message, reason: classified.reason };
    }
  } finally {
    resumeDeadline(op_id);
  }
}

/**
 * Tell the OFFSCREEN realm that the saved developer endpoint override changed, so
 * it re-reads it and drops its client singleton.
 *
 * Needed because BOTH the override cache (`lib/miden-chain/effective-endpoints`)
 * and the Miden client singleton are module-scoped, and module scope is per realm.
 * The SW's `loadEndpointOverrides()` + `resetMidenClient()` therefore reach only
 * the SW realm — while flag-on it is the OFFSCREEN client that executes writes,
 * runs `syncState` and talks to the node. Without this nudge that client would keep
 * the endpoints it was created with until the document is closed.
 *
 * Chosen over closing the document (`forceCloseOffscreenDocument`) because a close
 * is only safe when {@link isCriticalOpInFlight} is false, and skipping the
 * invalidation whenever a critical op IS in flight would silently leave the realm
 * pointed at the old node. This message needs no such gate: the offscreen handler
 * runs no WASM and clears only a module slot, so a running write finishes on the
 * client it already captured while the next one is built against the new endpoints.
 *
 * Resolves false — doing nothing — when the flag is off, when there is no
 * `chrome.offscreen` API, or when NO document is currently open. In the last case
 * there is nothing to invalidate and a document opened later hydrates the override
 * during its own init, so this never creates one (contrast `dispatchOp`, which
 * always `ensureOffscreenDocument()`s first).
 *
 * Resolves true only on an explicit ack. A rejected `sendMessage` — the document
 * was reaped between the check and the send — resolves false rather than throwing:
 * that realm is gone and its replacement loads the override at init, so there is
 * nothing for the caller to recover from.
 */
export async function reloadOffscreenEndpointOverrides(): Promise<boolean> {
  if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) return false;
  if (!(await hasOffscreenDocument())) return false;
  const envelope: OffscreenReloadEndpointsRequest = {
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_RELOAD_ENDPOINTS
  };
  try {
    const resp = (await chrome.runtime.sendMessage(envelope)) as OffscreenReloadEndpointsResponse | undefined;
    return resp?.ok === true;
  } catch {
    return false;
  }
}

/**
 * SW-side handler for the offscreen realm's per-step stage stamp (PR #524 across
 * the issue #260 boundary). Called from the SW reverse-IPC listener when the
 * offscreen doc posts an {@link OffscreenStageEvent}: look up the op's registered
 * stage callback and forward the stamp, which lands on the transaction row as
 * `stageTimestamps[stage]` for the generating-transaction screen's per-step
 * durations.
 *
 * Deliberately the mirror-image of {@link handleOffscreenSignRequest}'s
 * strictness, because the two channels carry opposite risk:
 *   - NO response, and no deadline pause. The offscreen side does not await this,
 *     so nothing on the write's critical path can block on the SW.
 *   - An event for an unknown / already-settled op is IGNORED, silently. The op
 *     entry is torn down the instant the write settles, so a stamp racing the
 *     final response legitimately arrives late; that must be a no-op, not a throw.
 *   - A throwing or rejecting `onStage` is SWALLOWED (logged only). The stamp is
 *     telemetry; a Dexie hiccup writing it must never fail a funds-moving write.
 */
export function handleOffscreenStageEvent(op_id: string, stage: ITransactionStage): void {
  const onStage = opStageCallbacks.get(op_id);
  if (!onStage) return;
  try {
    // `Promise.resolve` covers both callback shapes (`Promise<void> | void`) with
    // one catch; the result is intentionally not awaited — see above.
    // `reliable: false` — this stamp crossed the realm boundary fire-and-forget, so
    // it may be dropped or reordered against the op's reply. It must therefore time
    // a step without authoring the control `stage` field that the guardian requeue
    // gates read (see `setTransactionStage`).
    void Promise.resolve(onStage(stage, { reliable: false })).catch((err: unknown) => {
      console.warn(`[MidenClientProxy] stage stamp '${stage}' for op ${op_id} rejected; ignoring`, err);
    });
  } catch (err) {
    // A SYNCHRONOUS throw from the callback lands here (a rejected promise lands
    // in the catch above); both are equally non-fatal to the op.
    console.warn(`[MidenClientProxy] stage stamp '${stage}' for op ${op_id} threw; ignoring`, err);
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
 * the op-keyed locked-reason tag (§2.6, issue #313), `criticalOpCount`
 * bracketing (§3), and the sign-paused 90s `WRITE_DEADLINE_MS` kill (§3.4). The
 * ONLY per-method variation is the `method` name and the DTO/bytes `args`.
 *
 * The SW WASM lock is deliberately NOT held: the write serializes inside the
 * offscreen doc's own mutex, and holding the SW lock would both stall SW sync /
 * balance for the whole (multi-second) op and block the reverse-IPC sign handler
 * that must run SW-side mid-op (design §7.1).
 *
 * `onStage` (optional) is the write's per-step stage stamp (PR #524). The two
 * pipelines that drive execute → prove → submit as distinct stages supply one — the
 * non-guardian send and the guardian leaf; the writes that hand the SDK one opaque
 * call (`consumeNoteId`, `swapTransaction`, `newTransaction`) have no boundaries to
 * stamp, so they leave it undefined and register nothing.
 */
async function dispatchOffscreenWrite(
  method: string,
  args: unknown[],
  signCallback: RawSignCallback,
  onStage?: StageCallback
): Promise<TransactionResult> {
  const op_id = newOpId();
  // Register BEFORE dispatch so a sign request (which can only arrive AFTER the
  // OFFSCREEN_CALL is sent, from inside the offscreen execute) always finds it.
  // The op's locked-mid-sign reason is recorded OP-KEYED in `opSignReasons`
  // (keyed by this `op_id`), so no cross-op slate-clearing is needed — the tag is
  // inherently isolated per op (issue #260 flip-prep #1). The stage stamp registers
  // on the same line and for the same reason: an OFFSCREEN_STAGE_EVENT can only
  // arrive after this dispatch, from inside the offscreen execute.
  opSignCallbacks.set(op_id, signCallback);
  if (onStage) opStageCallbacks.set(op_id, onStage);
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
    // Same lifetime as the sign callback: the op is over, so a stamp that lands
    // from here on has nowhere to go and is dropped by `handleOffscreenStageEvent`.
    opStageCallbacks.delete(op_id);
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
 *
 * `onStage` (optional) is the leaf's per-step stage stamp (PR #524), carried the
 * same way {@link dispatchOffscreenWrite}'s other staged caller — the non-guardian
 * send — carries it: registered op-scoped here, replayed from the offscreen realm's
 * `OFFSCREEN_STAGE_EVENT`s. It exists because the offscreen leaf must stamp the same
 * `executing` / `proving` / `submitting` boundaries the SW-inline `runGuardianPipeline`
 * stamps, or the guardian send — the wallet's DEFAULT account type — loses its
 * per-step durations on the one build that defaults the flag ON.
 */
export function dispatchGuardianPipeline(
  accountId: string,
  trBytes: Uint8Array,
  delegateTransaction: boolean | undefined,
  signCallback: RawSignCallback,
  onStage?: StageCallback
): Promise<TransactionResult> {
  return dispatchOffscreenWrite('guardianPipeline', [accountId, trBytes, delegateTransaction], signCallback, onStage);
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
   * Wait for a submitted transaction to be committed on chain (issue #260, slice 6b).
   *
   * This MUST poll the SAME client that applied the tx, mirroring the `syncState` /
   * `getAccount` forwarding above:
   *
   *   Flag off (default): BYTE-IDENTICAL to production today — the exact
   *   `withWasmClientLock(async () => { const c = await getMidenClient(); await
   *   c.waitForTransactionCommit(id); })` block the structural guardian completion
   *   path used to run inline. The SW client applied the tx flag-off, so it owns the
   *   committed state and (as with the other flag-off pass-throughs, W2) the caller
   *   need not — and does not — hold the lock: it is taken here.
   *
   *   Flag on: the whole leaf pipeline ran in the OFFSCREEN realm, so the SW client
   *   is dormant/unsynced and would time out. Forward the wait to the offscreen doc,
   *   which polls the realm that owns the applied state (driving the poll loop in-realm
   *   so it can yield the offscreen mutex during its sleeps — follow-up #1). It is a
   *   READ-style wait — no sign callback, NOT a `criticalOp`/write — but it legitimately
   *   BLOCKS up to the ~60s poll window AND its wall-clock now absorbs other ops'
   *   mutex-holds during those yielded sleeps, so it carries its own
   *   `COMMIT_WAIT_DEADLINE_MS` (150s), well above 60s, rather than a read's short
   *   `READ_DEADLINE_MS`. The offscreen side discards the void result (nothing to
   *   re-hydrate).
   */
  async waitForTransactionCommit(transactionId: string): Promise<void> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        await midenClient.waitForTransactionCommit(transactionId);
      });
      return;
    }
    await this.call('waitForTransactionCommit', [transactionId], { deadlineMs: COMMIT_WAIT_DEADLINE_MS });
  },

  /**
   * Relay a just-created PRIVATE note to the recipient via the transport layer
   * (issue #260, slice 7b).
   *
   * This MUST run on the SAME client that created the note, mirroring the
   * `waitForTransactionCommit` companion above — and for a funds-critical reason:
   * under 0.16 `MidenClientInterface.sendPrivateNote` calls
   * `notes.sendPrivateOutput({ noteId })`, which resolves the note BY ID from the
   * calling client's store as an APPLIED OUTPUT note and derives the recipient's
   * forward-scan hint from that stored `expected_height` (the chain tip when the
   * note's transaction was submitted). Under the flag the send ran offscreen, so
   * the note is an output note of the OFFSCREEN client's store only; relaying on
   * the dormant SW client rejects outright with the SDK's `No output note found for
   * the given id` and the recipient — whose copy of these bytes may be the only one
   * — silently never receives it.
   *
   * (Under 0.15 this call was `notes.sendPrivate(note, to)` and the hint was the
   * client's live sync height, which is why the realm-pinning was originally argued
   * from sync-height staleness. The requirement is the same; the reason is not.)
   *
   *   Flag off (default): BYTE-IDENTICAL to the former inline relay — the exact
   *   `getMidenClient().sendPrivateNote(note, to)` under the WASM lock (the caller's
   *   relay block used to hold this lock; it is taken here now, exactly as
   *   `waitForTransactionCommit` does, so the relay+wait stay a coherent unit — each
   *   proxy call owns its own lock rather than the caller wrapping both). The live
   *   `Note` is passed straight through (never serialized on this path).
   *
   *   Flag on: forward to the offscreen doc. The live `Note` cannot cross
   *   postMessage, so it crosses as `note.serialize()` bytes (`encodeArg`'s raw-bytes
   *   tag, never JSON) and is re-hydrated offscreen via `Note.deserialize`; only its
   *   ID is then used, because `notes.sendPrivateOutput` looks the note back up in
   *   the offscreen store — which is exactly where the write that created it applied
   *   it. Every relay today is for an output note of a transaction the SAME realm
   *   just executed, proved, submitted and applied; a note this realm did not apply
   *   (an imported one, or one whose client DB `lib/miden/reset.ts` has since
   *   cleared) does not satisfy that precondition. The offscreen side discards the
   *   void result.
   *
   * Dispatched as a `criticalOp` on a write-class deadline
   * ({@link RELAY_DEADLINE_MS}), despite doing no prove or sign. That looks like a
   * category error and is not: `criticalOp` marks ops that must not be torn down
   * mid-flight because they are moving value, and this one is the only step that
   * makes a landed private note reachable at all. Two concrete consequences, both
   * load-bearing:
   *
   *   - The budget arms at EXECUTION START (`markOpStarted`) instead of dispatch, so
   *     time spent queued behind other ops on the single offscreen WASM mutex is
   *     off-budget. Under the previous non-critical 15s read deadline a busy realm
   *     could spend the whole budget waiting for the mutex and abort the relay
   *     before it issued a single request.
   *   - A coincident cheap READ's deadline DOWNGRADES to a reject-without-kill
   *     rather than tearing down the realm this relay is running in.
   *
   * The old comment justified the short deadline by arguing a kill was safe because
   * "the SDK persists the relay payload to its durable outbox BEFORE transport".
   * That is the wrong way round: Rust writes the outbox entry INSIDE the relay,
   * after resolving the transport API, so an abort during the window this deadline
   * governs — including one that lands before `sendPrivateOutput` has even resolved
   * the note — queues nothing at all.
   */
  async sendPrivateNote(note: Note, recipientAccountId: string): Promise<void> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        await midenClient.sendPrivateNote(note, recipientAccountId);
      });
      return;
    }
    const op_id = newOpId();
    incrementCriticalOp();
    try {
      await dispatchOp(op_id, 'sendPrivateNote', [note.serialize(), recipientAccountId], RELAY_DEADLINE_MS, true);
    } finally {
      decrementCriticalOp();
    }
  },

  /**
   * Re-push of an already-relayed private note, by id.
   *
   * Same realm requirement and same critical-op treatment as
   * {@link sendPrivateNote} — it is the identical transport call and the identical
   * store lookup, differing only in that the sweep has no live `Note` to hand over
   * (see `MidenClientInterface.relayPrivateNoteById`).
   */
  async relayPrivateNoteById(noteId: string, recipientAccountId: string): Promise<void> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        await midenClient.relayPrivateNoteById(noteId, recipientAccountId);
      });
      return;
    }
    const op_id = newOpId();
    incrementCriticalOp();
    try {
      await dispatchOp(op_id, 'relayPrivateNoteById', [noteId, recipientAccountId], RELAY_DEADLINE_MS, true);
    } finally {
      decrementCriticalOp();
    }
  },

  /**
   * Whether one of this client's own output notes is consumed on chain — the
   * sweep's delivery receipt (see `MidenClientInterface.isOutputNoteConsumed`).
   *
   * A plain read: short deadline, not a `criticalOp`. Losing it costs one sweep
   * cycle, and the sweep's default answer ("not proven delivered") is the safe one.
   */
  async isOutputNoteConsumed(noteId: string): Promise<boolean> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        return await midenClient.isOutputNoteConsumed(noteId);
      });
    }
    const resultB64 = await this.call('isOutputNoteConsumed', [noteId], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return false;
    return new TextDecoder().decode(b64ToBytes(resultB64)) === 'true';
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
   * Node-authoritative commit state of a tx by hex id (see
   * MidenClientInterface.getTransactionCommitState). Backs the send/swap
   * idempotent-retry guard so a Failed row whose submit actually landed is never
   * resubmitted (double-send).
   *
   * Both flag paths must really answer. This used to return a hardcoded
   * 'not-found' when the flag was on, described as conservative — it is the
   * opposite. `verifySendLanded` maps 'not-found' to 'unknown', its "cannot
   * prove it landed" verdict, and the retry goes ahead on that: the guard exists
   * precisely to catch the case the stub silently waved through. And the flag is
   * ON by default in the service worker, so the shipping path was the one with
   * no guard at all.
   *
   * A dispatch failure therefore throws rather than degrading to a verdict. The
   * caller's own catch treats a throw as indeterminate, which is the same
   * conservative answer — but it logs, instead of quietly reporting a state the
   * client never checked.
   */
  async getTransactionCommitState(txId: string): Promise<'committed' | 'pending' | 'not-found'> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return (await getMidenClient()).getTransactionCommitState(txId);
    }
    const resultB64 = await this.call('getTransactionCommitState', [txId], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) {
      throw new Error('getTransactionCommitState: offscreen returned no result');
    }
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as 'committed' | 'pending' | 'not-found';
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
   * Read the client's sync height (issue #260, slice 7a).
   *
   * The guardian recallable-send request build reads the reclaim baseline off the
   * client's sync height. Under the flag the offscreen client owns the synced
   * height and the SW client is dormant, so a SW-inline read is STALE — which would
   * understate the absolute reclaim height and can get an Epoch-bridge / earn
   * collateral note rejected by the solver's allocator. Route it through the realm
   * that owns the sync state.
   *
   * `fresh` mirrors the caller's `freshSync` branch: `true` forces a network sync
   * first and returns the just-synced block (`(await client.sync()).blockNum()`);
   * `false` (default) reads the last-synced height (`client.getSyncHeight()`).
   *
   * Flag off (default): BYTE-IDENTICAL to the guardian path's inline read — the
   * exact `(await getMidenClient()).client.sync().blockNum()` / `.getSyncHeight()`
   * call, no internal lock (the caller owns it). Flag on: forward to the offscreen
   * doc; a `fresh` read carries the sync backstop deadline (it runs a network sync),
   * a plain read the short read deadline. The number crosses as JSON.
   */
  async getSyncHeight(opts?: { fresh?: boolean }): Promise<number> {
    const fresh = opts?.fresh ?? false;
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      const client = (await getMidenClient()).client;
      return fresh ? (await client.sync()).blockNum() : client.getSyncHeight();
    }
    const resultB64 = await this.call('getSyncHeight', [fresh], {
      deadlineMs: fresh ? SYNC_DEADLINE_MS : READ_DEADLINE_MS
    });
    if (resultB64 == null) {
      // getSyncHeight always yields a number; a null here is a hard error.
      throw new Error('getSyncHeight: offscreen document returned no height');
    }
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as number;
  },

  /**
   * Read a PSWAP order's lineage as a plain {@link PswapLineageDto} (issue #260,
   * slice 7a). The live `PswapLineageRecord` has no serializer and callers reach
   * through to `.currentTipNoteId()/.currentDepth()/.state()/.orderId()/…` — none of
   * which can cross postMessage — so the shared `reducePswapLineage` reducer runs in
   * whichever realm owns the client and only the JSON-safe DTO crosses.
   *
   * Flag off (default): the SW-inline client reduces here (behavior-preserving — the
   * exact reach-through the callers used, relocated into one reducer; caller owns the
   * lock). Flag on: the OFFSCREEN client — which owns the synced lineage — reduces,
   * so a settlement / tracking read can't go stale against a dormant SW client.
   * `orderId` crosses as a string (a BigInt can't be JSON-encoded).
   */
  async getPswapLineage(orderId: string | bigint): Promise<PswapLineageDto | null> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return reducePswapLineage(await (await getMidenClient()).client.pswap.lineage(orderId));
    }
    const resultB64 = await this.call('getPswapLineage', [String(orderId)], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return null;
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as PswapLineageDto;
  },

  /**
   * Read a to-be-consumed note's summary as a plain {@link InputNoteSummaryDto}
   * (issue #260, slice 7a). `getInputNote` returns a live `InputNoteRecord` the
   * caller reaches through for `metadata()?.noteType()`; the record can't cross
   * postMessage, so `reduceInputNoteSummary` reduces it to the one field the caller
   * reads and only that crosses. `null` (not found) is preserved so the caller's
   * "note not found" throw is unchanged.
   *
   * Flag off (default): the SW-inline client's `getInputNote` reduces here
   * (behavior-preserving; caller owns the lock). Flag on: the OFFSCREEN client —
   * which owns the imported/synced note — reduces, so the read can't miss a note the
   * dormant SW client never received.
   */
  async getInputNoteSummary(noteId: string): Promise<InputNoteSummaryDto | null> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return reduceInputNoteSummary(await (await getMidenClient()).getInputNote(noteId));
    }
    const resultB64 = await this.call('getInputNoteSummary', [noteId], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return null;
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as InputNoteSummaryDto;
  },

  /**
   * Read invalid-note detail for a set of claimable notes as plain, wire-shaped
   * {@link SerializedInputNoteDetail}s (issue #260, slice 7-reads).
   *
   * The `GetInputNoteDetailsRequest` handler (popup invalid-note detection, via
   * `useClaimNotes` under `isExtension()`) reaches through each live `InputNoteRecord`
   * `getInputNote(id)` returns for its assets / processing `state()` / `nullifier()`.
   * Under the flag the offscreen client owns that synced note state and the SW client
   * is dormant, so a SW-inline read is STALE — an "Invalid" note the offscreen realm
   * knows about would never surface. Route the whole batch through the realm that owns
   * the notes; the shared `collectInputNoteDetails` runs the per-id loop + reduction in
   * ONE op, so only the plain DTO array crosses (the live records never do).
   *
   * Flag off (default): BYTE-IDENTICAL to the inline handler — the same per-id
   * `getInputNote` loop + reach-through, reduced here (caller owns the WASM lock, as
   * with the other flag-off reads). Flag on: forward + JSON round-trip. This is
   * DISTINCT from {@link getInputNoteDetails}, which returns the numeric-`state`
   * `InputNoteDetails` shape a different (non-extension) caller consumes.
   */
  async getSerializedInputNoteDetails(noteIds: string[]): Promise<SerializedInputNoteDetail[]> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      const client = await getMidenClient();
      return collectInputNoteDetails(noteId => client.getInputNote(noteId), noteIds);
    }
    const resultB64 = await this.call('getSerializedInputNoteDetails', [noteIds], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return [];
    return JSON.parse(new TextDecoder().decode(b64ToBytes(resultB64))) as SerializedInputNoteDetail[];
  },

  /**
   * Import a serialized note (NoteFile / Note bytes) into the client's store (issue
   * #260, slice 7a). This is a STORE WRITE, not a read: under the flag the note MUST
   * land in the OFFSCREEN client's store, else that client — the one that syncs and
   * consumes — never sees the note (a private note whose bytes are its only copy
   * would be lost to the dormant SW store).
   *
   * Flag off (default): BYTE-IDENTICAL — inline `(await getMidenClient()).
   * importNoteBytes(bytes)` (caller owns the lock). Flag on: forward to the
   * offscreen doc so the import hits the realm that owns the synced store. It is a
   * quick store op (no prove / sign — NOT a `criticalOp`); a wedge is reclaimed by
   * the read deadline. Returns the imported note's id / details commitment (the
   * `importAllNotes` caller discards it).
   */
  async importNoteBytes(noteBytes: Uint8Array): Promise<string> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return (await getMidenClient()).importNoteBytes(noteBytes);
    }
    const resultB64 = await this.call('importNoteBytes', [noteBytes], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) {
      // importNoteBytes always yields the imported id/commitment string; a null
      // here means the offscreen op produced nothing, a hard error.
      throw new Error('importNoteBytes: offscreen document returned no note id');
    }
    return new TextDecoder().decode(b64ToBytes(resultB64));
  },

  /** Pending-note recovery chunk: drain the private-note transport backlog. */
  async drainPrivateNoteTransport(): Promise<void> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () => (await getMidenClient()).drainPrivateNoteTransport());
    }
    await this.call('drainPrivateNoteTransport', [], { deadlineMs: NOTE_RECOVERY_CHUNK_DEADLINE_MS });
  },

  /** Pending-note recovery chunk: import proposal-embedded note bytes. */
  async importRecoveryNoteBytes(proposalNoteBytes: Uint8Array[]): Promise<{ imported: number; failures: number }> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () => (await getMidenClient()).importRecoveryNoteBytes(proposalNoteBytes));
    }
    const encodedNotes = proposalNoteBytes.map(bytesToB64);
    const resultB64 = await this.call('importRecoveryNoteBytes', [encodedNotes], {
      deadlineMs: NOTE_RECOVERY_CHUNK_DEADLINE_MS
    });
    return parseRecoveryCounts('importRecoveryNoteBytes', resultB64);
  },

  /** Pending-note recovery chunk: resolve the creation-block scan range. */
  async resolveRecoveryScanRange(createdAtSeconds: number): Promise<{ startBlock: number; latestBlock: number }> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () => (await getMidenClient()).resolveRecoveryScanRange(createdAtSeconds));
    }
    const resultB64 = await this.call('resolveRecoveryScanRange', [createdAtSeconds], {
      deadlineMs: NOTE_RECOVERY_CHUNK_DEADLINE_MS
    });
    const parsed = parseRecoveryResult('resolveRecoveryScanRange', resultB64);
    return {
      startBlock: readRecoveryCount('resolveRecoveryScanRange', parsed, 'startBlock'),
      latestBlock: readRecoveryCount('resolveRecoveryScanRange', parsed, 'latestBlock')
    };
  },

  /** Pending-note recovery chunk: public backfill over ONE bounded block range. */
  async recoverPublicNotesRange(
    accountId: string,
    blockFrom: number,
    blockTo: number,
    noteOffset = 0
  ): Promise<RecoveryRangeResult> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () =>
        (await getMidenClient()).recoverPublicNotesRange(accountId, blockFrom, blockTo, noteOffset)
      );
    }
    const resultB64 = await this.call('recoverPublicNotesRange', [accountId, blockFrom, blockTo, noteOffset], {
      deadlineMs: NOTE_RECOVERY_CHUNK_DEADLINE_MS
    });
    const parsed = parseRecoveryResult('recoverPublicNotesRange', resultB64);
    return {
      imported: readRecoveryCount('recoverPublicNotesRange', parsed, 'imported'),
      failures: readRecoveryCount('recoverPublicNotesRange', parsed, 'failures'),
      saturated: readRecoverySaturated('recoverPublicNotesRange', parsed),
      nextNoteOffset: readRecoveryNoteOffset('recoverPublicNotesRange', parsed)
    };
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
   *
   * `onStage` is the per-step stage stamp (PR #524) and is honoured on BOTH paths,
   * because on the extension — the one build that defaults the flag ON — flag-ON is
   * the production path, so a flag-ON-only gap would silently delete the timings:
   *   Flag OFF: handed straight to the inline `sendTransaction(tx, onStage)`, which
   *   is precisely the call the tx loop used to make itself (byte-identity holds
   *   with the callback, not without it).
   *   Flag ON: registered op-scoped in `opStageCallbacks`; the offscreen realm posts
   *   an `OFFSCREEN_STAGE_EVENT` per step and the SW reverse-IPC listener replays it
   *   through this same callback. The row id never crosses the boundary — the op_id
   *   is the whole correspondence.
   */
  async sendTransaction(
    transaction: SendTransaction,
    signCallback: RawSignCallback,
    onStage?: StageCallback
  ): Promise<TransactionResult> {
    if (!USE_OFFSCREEN_CLIENT || !isOffscreenAvailable()) {
      return withWasmClientLock(async () =>
        (await getMidenClient(buildSignCallbackOptions(signCallback))).sendTransaction(transaction, onStage)
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
    return dispatchOffscreenWrite('sendTransaction', [dto], signCallback, onStage);
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
  opStageCallbacksSize: () => opStageCallbacks.size,
  isOffscreenClientEnabled: () => USE_OFFSCREEN_CLIENT,
  writeDeadlineMs: () => WRITE_DEADLINE_MS,
  criticalDispatchBackstopMs: () => CRITICAL_DISPATCH_BACKSTOP_MS,
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
