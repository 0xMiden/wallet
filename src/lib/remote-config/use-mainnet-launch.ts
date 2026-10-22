import { useEffect, useState } from 'react';

import { useBridgeConfigSnapshot } from './use-feature-availability';
import { hasMainnetLaunched, selectMainnetLaunchAt } from './values';

// The longest wait one timer takes: a browser clamps a longer `setTimeout` delay to a value that fires at
// once, so a far-off moment is reached through a chain of waits.
const MAX_TIMER_MS = 0x7fffffff;

// The countdown banner's existing bound. A visible page wakes on it, so a forward jump is published on
// the next second instead of at a delay chosen before the jump.
const VISIBLE_WAKE_MS = 1000;

type LaunchSubscriber = {
  launchAt: number | null;
  onSample: (now: number) => void;
};

// One sample for every subscriber. Dropped when the last one leaves, so the next mount reads the clock then.
let sample = 0;
let hasSample = false;
const subscribers = new Set<LaunchSubscriber>();
let wake: ReturnType<typeof setTimeout> | undefined;
let watchingVisibility = false;

function ensureSample(): number {
  if (!hasSample) {
    sample = Date.now();
    hasSample = true;
  }
  return sample;
}

function publish(now: number): void {
  sample = now;
  hasSample = true;
  for (const subscriber of [...subscribers]) subscriber.onSample(now);
}

function clearWake(): void {
  if (wake !== undefined) clearTimeout(wake);
  wake = undefined;
}

// The soonest moment still ahead of the published sample. Null when every subscriber is null or already due,
// which is what stops both wakes until a moment changes.
function soonestRemaining(): number | null {
  let remaining: number | null = null;
  for (const subscriber of subscribers) {
    const { launchAt } = subscriber;
    if (launchAt === null || sample >= launchAt) continue;
    const wait = launchAt - sample;
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
  // Hidden keeps the long chain, so a far moment still arrives and a one-second poll is not armed.
  const delay = pageVisible() ? VISIBLE_WAKE_MS : Math.min(remaining, MAX_TIMER_MS);
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

function subscribeLaunchSample(launchAt: number | null, onSample: (now: number) => void): () => void {
  const subscriber: LaunchSubscriber = { launchAt, onSample };
  subscribers.add(subscriber);
  watchVisibility();
  publish(Date.now());
  arm();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      clearWake();
      unwatchVisibility();
      hasSample = false;
    } else {
      arm();
    }
  };
}

/**
 * The shared `Date.now()` sample the countdown and `useMainnetLaunched` render from. A null moment arms
 * nothing. While any subscriber's moment is still ahead of the sample, a visible document wakes every
 * second and a hidden one waits `min(remaining, MAX_TIMER_MS)`, then samples again. Becoming visible
 * samples immediately. At or past the moment, both wakes stay stopped until the moment changes.
 */
export function useMainnetLaunchNow(launchAt: number | null): number {
  const [now, setNow] = useState(ensureSample);
  useEffect(() => subscribeLaunchSample(launchAt, setNow), [launchAt]);
  return now;
}

/**
 * Whether mainnet has launched for the effective network: the document's countdown is on and its moment
 * has passed. Re-renders from the shared sample, so a Welcome or recovery left open across the moment
 * changes mode without a reload, and on every document change that moves the moment.
 */
export function useMainnetLaunched(): boolean {
  const snapshot = useBridgeConfigSnapshot();
  const launchAt = selectMainnetLaunchAt(snapshot);
  const now = useMainnetLaunchNow(launchAt);
  return hasMainnetLaunched(snapshot, now);
}
