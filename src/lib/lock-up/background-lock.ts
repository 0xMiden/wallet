import { useSyncExternalStore } from 'react';

import { CHECK_PAGES_EXIST } from 'lib/fixed-times';
import { createListenerSet } from 'lib/listener-set';

export const BACKGROUND_LOCK_HEARTBEAT_MS = CHECK_PAGES_EXIST;

/** A returned `true` means "lock now". */
export interface BackgroundLockClock {
  hidden(now: number): void;
  visible(now: number): boolean;
  tick(now: number): boolean;
}

/**
 * Measures time away on the wall clock, because iOS freezes JS in the background: `pause` can arrive at resume or
 * never, and no timer runs meanwhile. The delay is read at every decision so a changed setting applies at once.
 */
export function createBackgroundLockClock(delayMs: () => number, now: number): BackgroundLockClock {
  let lastSeen = now;
  let hiddenAt: number | null = null;

  return {
    hidden(at) {
      // A pause delivered late must not claim the whole freeze as time the wallet was still in the foreground.
      if (hiddenAt === null) hiddenAt = Math.min(at, lastSeen + BACKGROUND_LOCK_HEARTBEAT_MS);
    },
    visible(at) {
      const since = hiddenAt ?? lastSeen;
      hiddenAt = null;
      lastSeen = at;
      // A clock set back across a background cannot prove how long it was, so it locks.
      return at < since || at - since >= delayMs();
    },
    tick(at) {
      if (hiddenAt !== null) return false;
      const gap = at - lastSeen;
      lastSeen = at;
      return gap >= delayMs();
    }
  };
}

const pending = createListenerSet();
let pendingValue = false;

/** True from the moment the delay expired until the wallet is locked, so the pages can be covered at once. */
export const backgroundLockPending = {
  get: () => pendingValue,
  set(value: boolean) {
    if (value === pendingValue) return;
    pendingValue = value;
    pending.notify();
  },
  useValue: () => useSyncExternalStore(pending.subscribe, () => pendingValue)
};
