/**
 * The two pieces of `sync-backoff` that exist for the INLINE driver (#777).
 *
 * `computeSyncBackoffMs` itself is covered through the service worker in
 * `back/sync-manager.test.ts`, which re-exports it. What is only reachable from
 * here is the pair the mobile/desktop loop needs because it sleeps out the
 * REMAINDER of a window rather than a freshly computed delay: the clamp bound
 * and the clock that remainder is measured against.
 */

import { computeSyncBackoffMs, MAX_SYNC_BACKOFF_MS, monotonicNowMs } from './sync-backoff';

describe('MAX_SYNC_BACKOFF_MS', () => {
  it('is the largest value the curve can actually produce', () => {
    // The clamp is only safe if it bounds the curve rather than sitting below
    // it: a bound under the real maximum would silently truncate a legitimate
    // late window, and one above it would let a clock anomaly through. Derived
    // from the curve here (max trip count, max jitter) so a change to the base,
    // the cap or the jitter fraction fails this instead of drifting past it.
    const worstCase = Math.max(...[1, 2, 5, 10, 50, 1_000].map(trip => computeSyncBackoffMs(trip, () => 1)));
    expect(MAX_SYNC_BACKOFF_MS).toBe(worstCase);
  });
});

describe('monotonicNowMs', () => {
  it('reads the performance clock when one is available', () => {
    const now = jest.spyOn(performance, 'now').mockReturnValue(4_242);
    expect(monotonicNowMs()).toBe(4_242);
    now.mockRestore();
  });

  it('is immune to a wall-clock step, which is the whole reason it exists', () => {
    // A deadline stored on `Date.now()` stretches by the size of a backward
    // step, and on the inline path that timer is the loop's only driver — so a
    // clock change would stop syncing rather than merely delay a probe.
    const wallClock = jest.spyOn(Date, 'now').mockReturnValue(0);
    const before = monotonicNowMs();
    wallClock.mockReturnValue(-3_600_000);
    expect(monotonicNowMs()).toBeGreaterThanOrEqual(before);
    wallClock.mockRestore();
  });
});
