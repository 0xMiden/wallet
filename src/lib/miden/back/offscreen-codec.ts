// Shared IPC codec for the offscreen-document bus (issue #260, slice 1).
//
// The offscreen prover already ships binary payloads across
// `chrome.runtime.sendMessage` as base64 because raw typed-array
// structured-clone proved unreliable ("unexpected end of file" on the
// receiver — see `offscreen-prover.ts`). Slice 1 generalizes that prove-only
// channel to a method-dispatch channel (`OFFSCREEN_CALL`) that can carry
// arbitrary WASM-client calls. This module is the single, shared definition
// of the wire format so the two ends — the SW-side `MidenClientProxy` and the
// offscreen dispatch table (`src/offscreen/main.ts`) — agree byte-for-byte.
//
// It has ZERO runtime dependencies (only `btoa`/`atob`, present in both the SW
// and offscreen-document globals) so it is safe to import from either realm. The
// imports below are TYPE-ONLY — erased at compile time, so they pull no module
// into either bundle and the zero-runtime-dependency rule still holds.

import type { ConnectivityCategory } from '../activity/connectivity-state';
import type { ITransactionStage } from '../db/types';

/** Discriminator kept on every offscreen-bound message; the offscreen listener
 * ignores anything whose `target` is not this. */
export const OFFSCREEN_TARGET = 'offscreen' as const;

/** Discriminator for the REVERSE direction (offscreen → SW). The offscreen
 * keystore's `sign` stub cannot reach the SW-resident vault directly, so a
 * mid-op sign reverses across the bus: the offscreen doc posts an
 * {@link OffscreenSignRequest} tagged for the SW, and the SW's reverse-IPC
 * handler (which gates on this target) signs and responds. Tagging it `'sw'`
 * keeps the offscreen doc's own `target === 'offscreen'` listener from ever
 * picking it up (issue #260, slice 5, design §2.3). */
export const SW_TARGET = 'sw' as const;

/** Message family for a generalized WASM-client method call. Distinct from the
 * existing `OFFSCREEN_PROVE` family, which keeps working unchanged. */
export const OFFSCREEN_CALL = 'OFFSCREEN_CALL' as const;

/** Control message family (SW → offscreen) telling the offscreen realm that the
 * saved developer endpoint override changed: re-read it from storage and drop the
 * realm's Miden client singleton, so the NEXT client is built against the new
 * endpoints. Its own family rather than an {@link OFFSCREEN_CALL} method because
 * it must NOT go through the call dispatcher — that path creates the client (with
 * the stale endpoints) before dispatching, and serializes on the WASM mutex, both
 * of which are exactly what this message exists to avoid. */
export const OFFSCREEN_RELOAD_ENDPOINTS = 'OFFSCREEN_RELOAD_ENDPOINTS' as const;

/** Message family for a mid-op sign round-trip (offscreen → SW → offscreen).
 * The offscreen client is a singleton whose `keystore.sign` cannot be re-bound
 * per call and has no access to the SW's decrypted vault, so signing reverses
 * across the bus: only raw pubkey / signing-inputs / signature BYTES cross —
 * never an un-serializable SDK handle (issue #260, slice 5, design §2). */
export const OFFSCREEN_SIGN_REQUEST = 'OFFSCREEN_SIGN_REQUEST' as const;

/** Fire-and-forget control message (offscreen → SW): the op named by `op_id` has
 * just WON the offscreen WASM mutex and is about to execute. The SW arms that
 * write's deadline HERE — at execution start — rather than at dispatch, so the
 * time an op spends QUEUED behind other ops on the single offscreen mutex is
 * off-budget and cannot false-kill a healthy write (issue #260 flip-prep #3). No
 * response is expected. */
export const OFFSCREEN_OP_STARTED = 'OFFSCREEN_OP_STARTED' as const;

