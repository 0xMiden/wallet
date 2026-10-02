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
 *
 * The same listener drives a monotonic FOREGROUND clock, `foregroundNow`, and
 * `setForegroundTimeout` on it: the deadlines that bound an in-flight delegated
 * prove read it, so a background stretch cannot expire them on resume (#473).
 * Until tracking is initialised it equals `performance.now()`, so the extension
 * and desktop, which never initialise it, keep plain monotonic time.
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

// The same stretches on the monotonic clock, for `foregroundNow`: the total of
// the closed ones and the start of the open one. Kept apart from the epoch-ms
// intervals above, which `Date.now()` corrections can skew, so the two clocks
// never mix.
let hiddenMonoTotalMs = 0;
let hiddenMonoSince: number | null = null;

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

/** `performance.now()`, or `Date.now()` where the timing API is missing. */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Milliseconds of foreground time on a monotonic clock: `performance.now()`
 * minus every hidden stretch, the open one included, so it stands still while
 * the document is hidden.
 */
export function foregroundNow(): number {
  const now = monotonicNow();
  const open = hiddenMonoSince === null ? 0 : now - hiddenMonoSince;
  return now - hiddenMonoTotalMs - open;
}

/**
 * Run `callback` once `ms` of foreground time has passed; returns a cancel
 * function.
 *
 * A frozen WebView runs an overdue `setTimeout` the moment it resumes, so a
 * fire never calls back on trust: it re-reads the foreground clock and re-arms
 * for what is left. Either order of that fire and the `visible` event is safe,
 * because until the event is handled the stretch is still open and counts as
 * hidden.
 */
export function setForegroundTimeout(callback: () => void, ms: number): () => void {
  const startedAt = foregroundNow();
  let timer: ReturnType<typeof setTimeout>;
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      const leftMs = ms - (foregroundNow() - startedAt);
      if (leftMs > 0) arm(leftMs);
      else callback();
    }, delayMs);
  };
  arm(ms);
  return () => clearTimeout(timer);
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
  if (document.hidden) {
    hiddenSince = Date.now();
    hiddenMonoSince = monotonicNow();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
}

// Named so the test reset can remove it: jsdom's document outlives a test, and
// a listener left on it would keep writing into the next test's clock.
function onVisibilityChange(): void {
  const now = Date.now();
  const monoNow = monotonicNow();
  if (document.hidden) {
    if (hiddenSince === null) hiddenSince = now;
    if (hiddenMonoSince === null) hiddenMonoSince = monoNow;
    return;
  }
  if (hiddenSince !== null) {
    hiddenIntervals.push({ start: hiddenSince, end: now });
    hiddenSince = null;
    pruneOldIntervals();
  }
  if (hiddenMonoSince !== null) {
    hiddenMonoTotalMs += monoNow - hiddenMonoSince;
    hiddenMonoSince = null;
  }
}

/** Test-only: clear accumulated state and the install flag. */
export function __resetBackgroundTimeForTest(): void {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  hiddenIntervals = [];
  hiddenSince = null;
  hiddenMonoTotalMs = 0;
  hiddenMonoSince = null;
  installed = false;
}
