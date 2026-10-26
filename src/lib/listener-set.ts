/**
 * The subscriber list behind a module-level store read through `useSyncExternalStore`. `subscribe`
 * is created once per store, so React sees the same function on every render and never
 * resubscribes.
 */
export interface ListenerSet {
  subscribe: (listener: () => void) => () => void;
  notify: () => void;
}

export function createListenerSet(): ListenerSet {
  const listeners = new Set<() => void>();
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: () => listeners.forEach(listener => listener())
  };
}