/** Fire-and-forget telemetry message (offscreen → SW): the write op named by
 * `op_id` has just entered `stage` inside the offscreen realm. It carries the
 * per-step send timings PR #524 introduced across the rehost boundary: the
 * staged send stamps `executing`/`proving`/`submitting` as it runs, and the
 * generating-transaction screen derives a duration per step from those stamps.
 * The stamps are keyed by the DB ROW id, which the write DTO deliberately does
 * not carry, so the stage rides the OP id instead and the SW maps it back to
 * the row via the op-scoped callback it registered at dispatch. No response is
 * expected — unlike {@link OFFSCREEN_SIGN_REQUEST} the offscreen side must never
 * block on this, and a dropped event costs a blank duration, never a
 * transaction. */
export const OFFSCREEN_STAGE_EVENT = 'OFFSCREEN_STAGE_EVENT' as const;

/** Fire-and-forget connectivity report (offscreen → SW): the offscreen realm has
 * just observed `category` to be `active` (or not). It exists because the
 * connectivity snapshot is module-scoped — i.e. per realm — and mirrors to ONE
 * shared storage key, so two realms writing it would each blind-overwrite the
 * other's categories; the offscreen realm therefore REPORTS into the SW-owned
 * snapshot instead of writing that key itself
 * (`lib/miden/activity/connectivity-state`, `setConnectivityReporter`).
 *
 * Unlike {@link OFFSCREEN_STAGE_EVENT} it carries no `op_id`: the connectivity
 * state is realm-global, not op-scoped, so there is nothing to attribute it to.
 * Like the stage stamp, no response is expected and a dropped event must be
 * harmless — the reporting realm never de-duplicates, so it RE-SENDS the value it
 * observes, AND the SW writes each report through to the storage mirror rather than
 * de-duplicating it (see `applyConnectivityReport`). What that bounds a loss to is
 * the next report of the same kind: `proveWithFallback` sends `prover: false` after
 * every prove that succeeds on its first attempt and `prover: true` after every
 * delegated prove that fails with a transport-shaped error, so a dropped clear is
 * repaired by the next first-attempt success and a dropped mark by the next delegated
 * network failure. Either way the cost is a stale banner, never a latched wrong
 * state, and nothing downstream makes a correctness decision on it. */
export const OFFSCREEN_CONNECTIVITY_EVENT = 'OFFSCREEN_CONNECTIVITY_EVENT' as const;

/**
 * offscreen → SW: one E2E-only `[prove-timing]` breadcrumb (#718).
 *
 * Same reason connectivity is REPORTED rather than written here: this realm has no
 * `chrome.storage` of its own, and it also has no console the harness can attach to
 * — it is absent from `context.pages()` and Playwright exposes no handle to it. So a
 * write that never returns left no trace anywhere, and the artifacts could say only
 * that the row was stuck at `stage=sending`, not which call it was inside.
 *
 * The stage stamps already cross this channel and arrive reliably during exactly the
 * stall being diagnosed, which is why the markers use it too. Fire-and-forget, and
 * dispatched BEFORE the blocking call each marker announces, so the last one
 * delivered names where the realm stopped.
 */
export const OFFSCREEN_PROVE_MARKER = 'OFFSCREEN_PROVE_MARKER' as const;

/**
 * SW → offscreen request envelope (§1.1 of the design doc).
 *
 * `argsB64` carries the positional arguments, each encoded with
 * {@link encodeArg} (binary → base64 bytes, scalar → JSON). `deadline_ms` is
 * the per-op deadline the SW enforces; `null` means "no deadline".
 */
export interface OffscreenCallRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_CALL;
  op_id: string;
  method: string;
  argsB64: string[];
  deadline_ms: number | null;
}

