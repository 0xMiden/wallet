/**
 * Two clocks for time the app spends in the background, kept by one
 * `visibilitychange` listener that mobile startup installs.
 *
 * HIDDEN time, on the wall clock: the epoch-ms stretches the document spends
 * hidden (app backgrounded / the WebView not visible). A delegated (remote)
 * prove that merely waited out a background stretch is NOT stuck, yet
 * `Date.now()` advances through it, so counting it against
 * `MAX_WAIT_BEFORE_CANCEL` reaps the prove as a false `REMOTE_PROVER_TIMEOUT`
 * on resume (issue #473). The stuck reaper subtracts the hidden time reported
 * here so only foreground ("active") processing time counts toward the
 * threshold. Desktop deliberately does NOT use this: extension background tabs
 * keep running, so on desktop hidden time IS processing time (see the
 * mobile-only guard at the call site in `cancel.ts`).
 *
 * RUNNING time, on the monotonic clock: `runningNow` is `performance.now()`
 * minus the stretches the platform froze our JS, and `setRunningTimeout` runs
 * on it, so a freeze cannot expire the deadlines that bound an in-flight
 * delegated prove, or the WASM lock watchdog, on resume (#473). Hidden is not
 * frozen: a hidden WebView may keep running JS (Android, Capacitor
 * KeepRunning), and there these deadlines must still fire on time, so a freeze
 * is measured rather than assumed from visibility (see `markNow`): it is a
 * silence longer than the hidden pulse can explain, 12 s in the first 5 minutes
 * hidden and 75 s after that, once Chrome's intensive throttling may slow a
 * hidden page's timers to one wake-up a minute. Until tracking is initialised
 * it equals `performance.now()`, so the extension and desktop, which never
 * initialise it, keep plain monotonic time.
 *
 * The visible event is not guaranteed, so any read that finds the document
 * visible ends the hidden stretch on both clocks (see `endHiddenStretch`).
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

// Running time, on the monotonic clock and kept apart from the epoch-ms
// intervals above, which `Date.now()` corrections can skew: the frozen total,
// the last liveness mark (when the clock was last read, and whether the
// document was hidden then), when the current hidden stretch began, and the
// pulse that reads the clock while hidden.
let frozenTotalMs = 0;
let lastMarkAt: number | null = null;
let lastMarkHidden = false;
let hiddenStartedAt: number | null = null;
let pulse: ReturnType<typeof setInterval> | null = null;

/** How often the clock is read while the document is hidden. */
const RUNNING_PULSE_MS = 5_000;

// Two pulse periods plus slack: until throttling can apply, a hidden page's
// pulse runs on time, so any longer silence is a freeze.
const EARLY_FROZEN_GAP_MS = 12_000;

// Chrome's intensive throttling slows the timers of a page hidden this long to
// one wake-up a minute.
const THROTTLED_AFTER_HIDDEN_MS = 300_000;

// Above that one wake-up a minute, so throttled but running JS is never
// counted as frozen.
const FROZEN_GAP_MS = 75_000;

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
 * *seconds* timestamp, matching `Transaction.processingStartedAt`). It reads
 * the clock first, so a read after a missed visible event closes the open
 * interval instead of counting foreground time as hidden.
 */
export function hiddenSecondsSince(sinceSeconds: number, nowMs: number = Date.now()): number {
  markNow();
  const ms = hiddenMsWithin(hiddenIntervals, hiddenSince, sinceSeconds * 1000, nowMs);
  return Math.floor(ms / 1000);
}

/** `performance.now()`, or `Date.now()` where the timing API is missing. */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Read the monotonic clock and, once tracking is installed, leave a liveness
 * mark. While hidden the pulse reads the clock every `RUNNING_PULSE_MS`, so a
 * gap since the last mark that began hidden is a stretch our JS did not run
 * once it outlasts what the pulse can explain: `EARLY_FROZEN_GAP_MS` while the
 * read that closes it comes less than `THROTTLED_AFTER_HIDDEN_MS` after the
 * page went hidden, and `FROZEN_GAP_MS` from then on, when throttling may hold
 * the pulse to a minute. Keyed on the gap's end, so a throttled wake-up that
 * reaches into that window is judged by the throttled threshold. Up to one
 * pulse period of it may have run, so that much stays running time. A gap that
 * began visible is never frozen. A read that finds the document visible ends
 * the hidden stretch once the gap is judged, so a re-hide starts a fresh one.
 */
