/**
 * Tracks wall-clock time the document spends hidden (app backgrounded / the
 * WebView not visible), so wall-clock "stuck transaction" timers don't count
 * time the platform froze our JS from running.
 *
 * On Android (Capacitor WebView) the main-thread JS is frozen while the app is
 * backgrounded, yet `Date.now()` still advances in real time. A delegated
 * (remote) prove that merely waited out a background stretch is NOT stuck —
 * counting that frozen time against `MAX_WAIT_BEFORE_CANCEL` reaps it as a
 * false `REMOTE_PROVER_TIMEOUT` when the app resumes (issue #473). The stuck
 * reaper subtracts the hidden time reported here so only foreground ("active")
 * processing time counts toward the threshold.
 *
 * Desktop deliberately does NOT use this: extension background tabs keep
 * running, so on desktop hidden time IS processing time (see the mobile-only
 * guard at the call site in `cancel.ts`).
 */

interface HiddenInterval {
  /** epoch ms the document became hidden */
  start: number;
  /** epoch ms the document became visible again */
  end: number;
}

// Completed hidden intervals, plus `hiddenSince` for the interval still open
// while the document is hidden right now.
let hiddenIntervals: HiddenInterval[] = [];
let hiddenSince: number | null = null;
let installed = false;

// Bound memory by COUNT, not by age. An age-based window could drop an interval
// that is still inside a live tx's [processingStartedAt, now] span — an
// in-progress tx's wall-clock age is effectively unbounded on mobile (it is
// reaped on ACTIVE time, which accrues arbitrarily slowly across many
// background stretches), so dropping an old-but-still-relevant interval would
// UNDER-count hidden time and reap exactly the long-backgrounded prove this
// exists to protect (#473 review). A count cap can only lose the very OLDEST
// intervals, and 1000 background flaps for one tx is far beyond any real
// pattern; each interval is a couple of numbers, so this is trivially small.
const MAX_HIDDEN_INTERVALS = 1000;

/**
 * Pure: total ms of `[since, now]` that overlaps the given hidden intervals
 * (including the still-open interval when `openHiddenSince` is set). Exported
 * for testing; callers use {@link hiddenSecondsSince}.
 */
export function hiddenMsWithin(
  intervals: ReadonlyArray<HiddenInterval>,
  openHiddenSince: number | null,
  sinceMs: number,
  nowMs: number
): number {
  const overlap = (start: number, end: number): number => Math.max(0, Math.min(end, nowMs) - Math.max(start, sinceMs));

  let total = 0;
  for (const iv of intervals) total += overlap(iv.start, iv.end);
  if (openHiddenSince !== null) total += overlap(openHiddenSince, nowMs);
  return total;
}

/**
 * Whole seconds the document has spent hidden since `sinceSeconds` (an epoch
 * *seconds* timestamp, matching `Transaction.processingStartedAt`).
 */
export function hiddenSecondsSince(sinceSeconds: number, nowMs: number = Date.now()): number {
  const ms = hiddenMsWithin(hiddenIntervals, hiddenSince, sinceSeconds * 1000, nowMs);
  return Math.floor(ms / 1000);
}

function pruneOldIntervals(): void {
  if (hiddenIntervals.length > MAX_HIDDEN_INTERVALS) {
    hiddenIntervals = hiddenIntervals.slice(-MAX_HIDDEN_INTERVALS);
  }
}

/**
 * Install the `visibilitychange` listener that records hidden intervals.
 * Idempotent — safe to call more than once. Call once at mobile startup.
 */
export function initBackgroundTimeTracking(): void {
  if (installed) return;
  /* istanbul ignore next -- defensive no-DOM/SSR guard; unreachable under the jsdom test env */
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  installed = true;

  // Seed the open interval if we start up already hidden (e.g. a background
  // relaunch): there is no visibilitychange→hidden event to open it, so without
  // this the [startup, first-visible] stretch would be lost and hidden time
  // under-counted (#473 review).
  if (document.hidden) hiddenSince = Date.now();

  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.hidden) {
      if (hiddenSince === null) hiddenSince = now;
    } else if (hiddenSince !== null) {
      hiddenIntervals.push({ start: hiddenSince, end: now });
      hiddenSince = null;
      pruneOldIntervals();
    }
  });
}

/** Test-only: clear accumulated state and the install flag. */
export function __resetBackgroundTimeForTest(): void {
  hiddenIntervals = [];
  hiddenSince = null;
  installed = false;
}