/**
 * offscreen → SW response envelope (§1.1). Delivered via `sendResponse`.
 *
 * `resultB64` is the method's serialized result (base64) or `null` when the
 * method returned nothing (e.g. `getAccount` for an unknown id). A response of
 * `undefined` on the wire (doc closed/reaped) is treated by the SW as an
 * {@link OperationAbortedError}, and is therefore intentionally NOT part of this
 * type.
 *
 * `errorName` carries the offscreen error's `name` so the SW can rebuild an
 * error of the same TYPE rather than a bare `Error` (issue #775). Only a message
 * and an `errorCode` used to cross, which is enough for the code-driven
 * classifications but not for the ones that key off the error class: a
 * `WasmClientPoisonedError` raised by this realm's own lock recovery arrived SW
 * side as an ordinary failure, so `tryCompleteKilledConsume` skipped its node
 * adjudication and `cancelTransactionAfterPipelineStopped` cleared the
 * may-have-submitted crossing instead of recording it — letting Retry rebuild a
 * send whose abandoned offscreen op could still submit. Same reasoning as
 * {@link finishOpError}'s: the SW must not see a kill as a plain error.
 * `errorReason` carries that error's own discriminant alongside it, so the
 * rebuilt error names the mechanism that actually fired rather than guessing.
 */
export type OffscreenCallResponse =
  | { ok: true; op_id: string; resultB64: string | null; durationMs: number }
  | { ok: false; op_id: string; error: string; errorCode?: string; errorName?: string; errorReason?: string };

/**
 * SW → offscreen endpoint-override reload request. Carries no payload: the
 * override lives in extension storage, which BOTH realms read, so the message is
 * a pure "go re-read it" nudge rather than a copy of the new value.
 */
export interface OffscreenReloadEndpointsRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_RELOAD_ENDPOINTS;
}

/**
 * offscreen → SW acknowledgement of {@link OffscreenReloadEndpointsRequest},
 * delivered via `sendResponse`. `ok: true` means the realm re-read the override
 * and dropped its client singleton. As with an {@link OffscreenCallResponse}, a
 * response of `undefined` on the wire (doc closed/reaped) is not part of this
 * type — the SW treats a missing/failed ack as "not acknowledged" and moves on,
 * since a reaped document's replacement hydrates the override on its own.
 */
export type OffscreenReloadEndpointsResponse = { ok: true } | { ok: false; error: string };

/**
 * offscreen → SW reverse-IPC sign request (issue #260, slice 5, design §2.3).
 *
 * Posted from the offscreen client's `keystore.sign` stub while a write op is
 * mid-execute. `op_id` names the write op this sign belongs to (so the SW can
 * PAUSE that op's deadline for the round-trip, §2.5); `sign_id` correlates this
 * one sign to its response. Only raw bytes cross — `publicKeyB64` /
 * `signingInputsB64` are base64 of the exact `(pubkey, signingInputs)` bytes the
 * SDK handed the stub, and the SW returns the raw signature bytes. No SDK handle
 * is ever involved (contrast the `TransactionResult` result of a call).
 */
export interface OffscreenSignRequest {
  target: typeof SW_TARGET;
  type: typeof OFFSCREEN_SIGN_REQUEST;
  op_id: string;
  sign_id: string;
  publicKeyB64: string;
  signingInputsB64: string;
}

/**
 * offscreen → SW execution-start signal (issue #260 flip-prep #3). Posted from
 * inside the offscreen doc's WASM mutex, right before the op's dispatch fn runs,
 * so the SW can arm this op's write deadline at EXECUTION START rather than at
 * dispatch. Fire-and-forget — `op_id` names the op whose deadline to (re)arm; no
 * bytes, no response.
 */
export interface OffscreenOpStarted {
  target: typeof SW_TARGET;
  type: typeof OFFSCREEN_OP_STARTED;
  op_id: string;
}

/**
 * offscreen → SW per-step stage stamp (PR #524's send timings, preserved across
 * the issue #260 rehost). Posted from the offscreen `sendTransaction` dispatch's
 * `onStage` hook each time the staged execute → prove → submit pipeline advances.
 * `op_id` names the write op the stamp belongs to — the SW looks up that op's
 * registered stage callback and forwards the stamp to the transaction row.
 * Fire-and-forget: no correlation id, no response, no bytes.
 *
 * `stage` is the canonical {@link ITransactionStage} union, pulled in by a
 * TYPE-ONLY import that the compiler erases — so this module keeps its
 * zero-runtime-dependency role while staying pinned to the single source of
 * truth. (Contrast {@link OffscreenSignResponse}'s `reason`, whose four literals
 * were cheap enough to inline; duplicating the thirteen stage literals here
 * would just invite drift.)
 */
