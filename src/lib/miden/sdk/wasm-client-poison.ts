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
 * The named error a wedged lock holder is rejected with when recovery evicts
 * it (issue #775). `reason` says which mechanism fired: `'watchdog'` (the
 * holder ran past `WASM_LOCK_WATCHDOG_MS`) or `'realm-error'` (an uncaught
 * WASM-trap-shaped error surfaced on the realm while the lock was held —
 * detection in milliseconds, `cause` carries the trap). The message must never
 * match `isLockedError`'s locked-vault patterns, or a poisoned write would be
 * requeued forever instead of failing loudly.
 */
/** Which mechanism evicted the holder. See {@link WasmClientPoisonedError}. */
export type WasmClientPoisonReason = 'watchdog' | 'realm-error';

/** Narrow an untrusted string (e.g. off the offscreen wire) to a known reason. */
export function isWasmClientPoisonReason(value: unknown): value is WasmClientPoisonReason {
  return value === 'watchdog' || value === 'realm-error';
}

export class WasmClientPoisonedError extends Error {
  readonly reason: WasmClientPoisonReason;

  constructor(reason: WasmClientPoisonReason, cause?: unknown) {
    const detail =
      reason === 'watchdog'
        ? `held the WASM client lock past the ${WASM_LOCK_WATCHDOG_MS}ms watchdog ceiling`
        : `uncaught realm error while holding the WASM client lock: ${cause instanceof Error ? cause.message : String(cause)}`;
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
