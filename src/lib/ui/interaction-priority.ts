import { pagerMotion } from 'lib/animation';

/**
 * Module-scoped "a gesture is in flight" signal, so background work (sync, prefetch, re-renders)
 * can yield while a finger is dragging the pager instead of competing for the main thread.
 */

interface Waiter {
  resolve: () => void;
  capTimer: ReturnType<typeof setTimeout>;
}

const FRAME_FALLBACK_MS = 16;

let active = 0;
let busySince = 0;
let frameScheduled = false;
let idleEpoch = 0;
let waiters: Waiter[] = [];

const nextFrame = (cb: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else setTimeout(cb, FRAME_FALLBACK_MS);
};

const settle = (waiter: Waiter) => {
  clearTimeout(waiter.capTimer);
  waiters = waiters.filter(w => w !== waiter);
  waiter.resolve();
};

// A new gesture landing before the frame keeps waiters waiting, so only resolve if still idle.
// A frame from an earlier end is stale: it settles nothing, and while a frame is queued it
// schedules one successor closed over the epoch read now.
const releaseWaitersIfIdle = (epoch: number) => {
  if (epoch !== idleEpoch) {
    if (frameScheduled) {
      const successor = idleEpoch;
      nextFrame(() => releaseWaitersIfIdle(successor));
    }
    return;
  }
  frameScheduled = false;
  if (active === 0) [...waiters].forEach(settle);
};

/** Marks a gesture as started. Returns an idempotent function that marks it finished. */
export function beginInteraction(): () => void {
  if (active === 0) {
    if (!frameScheduled) busySince = Date.now();
    active = 1;
  } else {
    active++;
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active--;
    if (active > 0) return;
    idleEpoch++;
    if (!frameScheduled) {
      frameScheduled = true;
      const epoch = idleEpoch;
      nextFrame(() => releaseWaitersIfIdle(epoch));
    }
  };
}

/** True while at least one gesture is in flight. */
export function isInteracting(): boolean {
  return active > 0;
}

/**
 * Resolves at once when idle; otherwise one frame after the last gesture ends, or once
 * `pagerMotion.interactionDeferCapMs` has passed since the current busy period began, so a held
 * finger cannot starve background work forever.
 */
export function whenInteractionIdle(): Promise<void> {
  // The idle frame after the last end still belongs to the busy period.
  if (active === 0 && !frameScheduled) return Promise.resolve();
  return new Promise<void>(resolve => {
    const remaining = Math.max(0, busySince + pagerMotion.interactionDeferCapMs - Date.now());
    const waiter: Waiter = { resolve, capTimer: setTimeout(() => settle(waiter), remaining) };
    waiters.push(waiter);
  });
}

/** Test-only: drops all state so suites do not leak interactions into each other. */
export function _resetInteractionPriorityForTest(): void {
  waiters.forEach(w => clearTimeout(w.capTimer));
  waiters = [];
  active = 0;
  busySince = 0;
  frameScheduled = false;
  idleEpoch++;
}
