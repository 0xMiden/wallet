/**
 * The watchdog ceiling and the named recovery error for a wedged WASM client
 * lock (issue #775). These live in their own dependency-free module — NOT in
 * `miden-client.ts` — because that module sits in an import cycle
 * (`miden-client` ⇄ `miden-client-interface` via `speculation-manager`), and a
 * `const`/`class` export is TDZ-bound during a cycle's partial initialization:
 * any consumer that touches the namespace mid-cycle (e.g. a jest
 * `requireActual` spread) would throw "Cannot access before initialization".
 * `miden-client.ts` re-exports both, importing this module before the
 * cycle-forming import so the bindings are always initialized first.
 */

/**
 * Ceiling on how long a single `withWasmClientLock` holder may run before the
 * watchdog treats it as wedged and recovers (issue #775). A WebAssembly trap
 * aborts the wasm-bindgen future WITHOUT settling its JS promise, so the
 * holder's `finally` never runs and every later WASM operation queues forever.
 *
 * 5 minutes — a generous last-resort backstop (the same order as the proxy's
 * `CRITICAL_DISPATCH_BACKSTOP_MS`), NOT a performance bound; the realm 'error'
 * listener catches an actual trap in milliseconds. Generous because evicting a
 * holder whose operation is merely SLOW is worse than waiting: the abandoned
 * operation is not cancelled, and several un-paused holds are not tightly
 * bounded — guardian flows hold the lock across timeout-less HTTP round-trips,
 * and a cold-restore probes accounts on-chain under one hold. (Pure-sync holds
 * used to be on this list, and were the #777 freeze; they now carry
 * `WASM_LOCK_SYNC_WATCHDOG_MS` instead. The service worker's sync hold is the
 * one that did NOT need converting, and not because of this backstop: its own
 * 30s `withTimeout` rejects the lock callback, so `withWasmClientLock`'s
 * `finally` releases the mutex at 30s — a tighter bound than any watchdog
 * ceiling. What survives that release is the SDK's module-level in-flight sync,
 * which no ceiling on this side reaches either way.) The known legitimately
 * UNBOUNDED waits — keystore sign
 * round-trips (user authentication) and local prove attempts (the fallback
 * when delegated proving is down) — relax the watchdog to
 * `WASM_LOCK_PAUSED_WATCHDOG_MS` via `withWasmLockWatchdogPaused`. They do NOT
 * switch it off: that made the backstop optional, which is the pre-#775 wedge
 * reached through the fix's own escape hatch.
 */
export const WASM_LOCK_WATCHDOG_MS = 300_000;

/**
 * The watchdog ceiling for a lock hold whose whole job is a chain sync
 * (issue #777). Passed as `withWasmClientLock`'s `watchdogMs` by the sync-shaped
 * call sites: the mobile/desktop idle loop and the two guardian `syncState` holds
 * directly, and everything behind `syncUnderBoundedLock` (the transaction
 * pipeline's pre-flight sync, the two landed-verification probes, the note-import
 * queue's trailing sync) — plus the note import itself, which is the same shape:
 * an RPC under a hold. Their SDK call carries no transport deadline on wasm32
 * (the wasm `ApiClient` drops its `timeout_ms`), so a parked gRPC-web fetch
 * otherwise wedges the lock until the 5-minute last resort.
 *
 * 2 minutes: well above both the 5-25s slow-testnet syncs the SW timeout
 * comment records and the 30-60s holds observed on mobile, and the same order
 * as `DELEGATED_PROVE_TIMEOUT_MS` — a backstop against a sync that has stopped
 * answering, NOT a latency target. Expiry is a real eviction (the client is
 * replaced), so firing on a merely-slow sync costs a client rebuild; firing
 * late merely leaves the wallet lockless a little longer. On the observed
 * freeze cadence (a 3s loop), 2 minutes still cuts recovery from 5 minutes to
 * 2 while keeping a healthy margin over every recorded legitimate sync.
 *
 * What this ceiling buys, precisely: the MUTEX back, not the sync. The SDK
 * memoises an in-flight sync in a module-level map keyed by database name and
 * serialises it under a same-keyed lock, and neither is reachable from the
 * wallet's client singleton — so replacing the client does not free a sync that
 * never answered, and each later `syncState()` joins the same dead promise.
 * Recovering the mutex is still the difference between #777's frozen wallet and
 * a working one, because balance reads, sends and claims all queue on the mutex
 * and none of them is the sync. Full sync recovery needs the upstream
 * miden-client fix arming the transport deadline the wasm `ApiClient` currently
 * drops; until then the exponential breaker is what keeps the residual
 * evict-and-rebuild cycle from running at the 3s cadence.
 */
