import { useSyncExternalStore } from 'react';

// One clock for every mounted estimate, including long-lived approvals and activity lists.
const listeners = new Set<() => void>();
let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach(notify => notify());
    }, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

export function useQuoteClock(): void {
  useSyncExternalStore(subscribe, snapshot, snapshot);
}
