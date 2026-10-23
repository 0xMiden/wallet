import { useEffect, useState } from 'react';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { useBridgeConfigSnapshot } from './use-feature-availability';
import { hasMainnetLaunched, selectMainnetLaunchAt } from './values';

// Check the clock each second while launch is pending. A clock change does not reset a running timer.
const MAX_TIMER_MS = 1_000;

// Visible pages poll at most once per second, with an exact wake when launch is sooner.
const VISIBLE_WAKE_MS = 1000;

type LaunchSubscriber = {
  launchAt: number | null;
  onSample: (now: number) => void;
};

// A mount and a launchAt change take Date.now() for the committed render. The shared sample still drives
// later wakes.
let sample = 0;
const subscribers = new Set<LaunchSubscriber>();
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
    } else {
      arm();
    }
  };
}

/**
 * The shared `Date.now()` sample the countdown and `useMainnetLaunched` render from. A null moment arms
 * nothing. While any subscriber's moment is still ahead of the sample, a visible document wakes at the
 * next moment or after one second, whichever comes first, and a hidden one waits
 * `min(remaining, MAX_TIMER_MS)`, then samples again. Becoming visible
 * samples immediately. At or past the moment, both wakes stay stopped until the moment changes.
 */
export function useMainnetLaunchNow(launchAt: number | null): number {
  const [now, setNow] = useState(Date.now);
  const [recordedAt, setRecordedAt] = useState(launchAt);
  // Store the new moment during render so this pass is discarded and the committed render returns Date.now().
  if (recordedAt !== launchAt) {
    setRecordedAt(launchAt);
    setNow(Date.now());
  }
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

/**
 * Invite-only onboarding: mainnet has launched, or the effective network is already mainnet. The Welcome's
 * seven-tap unlock stays local to `OnboardingNetwork` and is combined with this result there.
 */
export function isInviteOnlyRequired(launched: boolean, network: MIDEN_NETWORK_NAME): boolean {
  return launched || network === MIDEN_NETWORK_NAME.MAINNET;
}