export interface OffscreenStageEvent {
  target: typeof SW_TARGET;
  type: typeof OFFSCREEN_STAGE_EVENT;
  op_id: string;
  stage: ITransactionStage;
}

/**
 * offscreen → SW connectivity report (issue #260 realm split). Posted whenever
 * the offscreen realm marks or clears a connectivity category — in practice
 * `prover`, from `proveWithFallback`'s success/failure paths around every write
 * that realm executes. The SW applies it to the single authoritative snapshot it
 * mirrors to `miden-connectivity-state`, so the two realms' observations
 * accumulate instead of overwriting each other.
 *
 * `active` is the CURRENT observed value, not a delta, and is re-sent on every
 * observation rather than only on transitions — that is what makes a dropped or
 * reordered event self-correcting, on the cadence spelled out at
 * {@link OFFSCREEN_CONNECTIVITY_EVENT}.
 *
 * `category` is the canonical `ConnectivityCategory` union via a TYPE-ONLY
 * import, for the same reason `stage` is — one source of truth, no drift.
 */
export interface OffscreenConnectivityEvent {
  target: typeof SW_TARGET;
  type: typeof OFFSCREEN_CONNECTIVITY_EVENT;
  category: ConnectivityCategory;
  active: boolean;
}

/**
 * One `[prove-timing]` breadcrumb on its way to the SW-owned storage key.
 *
 * `line` is the already-formatted marker, `ts` the epoch ms it was recorded at —
 * stamped in the recording realm rather than on arrival, since the point of the
 * trail is when the realm reached each call, not when the message was drained.
 */
export interface OffscreenProveMarkerEvent {
  target: typeof SW_TARGET;
  type: typeof OFFSCREEN_PROVE_MARKER;
  ts: number;
  line: string;
}

/**
 * SW → offscreen reverse-IPC sign response, delivered via `sendResponse`.
 *
 * On failure `reason` carries the SW-classified sign-callback reason (the same
 * union as `transaction/sign-callback.ts`'s `SignCallbackReason`; kept as a
 * string literal here to preserve this module's zero-runtime-dependency role).
 * The offscreen stub throws on `ok:false` (so the SDK's execute fails); the
 * classified reason is authoritative on the SW side, where it is recorded so a
 * locked-mid-sign consume DEFERS rather than Fails (issue #313, design §2.6).
 */
export type OffscreenSignResponse =
  | { ok: true; sign_id: string; signatureB64: string }
  | { ok: false; sign_id: string; error: string; reason?: 'locked' | 'rejected' | 'not_found' | 'internal' };

/**
 * Chunked base64 encoder for binary payloads. Chunked to stay under the
 * argument-count limit of `String.fromCharCode.apply` on large arrays; `0x8000`
 * keeps each call well under any sane limit. Mirrors the encoder the prove path
 * has shipped since the offscreen prover landed.
 */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

/** Inverse of {@link bytesToB64}. */
export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Encode a single positional argument to a self-describing wire string (§1.4).
 *
 * The result is tagged so the decoder is unambiguous:
 *   - `b:<base64>` — a `Uint8Array`/`ArrayBuffer`, base64 of the raw bytes.
 *   - `s:<json>`   — any scalar / plain-JSON value (`getAccount`'s string id is
 *     the only shape slice 1 uses).
 *
 * Binary is kept as base64 (never structured-cloned) for the same reason the
 * prove path does — see the module header.
 */