export const WASM_LOCK_SYNC_WATCHDOG_MS = 120_000;

/**
 * The ceiling that applies while a hold's watchdog is PAUSED (issue #775).
 *
 * A pause used to stop the clock outright, which quietly made the backstop
 * optional: the two paused waits (a keystore sign, a local prove) are also
 * where a trap is most likely, and a trap the realm listener cannot see —
 * the SDK's method worker swallows it into a never-settling request, and
 * JavaScriptCore may deliver it as a rejection rather than an `error` event —
 * then wedges the lock with nothing left to recover it. That is the exact
 * pre-#775 failure mode, reachable through the fix's own escape hatch.
 *
 * 30 minutes: far beyond any real sign prompt or local prove (a prove is
 * seconds, and the proxy's own 90s write deadline bounds the Chrome path), so
 * it cannot fire on a merely-slow wait, while still bounding the wedge. An
 * eviction at this ceiling is not free — the abandoned operation is not
 * cancelled, so a send is recorded as possibly-submitted and Retry refuses it —
 * but a permanently frozen client is strictly worse, and it strands that same
 * row anyway.
 */
export const WASM_LOCK_PAUSED_WATCHDOG_MS = 1_800_000;

/**
 * One-shot finishing slice for a hold whose normal budget ran out inside a
 * pause bracket (issue #775).
 *
 * The normal ceiling is charged against time the hold spent RUNNING, so a hold
 * that has already used its budget across several pause brackets would
 * otherwise be re-armed at (or below) zero and evicted the instant its last
 * bracket closes — killing a flow at the one moment it is most likely to be
 * finishing legitimate work. 30 seconds is long enough for a post-sign submit
 * or apply to complete and short enough to keep the bound meaningful.
 *
 * NOT a standing floor, despite the name: it is granted once per hold and
 * credited to the hold's ledger (see `LockHolder.graceUsed` and
 * `armWatchdogFor`), so later re-arms see only what is left of it. Granting it
 * at every bracket close would let a loop of brackets renew it forever, which
 * is the unbounded-unwatched-hold case `unpausedElapsedMs` exists to close.
 */
export const WASM_LOCK_MIN_WATCHDOG_MS = 30_000;

/**
 * Realm-local count of how many times the WASM client under this realm has been
 * replaced by lock recovery (issue #775).
 *
 * The `onWasmClientPoisoned` listener in `miden-client.ts` is the right tool for
 * a module that must DROP a resource the instant recovery fires. A module that
 * only needs to notice staleness on next access is better served reading this
 * counter, and deliberately does not import `miden-client` to do it: that module
 * pulls in the whole SDK, so an eager `onWasmClientPoisoned(...)` at import time
 * makes every consumer's module graph — and every test double of it — depend on
 * the hook existing. This counter lives in the dependency-free module for the
 * same reason the error class does.
 *
 * Realm-local, like the listener set: it counts recoveries this realm performed.
 */
let generation = 0;

/**
 * Called once per client REPLACEMENT, from whichever singleton method performed
 * it — not only from recovery. An endpoint change replaces the client too, and a
 * cache keyed on the old one is just as stale either way.
 */
export function bumpWasmClientGeneration(): void {
  generation++;
}

/** Read the current generation; compare a later read to detect a recovery. */
export function wasmClientGeneration(): number {
  return generation;
}

/** Which mechanism evicted the holder. See {@link WasmClientPoisonedError}. */
export type WasmClientPoisonReason = 'watchdog' | 'realm-error';

/** Narrow an untrusted string (e.g. off the offscreen wire) to a known reason. */
export function isWasmClientPoisonReason(value: unknown): value is WasmClientPoisonReason {
  return value === 'watchdog' || value === 'realm-error';
}

/**
 * Error names allowed into the message. Wide enough to keep the log readable
 * (the trap's class is the single most useful token) and narrow enough that no
 * attacker- or SDK-controlled string can ride in.
 */
const SAFE_CAUSE_NAMES: ReadonlySet<string> = new Set([
  'RuntimeError',
  'CompileError',
  'LinkError',
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError'
]);

function causeLabel(cause: unknown): string {
  if (!(cause instanceof Error)) return 'non-error value';
  return SAFE_CAUSE_NAMES.has(cause.name) ? cause.name : 'unrecognized error name';
}

