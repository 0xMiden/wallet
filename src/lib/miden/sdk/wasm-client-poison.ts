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
 * bounded — the inline `syncState` has no JS-level timeout (its caller's 30s
 * timeout only stops waiting), guardian flows hold the lock across
 * timeout-less HTTP round-trips, and a cold-restore probes accounts on-chain
 * under one hold. The known legitimately UNBOUNDED waits — keystore sign
 * round-trips (user authentication) and local prove attempts (the fallback
 * when delegated proving is down) — pause the watchdog entirely via
 * `withWasmLockWatchdogPaused`, mirroring `pauseDeadline`/`resumeDeadline` in
 * `miden-client-proxy.ts`.
 */
export const WASM_LOCK_WATCHDOG_MS = 300_000;

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
 * The named error a wedged lock holder is rejected with when recovery evicts
 * it (issue #775). `reason` says which mechanism fired: `'watchdog'` (the
 * holder ran past `WASM_LOCK_WATCHDOG_MS`) or `'realm-error'` (an uncaught
 * WASM-trap-shaped error surfaced on the realm while the lock was held —
 * detection in milliseconds, `cause` carries the trap).
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

export class WasmClientPoisonedError extends Error {
  readonly reason: WasmClientPoisonReason;

  constructor(reason: WasmClientPoisonReason, cause?: unknown) {
    const detail =
      reason === 'watchdog'
        ? `held the WASM client lock past the ${WASM_LOCK_WATCHDOG_MS}ms watchdog ceiling`
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
