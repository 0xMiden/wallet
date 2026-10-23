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
let waiters: Waiter[] = [];
const listeners = new Set<(busy: boolean) => void>();

const nextFrame = (cb: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else setTimeout(cb, FRAME_FALLBACK_MS);
};

const emit = (busy: boolean) => listeners.forEach(listener => listener(busy));

const settle = (waiter: Waiter) => {
  clearTimeout(waiter.capTimer);
  waiters = waiters.filter(w => w !== waiter);
  waiter.resolve();
};

// A new gesture landing before the frame keeps waiters waiting, so only resolve if still idle.
const releaseWaitersIfIdle = () => {
  frameScheduled = false;
  if (active === 0) [...waiters].forEach(settle);
};

/** Marks a gesture as started. Returns an idempotent function that marks it finished. */
export function beginInteraction(): () => void {
  if (active === 0) {
    busySince = Date.now();
    active = 1;
    emit(true);
  } else {
    active++;
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active--;
    if (active > 0) return;
    emit(false);
    if (!frameScheduled) {
      frameScheduled = true;
      nextFrame(releaseWaitersIfIdle);
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
  if (active === 0) return Promise.resolve();
  return new Promise<void>(resolve => {
    const remaining = Math.max(0, busySince + pagerMotion.interactionDeferCapMs - Date.now());
    const waiter: Waiter = { resolve, capTimer: setTimeout(() => settle(waiter), remaining) };
    waiters.push(waiter);
  });
}

/** Calls `listener` on each idle/busy transition. Returns the unsubscribe function. */
export function subscribeInteraction(listener: (busy: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drops all state so suites do not leak interactions into each other. */
export function _resetInteractionPriorityForTest(): void {
  waiters.forEach(w => clearTimeout(w.capTimer));
  waiters = [];
  listeners.clear();
  active = 0;
  busySince = 0;
  frameScheduled = false;
}
