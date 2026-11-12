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
  let hiddenSignal: number | null = null;

  return {
    hidden(at) {
      // The first signal wins. More than a heartbeat after the last foreground moment it is a pause delivered late,
      // so the absence is measured from that moment rather than counting the freeze as foreground. The signal's own
      // time stays the floor below which a reading means the clock was set back.
      if (hiddenAt !== null) return;
      hiddenSignal = at;
      hiddenAt = at - lastSeen <= BACKGROUND_LOCK_HEARTBEAT_MS ? at : lastSeen;
    },
    visible(at) {
      const since = hiddenAt ?? lastSeen;
      const floor = hiddenSignal ?? lastSeen;
      hiddenAt = null;
      hiddenSignal = null;
      lastSeen = at;
      // A clock set back across a background cannot prove how long it was, so it locks.
      return at < floor || at - since >= delayMs();
    },
    tick(at) {
      // While hidden the heartbeat decides as a resume would, so a resume that never arrives still locks.
      if (hiddenAt !== null && hiddenSignal !== null) return at < hiddenSignal || at - hiddenAt >= delayMs();
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