export function encodeArg(value: unknown): string {
  if (value instanceof Uint8Array) return `b:${bytesToB64(value)}`;
  if (value instanceof ArrayBuffer) return `b:${bytesToB64(new Uint8Array(value))}`;
  // `?? null` so `undefined` (which `JSON.stringify` would drop) round-trips
  // deterministically as JSON `null`.
  return `s:${JSON.stringify(value ?? null)}`;
}

/**
 * The positional argument list of the `guardianPipeline` OFFSCREEN_CALL, named
 * once so the SW-side packer and the offscreen-side dispatch are checked
 * against the SAME declaration instead of two hand-written parameter lists in
 * different modules (#784).
 *
 * Worth naming for this op specifically: the dispatch table erases its entries
 * to `(client, ...args: any[])`, so a dropped or reordered slot compiles
 * cleanly, and dropping the anchor slot silently reinstates the unanchored
 * execute that #784 exists to remove — a regression that shows up only once
 * the chain advances mid-round-trip.
 *
 * The two optional slots are `| null`, not `| undefined`: the array is always
 * four elements and {@link encodeArg} maps an absent value to JSON `null`, so
 * `undefined` is not something this boundary can deliver. Both receivers select
 * on truthiness, which covers either.
 *
 * `trBytes` MUST stay a top-level element — {@link encodeArg} only recognizes a
 * `Uint8Array` at the top level, and a nested one would be JSON-mangled,
 * destroying the advice map that carries the co-signatures.
 */
export type GuardianPipelineArgs = [
  accountId: string,
  trBytes: Uint8Array,
  delegateTransaction: boolean | null,
  chainAnchorB64: string | null
];

/** Inverse of {@link encodeArg}. */
export function decodeArg(encoded: string): unknown {
  const tag = encoded.slice(0, 2);
  const body = encoded.slice(2);
  if (tag === 'b:') return b64ToBytes(body);
  if (tag === 's:') return JSON.parse(body);
  throw new Error(`decodeArg: unrecognized argument tag in "${encoded.slice(0, 8)}…"`);
}

/**
 * The DISTINGUISHING `name` of a thrown value, for
 * `OffscreenCallResponse.errorName` — see that field for why the class has to
 * cross at all.
 *
 * A plain `'Error'` reports `undefined`: it says nothing the SW can act on, and
 * omitting it keeps the reply envelope byte-identical to what an ordinary
 * failure produced before this field existed. Only a named subclass is worth
 * putting on the wire.
 */
export function errorNameOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  // The read is guarded because this runs inside the offscreen catch that builds
  // the reply: `name` can be an accessor on a foreign object, and a throw here
  // would escape before `sendResponse`, leaving the SW waiting on its deadline
  // instead of getting the failure it is owed.
  let name: unknown;
  try {
    name = Reflect.get(error, 'name');
  } catch {
    return undefined;
  }
  if (typeof name !== 'string' || name.length === 0 || name === 'Error') return undefined;
  return name;
}

/**
 * Rejection raised on the SW side when an offscreen op is torn down by the
 * per-op deadline kill (§3): the SW `closeDocument()`s the offscreen realm —
 * taking the wedged WASM call down with it — and rejects the in-flight op(s)
 * with this error. It is a *retryable* classification (§3.5): the op never
 * observably completed, so the caller may re-queue it.
 */
export class OperationAbortedError extends Error {
  readonly op_id: string;
  readonly reason: string;

  constructor(op_id: string, reason: string) {
    super(`Offscreen operation ${op_id} aborted (${reason})`);
    this.name = 'OperationAbortedError';
    this.op_id = op_id;
    this.reason = reason;
  }
}

/**
 * Narrow an unknown thrown value to an {@link OperationAbortedError} (a
 * deadline/close offscreen kill). Matches by prototype first and falls back to
 * the `name` tag so a value that lost its prototype (e.g. re-thrown across a
 * boundary) is still recognized. Used by the transaction-kill classifier to tell
 * a wedge-kill apart from other failures.
 */
export function isOperationAbortedError(error: unknown): error is OperationAbortedError {
  return (
    error instanceof OperationAbortedError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'OperationAbortedError')
  );
}
