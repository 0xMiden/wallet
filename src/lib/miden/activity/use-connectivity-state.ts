import { useCallback, useEffect, useState } from 'react';

import {
  clearConnectivityIssue,
  CONNECTIVITY_STATE_KEY,
  ConnectivityCategory,
  ConnectivityStateSnapshot,
  getConnectivityState,
  subscribeConnectivityState
} from './connectivity-state';
import { putToStorage, useStorage } from '../front/storage';

/**
 * React hook exposing the current connectivity-state snapshot.
 *
 * Two delivery paths plumbed together:
 *
 *   - Same-process subscriber (always live). On mobile/desktop the state
 *     machine and the React app share a process, so this is the only path
 *     that fires. On the extension popup it's still useful for in-popup
 *     transitions (e.g. user dismisses a category).
 *
 *   - chrome.storage mirror (extension only). The SW writes the state to
 *     `miden-connectivity-state` after every transition; the popup picks up
 *     the change via the existing `useStorage` SWR + onChanged plumbing,
 *     which is the same channel the rest of the SW->popup state uses.
 *
 * We start the React state from the synchronous in-memory snapshot, then
 * reconcile with whichever path delivers updates first. This avoids a
 * one-tick render of stale "no issues" state at popup mount.
 */
export function useConnectivityState(): {
  state: ConnectivityStateSnapshot;
  hasAnyIssue: boolean;
  dismiss: (category: ConnectivityCategory) => void;
} {
  const [storageSnapshot] = useStorage<ConnectivityStateSnapshot | null>(CONNECTIVITY_STATE_KEY, null);
  const [memorySnapshot, setMemorySnapshot] = useState<ConnectivityStateSnapshot>(() => getConnectivityState());

  useEffect(() => {
    return subscribeConnectivityState(setMemorySnapshot);
  }, []);

  // Merge: storage wins for any category it knows about (it reflects the
  // SW's authoritative view in the extension), memory fills the rest. In
  // the non-extension case storage is just a mirror of the same in-process
  // state machine, so the two agree by construction.
  const merged: ConnectivityStateSnapshot = storageSnapshot ?? memorySnapshot;

  const hasAnyIssue = merged.network.active || merged.node.active || merged.prover.active || merged.resolving.active;

  const dismiss = useCallback((category: ConnectivityCategory) => {
    // Update both the in-process machine and the storage mirror, so
    // dismissal sticks regardless of which side reads first.
    clearConnectivityIssue(category);
    void putToStorage(CONNECTIVITY_STATE_KEY, getConnectivityState());
  }, []);

  return { state: merged, hasAnyIssue, dismiss };
}
