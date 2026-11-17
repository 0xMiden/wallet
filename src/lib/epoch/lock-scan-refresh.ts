import { useSyncExternalStore } from 'react';

// A counter that every recovery action moves. The Settings recovery page scans again when it moves, also while a lock
// page covers it and keeps it mounted.
let generation = 0;
const listeners = new Set<() => void>();

/** Ask the recovery page to scan The Compact again, because an action changed a lock. */
export function requestLockRescan(): void {
  generation += 1;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The number of rescans asked for so far. A scan that depends on it runs again after each action. */
export function useLockRescanGeneration(): number {
  return useSyncExternalStore(subscribe, () => generation);
}
