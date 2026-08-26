/**
 * Shared sync circuit-breaker parameters (gap 14, issue #777).
 *
 * One state machine, two drivers: the extension service worker's `doSync`
 * (`back/sync-manager.ts`) skips attempts while inside the backoff window, and
 * the mobile/desktop inline loop (`front/useSyncTrigger.ts`) stretches its
 * self-scheduling delay to the same window. Both must trip on the same streak
 * and back off on the same schedule, or the two platforms drift apart in how
 * hard they hammer a rate-limiting node — the suspected #777 trigger. This
 * module is dependency-free so the frontend hook can import it without
 * dragging in the service worker's vault/intercom graph.
 */

/**
 * Consecutive sync failures before the circuit breaker trips (and before the
 * "cannot reach the Miden node" banner is surfaced — #273/#596): a lone slow
 * or blipped sync must neither flap the banner nor cost the user the fast
 * 3s cadence.
 */
export const MAX_CONSECUTIVE_SYNC_FAILURES = 3;

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
