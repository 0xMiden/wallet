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

import { Account, getWasmOrThrow, type NoteQuery } from '@miden-sdk/miden-sdk/lazy';

import type { NoteExportType } from 'lib/miden/sdk/constants';
import type { ConsumableNoteDto } from 'lib/miden/sdk/consumable-notes';
import { getMidenClient } from 'lib/miden/sdk/miden-client';
import type { InputNoteDetails } from 'lib/miden/sdk/miden-client-interface';

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

/**
 * Per-op deadline (ms) for a `syncState`. Sync is legitimately slow on testnet
 * — the balance/notes sync loop already wraps it in its own 30s
 * `SYNC_TIMEOUT_MS` — so this backstop sits ABOVE that: the caller's own timeout
 * fires first for an ordinary-slow sync, and this deadline kill only reclaims a
 * genuinely-wedged realm (design §1.2 `SYNC_DEADLINE`).
 */
const SYNC_DEADLINE_MS = 45_000;

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
  // TODO(slice 4): preserve `resp.errorCode` onto the rejection so callers can
  // classify (retryable vs. deterministic) without string-matching `error`.
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
    // TODO(slice 4): generalize `nonSpeculativeProveCount` → a `criticalOpCount`
    // that also covers proxied writes (sendTransaction/consume/swap) so their
    // submit→apply window is protected the same way a prove is here (design §4).
    takeInFlight(op_id)?.reject(new OperationAbortedError(op_id, 'deadline-no-kill'));
    return;
  }

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
  }
};

// Test-only accessors for the in-flight bookkeeping. Not part of the public
// contract; used to assert the kill path rejects every pending op.
export const __test = {
  inFlightSize: () => inFlight.size,
  isOffscreenClientEnabled: () => USE_OFFSCREEN_CLIENT
};