/**
 * The named error a wedged lock holder is rejected with when recovery evicts
 * it (issue #775). `reason` says which mechanism fired: `'watchdog'` (the holder
 * ran past whatever ceiling its pause state called for — see `armWatchdogFor`)
 * or `'realm-error'` (an uncaught WASM-trap-shaped error surfaced on the realm
 * while the lock was held — detection in milliseconds, `cause` carries the trap).
 *
 * The message is a CLOSED SET of wallet-authored text. It deliberately does not
 * interpolate the cause's message, only the cause's `name`, which is checked
 * against a small allow-list before use. The transaction pipeline is full of
 * classifiers that pattern-match error TEXT and then decide whether money
 * moved, and several of them flatten the whole `cause` chain: the funds-relevant
 * one is `isLockedError` ("wallet is locked | vault is null/locked/unavailable |
 * not initialized"), whose verdict REQUEUES the row on the argument that a
 * locked vault is strictly pre-submit. That argument is false for an eviction —
 * the abandoned pipeline can still submit — so a trap whose text happened to
 * contain "not initialized" (the SDK's own "Client not initialized" is exactly
 * that shape) would have requeued a send into a second payment. Keeping the
 * foreign text off `message` closes that whole class rather than one classifier.
 * The trap itself is not lost: it stays on `cause`, which is what the recovery
 * `console.error` and the devtools cause chain print.
 */
export class WasmClientPoisonedError extends Error {
  readonly reason: WasmClientPoisonReason;

  constructor(reason: WasmClientPoisonReason, cause?: unknown) {
    const detail =
      reason === 'watchdog'
        ? // No figure: the ceiling actually applied depends on how much of the
          // hold was spent inside a pause bracket, so naming one constant here
          // would misreport most evictions. The recovery `console.error` is
          // where the live numbers belong.
          'held the WASM client lock past its watchdog ceiling'
        : `uncaught realm error while holding the WASM client lock (cause: ${causeLabel(cause)}; see the cause chain)`;
    super(`WASM client poisoned (${reason}): ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'WasmClientPoisonedError';
    this.reason = reason;
  }
}

/**
 * Narrow an unknown thrown value to a {@link WasmClientPoisonedError}. Matches
 * by prototype first and falls back to the `name` tag, mirroring
 * `isOperationAbortedError` in `offscreen-codec.ts` — a lock-recovery eviction
 * means "the operation was killed from outside with the outcome unknown", so
 * the transaction pipeline's kill classifiers treat both alike.
 */
export function isWasmClientPoisonedError(error: unknown): error is WasmClientPoisonedError {
  return (
    error instanceof WasmClientPoisonedError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'WasmClientPoisonedError')
  );
}

/**
 * Read the eviction mechanism off a value already identified as a poison error,
 * without ever letting a property access throw.
 *
 * For the offscreen catch that builds the IPC failure reply: everything there
 * runs on a value of unknown provenance, and a throwing accessor would escape
 * before `sendResponse`, leaving the SW waiting out its deadline instead of
 * getting the failure it is owed. Same argument as `errorNameOf`'s guarded read.
 */
export function poisonReasonOf(error: unknown): WasmClientPoisonReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  let reason: unknown;
  try {
    reason = Reflect.get(error, 'reason');
  } catch {
    return undefined;
  }
  return isWasmClientPoisonReason(reason) ? reason : undefined;
}

/**
 * Whether a failure is "the sync itself was evicted for overrunning its
 * ceiling". One hit can still be a merely slow sync; what it identifies is the
 * shape that REPEATS into a sync parked on a promise no client replacement can
 * reach, which is why four of them light the fuse and one only raises the banner
 * (see {@link WASM_LOCK_SYNC_WATCHDOG_MS} and
 * {@link MAX_CONSECUTIVE_WATCHDOG_EVICTIONS}).
 *
 * Named here rather than open-coded at its two call sites in `useSyncTrigger`
 * (raise the reachability banner, blow the probe fuse), because both rest on
 * that same single fact and nothing would otherwise carry a change to it across
 * modules. A `realm-error` eviction deliberately does NOT qualify: its client is
 * replaced in milliseconds, so nothing is parked.
 */
export function isSyncWatchdogEviction(error: unknown): boolean {
  return isWasmClientPoisonedError(error) && poisonReasonOf(error) === 'watchdog';
}
