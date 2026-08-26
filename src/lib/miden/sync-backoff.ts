/**
 * Shared sync circuit-breaker parameters (gap 14, issue #777).
 *
 * Two drivers, one set of parameters: the extension service worker's `doSync`
 * (`back/sync-manager.ts`) skips attempts while inside the backoff window, and
 * the mobile/desktop inline loop (`front/useSyncTrigger.ts`) reschedules itself
 * onto the remainder of that window. Both trip on the same streak
 * (`MAX_CONSECUTIVE_SYNC_FAILURES`) and draw every window from the same curve
 * (`computeSyncBackoffMs`), so neither platform can quietly end up hammering a
 * rate-limiting node harder than the other — the suspected #777 trigger.
 *
 * What is deliberately NOT shared is the RE-TRIP rule, so don't read the two as
 * one state machine. The SW zeroes its failure streak when it opens a window,
 * so it takes another full streak to escalate; the inline loop leaves the streak
 * standing, so every further failed probe escalates immediately. The inline loop
 * is therefore the stricter of the two — one probe per window, doubling each
 * time — which is the right bias on the platform where the sync loop is the
 * only sync driver and a wedged hold blocks the whole app's WASM access.
 *
 * Both DO share the clock (`monotonicNowMs`) and for a plainer reason than the
 * shape of their drivers suggests. It is tempting to argue that the SW can keep
 * `Date.now()` because it only reads the deadline as a skip check while its
 * alarm keeps firing — but a backward clock step holds that check true for the
 * size of the step, and an attempt skipped is an attempt not made, so the
 * user-visible outcome is the same stalled wallet the inline loop would get.
 * The inline loop needs one extra guard the SW does not, though: it SLEEPS the
 * remainder on the timer that is its only driver, so that remainder is clamped
 * to `MAX_SYNC_BACKOFF_MS` and cannot become an arbitrarily long stall.
 *
 * This module is dependency-free so the frontend hook can import it without
 * dragging in the service worker's vault/intercom graph.
 */

/**
 * Consecutive sync failures before the circuit breaker trips (and before the
 * "cannot reach the Miden node" banner is surfaced — #273/#596): a lone slow
 * or blipped sync must neither flap the banner nor cost the user the fast
 * 3s cadence.
 */
export const MAX_CONSECUTIVE_SYNC_FAILURES = 3;

/**
 * Consecutive sync WATCHDOG evictions before the inline loop stops probing on
 * its own (issue #777).
 *
 * A watchdog eviction on the sync path is not just a failure, it is proof that
 * the realm's sync is unrecoverable in-process: the node accepted the request
 * and never answered, and the SDK memoises that never-settling promise in a
 * module-level map the wallet cannot reach, so every later `syncState()` joins
 * it and parks for a full ceiling too. Each such cycle costs two minutes of the
 * whole app's WASM access plus a client rebuild. The breaker spaces the cycle
 * out; only this ends it.
 *
 * Deliberately one MORE than the failure streak rather than the same count.
 * Giving up needs strictly more evidence than backing off does: at exactly the
 * streak the fuse would blow on the third fast probe, before the breaker's first
 * window had ever been served — so the loop would never actually test the one
 * hypothesis that matters, that waiting does not help. At streak + 1 it opens a
 * window, waits it out, probes again, and only then concludes. One eviction can
 * be a slow node having a bad minute (the recorded healthy worst case is 30-60s
 * on mobile, well inside the ceiling); four in a row, spanning a served backoff
 * window, is not.
 */
export const MAX_CONSECUTIVE_WATCHDOG_EVICTIONS = MAX_CONSECUTIVE_SYNC_FAILURES + 1;

// Circuit-breaker backoff: EXPONENTIAL with jitter (gap 14). Each consecutive
// trip roughly doubles the wait (capped at BACKOFF_MAX_MS) so a sustained outage
// is probed ever less aggressively instead of hammered every 30s; the jitter
// de-syncs many wallets from all probing in lockstep. A successful sync resets
// the trip count back to the base interval.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Backoff (ms) for the Nth consecutive breaker trip (1-based): base for the
 * first trip, doubling each subsequent trip up to the cap, plus 0–20% jitter.
 * Pure + injectable RNG so it's unit-testable.
 */
export function computeSyncBackoffMs(tripCount: number, rand: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, tripCount - 1), BACKOFF_MAX_MS);
  return Math.round(exp + exp * 0.2 * rand());
}

/**
 * The largest value `computeSyncBackoffMs` can return (the cap plus its full
 * jitter). A driver that waits out the REMAINDER of a window rather than a
 * freshly computed delay needs this: the remainder is arithmetic on a clock, and
 * clamping it to the curve's own maximum keeps a clock anomaly from turning a
 * bounded backoff into an unbounded stall.
 */
export const MAX_SYNC_BACKOFF_MS = Math.round(BACKOFF_MAX_MS * 1.2);

/**
 * Monotonic-where-available clock for backoff deadlines, mirroring the WASM
 * lock's `monotonicNow`. `Date.now()` is wall-clock: an NTP correction, a
 * user clock change or a mobile resume can step it, and a deadline stored
 * against it then expires early or — worse for a driver that sleeps out the
 * remainder — stretches by the size of the step.
 *
 * Note that 0 is a VALID stamp on this clock (it is the time origin), so a
 * caller must use `null`/`undefined` for "no deadline", never 0.
 */
export function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
