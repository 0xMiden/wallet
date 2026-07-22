import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONNECTIVITY_STATE_KEY,
  ConnectivityCategory,
  ConnectivityStateSnapshot,
  getConnectivityState,
  subscribeConnectivityState
} from './connectivity-state';
import { isExtension } from '../../platform';
import { useStorage } from '../front/storage';

export const CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY = 'miden-connectivity-dismissed-activations';

type DismissedActivations = Partial<Record<ConnectivityCategory, number | null>>;

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
  const [storedDismissedActivations, setStoredDismissedActivations] = useStorage<DismissedActivations>(
    CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY,
    {}
  );
  const [memorySnapshot, setMemorySnapshot] = useState<ConnectivityStateSnapshot>(() => getConnectivityState());
  const [dismissedActivations, setDismissedActivations] = useState<DismissedActivations>(storedDismissedActivations);

  useEffect(() => {
    return subscribeConnectivityState(setMemorySnapshot);
  }, []);

  useEffect(() => {
    setDismissedActivations(storedDismissedActivations);
  }, [storedDismissedActivations]);

  // Merge: storage wins for any category it knows about (it reflects the
  // SW's authoritative view in the extension), memory fills the rest. In
  // the non-extension case storage is just a mirror of the same in-process
  // state machine, so the two agree by construction.
  // The service worker's storage mirror is authoritative only in the
  // extension. Native/desktop storage has no change events, so preferring it
  // there would pin the first loaded snapshot after the in-process machine
  // recovers.
  const merged: ConnectivityStateSnapshot = isExtension() ? (storageSnapshot ?? memorySnapshot) : memorySnapshot;
  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  useEffect(() => {
    const recovered = (Object.keys(dismissedActivations) as ConnectivityCategory[]).filter(
      category => !merged[category].active
    );
    if (recovered.length === 0) return;
    const next = { ...dismissedActivations };
    for (const category of recovered) delete next[category];
    setDismissedActivations(next);
    void setStoredDismissedActivations(next);
  }, [dismissedActivations, merged, setStoredDismissedActivations]);

  // Dismissal hides this specific failure episode. We leave the underlying
  // machine active so repeated polling failures cannot immediately recreate
  // the banner. A successful recovery clears it; a later failure gets a new
  // `since` value and is surfaced normally.
  const visible = useMemo(() => {
    if (Object.keys(dismissedActivations).length === 0) return merged;
    const next = { ...merged };
    for (const category of Object.keys(dismissedActivations) as ConnectivityCategory[]) {
      if (next[category].active && next[category].since === dismissedActivations[category]) {
        next[category] = { active: false, since: null };
      }
    }
    return next;
  }, [dismissedActivations, merged]);

  const hasAnyIssue =
    visible.network.active || visible.node.active || visible.prover.active || visible.resolving.active;

  const dismiss = useCallback(
    (category: ConnectivityCategory) => {
      const activation = mergedRef.current[category];
      if (!activation.active) return;
      const next = { ...dismissedActivations, [category]: activation.since };
      setDismissedActivations(next);
      void setStoredDismissedActivations(next);
    },
    [dismissedActivations, setStoredDismissedActivations]
  );

  return { state: visible, hasAnyIssue, dismiss };
}
