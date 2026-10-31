import { useEffect, useState } from 'react';

// Check the clock each second while a deadline is ahead. A clock change does not reset a running timer.
const MAX_TIMER_MS = 1_000;

// Visible pages poll at most once per second, with an exact wake when the deadline is sooner.
const VISIBLE_WAKE_MS = 1000;

type DeadlineSubscriber = {
  deadlineMs: number | null;
  onSample: (nowMs: number) => void;
};

// A mount and a deadline change take Date.now() for the committed render. The shared sample still drives later wakes.
let sample = 0;
const subscribers = new Set<DeadlineSubscriber>();
let wake: ReturnType<typeof setTimeout> | undefined;
let watchingVisibility = false;

function publish(now: number): void {
  sample = now;
  for (const subscriber of [...subscribers]) subscriber.onSample(now);
}

function clearWake(): void {
  if (wake !== undefined) clearTimeout(wake);
  wake = undefined;
}

// The soonest deadline still ahead of the published sample. Null when every subscriber is null or already due, which
// is what stops both wakes until a deadline changes.
function soonestRemaining(): number | null {
  let remaining: number | null = null;
  for (const { deadlineMs } of subscribers) {
    if (deadlineMs === null || sample >= deadlineMs) continue;
    const wait = deadlineMs - sample;
    if (remaining === null || wait < remaining) remaining = wait;
  }
  return remaining;
}

function pageVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

function arm(): void {
  clearWake();
  const remaining = soonestRemaining();
  if (remaining === null) return;
  // Hidden waits the bounded step, so a clock change still lands without a visibility event.
  const delay = pageVisible() ? Math.min(remaining, VISIBLE_WAKE_MS) : Math.min(remaining, MAX_TIMER_MS);
  wake = setTimeout(onWake, delay);
}

function onWake(): void {
  wake = undefined;
  publish(Date.now());
  arm();
}

function onVisibilityChange(): void {
  // A jump while hidden is applied on the way back, not after the delay computed before it.
  if (pageVisible()) publish(Date.now());
  arm();
}

function watchVisibility(): void {
  if (watchingVisibility || typeof document === 'undefined') return;
  watchingVisibility = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function unwatchVisibility(): void {
  if (!watchingVisibility || typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  watchingVisibility = false;
}

/**
 * Hands `onSample` the shared `Date.now()` sample, at once and then on every wake, until the returned function
 * unsubscribes. For a parent that only needs to learn the deadline passed: it compares the sample and sets state on
 * the flip, so the ticking stays out of its renders. Anything that draws the time left uses `useDeadlineNow`.
 */
export function subscribeDeadlineSample(deadlineMs: number | null, onSample: (nowMs: number) => void): () => void {
  const subscriber: DeadlineSubscriber = { deadlineMs, onSample };
  subscribers.add(subscriber);
  watchVisibility();
  publish(Date.now());
  arm();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      clearWake();
      unwatchVisibility();
    } else {
      arm();
    }
  };
}

/**
 * The shared `Date.now()` sample, re-rendering on each one. A null deadline arms nothing. While any subscriber's
 * deadline is still ahead of the sample, a visible document wakes at the next deadline or after one second, whichever
 * comes first, and a hidden one waits `min(remaining, MAX_TIMER_MS)`, then samples again. Becoming visible samples
 * immediately. At or past the deadline, both wakes stay stopped until the deadline changes.
 */
export function useDeadlineNow(deadlineMs: number | null): number {
  const [now, setNow] = useState(Date.now);
  const [recordedAt, setRecordedAt] = useState(deadlineMs);
  // Store the new deadline during render so this pass is discarded and the committed render returns Date.now().
  if (recordedAt !== deadlineMs) {
    setRecordedAt(deadlineMs);
    setNow(Date.now());
  }
  useEffect(() => subscribeDeadlineSample(deadlineMs, setNow), [deadlineMs]);
  return now;
}
