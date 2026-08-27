import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
  monotonicNowMs
} from 'lib/miden/sync-backoff';

/**
 * The sync fuse (#777): the realm's evidence that its WASM sync is PARKED, and the
 * standing deadline that evidence buys.
 *
 * Module-scoped, and in a module of its own rather than inside `useSyncTrigger`,
 * because the fact it records belongs to the REALM's WASM client — the dead in-flight
 * sync promise lives in the SDK's module-level map — and more than one caller drives a
 * sync against that one client. `useSyncTrigger`'s own loop is merely the loudest:
 * `syncGuardianAccounts` takes an equally long hold on the same client, on the same
 * tick, and its failures are swallowed per-account. With the ledger private to the
 * hook, those evictions were structurally invisible: a guardian wallet (the default
 * type) could park and poison the client every two minutes forever, leaking one client
 * per eviction, while the fuse sat at zero because the only counter was in a catch
 * block the guardian path never reaches.
 *
 * The state survives remounts on purpose. The hook's effect is rebuilt on every
 * `status` transition, so an idle auto-lock followed by an unlock used to throw the
 * evidence away and hand a provably parked realm back the 3s cadence, plus four more
 * two-minute evictions to re-earn a conclusion it had already reached. The breaker's
 * state stays effect-scoped, and that asymmetry is the point: a remount there
 * legitimately means the user came back and a node outage may well be over, whereas a
 * remount tells you nothing at all about a promise parked in a module the remount did
 * not touch.
 *
 * A standing deadline rather than a flag plus the breaker's window, because the two
 * must not share one field: while fused, any single non-watchdog failure re-entered the
 * breaker's arm and overwrote the fused deadline with a window at most a fifth as long,
 * so one offline blip mid-fuse cost the user the whole cadence. Kept separate, the
 * scheduler simply waits for the later of the two.
 */
let realmWatchdogEvictions = 0;
let realmFusedUntilMs: number | null = null;

/** The fused deadline, or null when the fuse has not blown. */
export function syncFuseUntilMs(): number | null {
  return realmFusedUntilMs;
}

/**
 * A sync hold on this realm's client was evicted by the watchdog.
 *
 * The one failure that proves the realm's sync is unrecoverable rather than merely
 * failing: the node accepted the request and never answered, and the SDK will hand the
 * same dead promise to every later probe, so replacing the client cannot reach it.
 *
 * @param label the caller, for the log — several loops share this ledger.
 */
export function noteSyncWatchdogEviction(label: string): void {
  realmWatchdogEvictions++;
  if (realmWatchdogEvictions < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS) return;
  if (realmFusedUntilMs === null) {
    console.warn(
      `[${label}] ${realmWatchdogEvictions} consecutive sync watchdog evictions — ` +
        "the realm's sync is parked and replacing the client cannot reach it; dropping automatic " +
        `probes to one per ${Math.round(FUSED_SYNC_PROBE_INTERVAL_MS / 60_000)} min until one succeeds (#777)`
    );
  }
  // Re-armed after EVERY qualifying failure while the evidence stands, not only after
  // the eviction that lit the fuse. "One probe per 30 min until one succeeds" is the
  // contract, and a probe that fails some other way has not succeeded — arming only on
  // the eviction let the deadline expire and the loop fall back to the breaker's much
  // shorter windows.
  //
  // A DEADLINE rather than a per-run delay, for the same reason the breaker keeps one:
  // a tick the guards skip must serve out the wait, not restart it. As a per-run delay,
  // every skipped tick re-armed the full cadence, so a user who opened the send flow
  // while fused pushed their next probe out by another half hour each time the loop
  // ticked past the guard.
  realmFusedUntilMs = monotonicNowMs() + FUSED_SYNC_PROBE_INTERVAL_MS;
}

/**
 * An automatic sync probe failed for some reason OTHER than a watchdog eviction.
 *
 * Withdraws the evidence, but only before the fuse blows. Once lit, a non-eviction
 * failure is no proof the parked sync recovered — only a SUCCESS is that — and zeroing
 * here meant one offline blip mid-fuse bought four fresh evictions, eight more minutes
 * of parked WASM, to re-reach a conclusion nothing had contradicted. While fused it
 * still re-arms the deadline, for the "until one succeeds" reason above.
 */
export function noteNonEvictionSyncFailure(): void {
  if (realmFusedUntilMs === null) {
    realmWatchdogEvictions = 0;
    return;
  }
  realmFusedUntilMs = monotonicNowMs() + FUSED_SYNC_PROBE_INTERVAL_MS;
}

/**
 * A sync went through. The only thing that clears the fuse: it proves the realm's sync
 * is not parked after all, which is the one observation the fuse is waiting for.
 */
export function noteSyncSuccess(): void {
  realmWatchdogEvictions = 0;
  realmFusedUntilMs = null;
}

/** Test-only: the module-scoped state above would otherwise leak between tests. */
export function __resetSyncFuseStateForTests(): void {
  realmWatchdogEvictions = 0;
  realmFusedUntilMs = null;
}