function markNow(): number {
  const now = monotonicNow();
  if (!installed) return now;
  if (lastMarkAt !== null && lastMarkHidden) {
    const gap = now - lastMarkAt;
    const unthrottled = hiddenStartedAt !== null && now - hiddenStartedAt < THROTTLED_AFTER_HIDDEN_MS;
    if (gap > (unthrottled ? EARLY_FROZEN_GAP_MS : FROZEN_GAP_MS)) frozenTotalMs += gap - RUNNING_PULSE_MS;
  }
  lastMarkAt = now;
  lastMarkHidden = document.hidden;
  if (!lastMarkHidden) endHiddenStretch();
  return now;
}

/** Stop the pulse and close the open stretch on both clocks; a no-op when none is open. */
function endHiddenStretch(): void {
  stopPulse();
  hiddenStartedAt = null;
  if (hiddenSince !== null) {
    hiddenIntervals.push({ start: hiddenSince, end: Date.now() });
    hiddenSince = null;
    pruneOldIntervals();
  }
}

function startPulse(): void {
  if (pulse !== null) return;
  pulse = setInterval(markNow, RUNNING_PULSE_MS);
}

function stopPulse(): void {
  if (pulse === null) return;
  clearInterval(pulse);
  pulse = null;
}

/**
 * Milliseconds of running time: `performance.now()` minus every stretch the
 * platform froze our JS, so it stands still only across a freeze, never merely
 * because the document is hidden.
 */
export function runningNow(): number {
  return markNow() - frozenTotalMs;
}

/** Milliseconds of frozen time so far, a gap still open at the call included. */
export function frozenMs(): number {
  markNow();
  return frozenTotalMs;
}

/**
 * Run `callback` once `ms` of running time has passed; returns a cancel
 * function.
 *
 * A frozen WebView runs an overdue `setTimeout` the moment it resumes, so a
 * fire never calls back on trust: it re-reads the clock, which measures the
 * freeze it woke from, and with at least 1 ms left calls `onRearm(leftMs)` and
 * re-arms for that remainder. Under 1 ms it calls back, since no timer lands
 * closer than that.
 */
export function setRunningTimeout(callback: () => void, ms: number, onRearm?: (leftMs: number) => void): () => void {
  const startedAt = runningNow();
  let timer: ReturnType<typeof setTimeout>;
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      const leftMs = ms - (runningNow() - startedAt);
      if (leftMs >= 1) {
        onRearm?.(leftMs);
        arm(leftMs);
      } else {
        callback();
      }
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
  const monoNow = markNow();

  // Seed the open interval if we start up already hidden (e.g. a background
  // relaunch): there is no visibilitychange→hidden event to open it, so without
  // this the [startup, first-visible] stretch would be lost and hidden time
  // under-counted (#473 review). Nor is there one to start the pulse.
  if (document.hidden) {
    hiddenSince = Date.now();
    hiddenStartedAt = monoNow;
    startPulse();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
}

// Named so the test reset can remove it: jsdom's document outlives a test, and
// a listener left on it would keep writing into the next test's clock.
function onVisibilityChange(): void {
  // On a visible document this read has already ended the stretch.
  const monoNow = markNow();
  if (!document.hidden) return;
  if (hiddenSince === null) hiddenSince = Date.now();
  if (hiddenStartedAt === null) hiddenStartedAt = monoNow;
  startPulse();
}

/** Test-only: clear accumulated state and the install flag. */
export function __resetBackgroundTimeForTest(): void {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopPulse();
  hiddenIntervals = [];
  hiddenSince = null;
  frozenTotalMs = 0;
  lastMarkAt = null;
  lastMarkHidden = false;
  hiddenStartedAt = null;
  installed = false;
}
