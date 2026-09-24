import { useSyncExternalStore } from 'react';

/**
 * A per-device display preference kept as plain text in `localStorage`, for choices that are not
 * account data and so stay out of the vault-backed `WalletSettings`.
 *
 * A stored value outside `allowed` (an old build's choice, a hand edit) reads as `fallback`, and
 * storage that throws is treated as empty: a preference is never worth a crash.
 */
export function createPersistedSetting<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const listeners = new Set<() => void>();

  function get(): T {
    try {
      const stored = localStorage.getItem(key);
      const match = allowed.find(value => value === stored);
      if (match) return match;
    } catch {}
    return fallback;
  }

  /** Subscribers are told even when the write fails, so they re-read rather than go stale. */
  function set(value: T) {
    try {
      localStorage.setItem(key, value);
    } catch {}
    listeners.forEach(listener => listener());
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, get);
  }

  return { get, set, useValue };
}
