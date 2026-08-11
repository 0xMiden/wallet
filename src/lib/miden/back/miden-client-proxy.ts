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

import { Account, getWasmOrThrow } from '@miden-sdk/miden-sdk/lazy';

import { getMidenClient } from 'lib/miden/sdk/miden-client';

import {
  OFFSCREEN_CALL,
  OFFSCREEN_TARGET,
  OperationAbortedError,
  b64ToBytes,
  encodeArg,
  type OffscreenCallRequest,
  type OffscreenCallResponse
} from './offscreen-codec';
import {
  ensureOffscreenDocument,
  forceCloseOffscreenDocument,
  isNonSpeculativeProveInFlight,
  isOffscreenAvailable
} from './offscreen-prover';

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

interface InFlightOp {
  /** Resolve the caller's promise with the raw `resultB64` (or `null`). */
  resolveResult: (resultB64: string | null) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

/**
 * op_id → in-flight op. A `closeDocument()` kill rejects EVERY entry, because
 * closing the doc kills every concurrent op's realm (design §1.3, §3.2).
 */
const inFlight = new Map<string, InFlightOp>();

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
  else op.reject(new Error(`Offscreen call '${op.method}' failed: ${resp.error}`));
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
 * The deadline handler (design §3.2). Kills the offscreen realm and rejects the
 * in-flight op(s) — UNLESS a real prove is sharing the doc, in which case we
 * must not collateral-kill it (design §4): downgrade to a reject-without-kill
 * of just the deadlined op.
 */
async function onDeadline(op_id: string): Promise<void> {
  if (!inFlight.has(op_id)) return; // already settled

  if (isNonSpeculativeProveInFlight()) {
    // A user's real prove owns the doc; don't tear it down for a read. Fail
    // only this op — the offscreen op keeps running and its result is dropped.
    takeInFlight(op_id)?.reject(new OperationAbortedError(op_id, 'deadline-no-kill'));
    return;
  }

  const closed = await forceCloseOffscreenDocument();
  // Closing the doc killed every concurrent op's realm — reject them all.
  rejectAllInFlight('deadline');
  if (closed) {
    // Reopen eagerly so the next call doesn't pay the cold start on its own
    // critical path. Best-effort: the next call's ensureOffscreenDocument()
    // would recreate it anyway.
    await ensureOffscreenDocument().catch(() => {});
  }
}

/**
 * The generic RPC entry (design §1.2 `call`). Forwards a method call to the
 * offscreen doc and enforces the per-op deadline. Resolves with the raw
 * `resultB64` (base64 result, or `null`); typed wrappers decode it.
 */
async function dispatchWithDeadline(
  method: string,
  args: unknown[],
  deadlineMs: number | null
): Promise<string | null> {
  await ensureOffscreenDocument();
  return new Promise<string | null>((resolve, reject) => {
    const op_id = newOpId();
    const timer =
      deadlineMs != null
        ? setTimeout(() => {
            void onDeadline(op_id);
          }, deadlineMs)
        : null;
    inFlight.set(op_id, { resolveResult: resolve, reject, timer, method });

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
      return (await getMidenClient()).getAccount(accountId);
    }
    const resultB64 = await this.call('getAccount', [accountId], { deadlineMs: READ_DEADLINE_MS });
    if (resultB64 == null) return null;
    // The SW no longer owns the client, but still needs its own WASM instance
    // loaded to reconstruct the returned Account object. `Account.deserialize`
    // is a fast, non-wedging op — the expensive DB read ran offscreen.
    await getWasmOrThrow();
    return Account.deserialize(b64ToBytes(resultB64));
  }
};

// Test-only accessors for the in-flight bookkeeping. Not part of the public
// contract; used to assert the kill path rejects every pending op.
export const __test = {
  inFlightSize: () => inFlight.size,
  isOffscreenClientEnabled: () => USE_OFFSCREEN_CLIENT
};
