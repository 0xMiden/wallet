import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONNECTIVITY_CATEGORIES,
  CONNECTIVITY_STATE_KEY,
  ConnectivityCategory,
  ConnectivityStateSnapshot,
  getConnectivityState,
  subscribeConnectivityState
} from './connectivity-state';
import { isExtension } from '../../platform';
import { fetchFromStorage, putToStorage, useStorage } from '../front/storage';

export const CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY = 'miden-connectivity-dismissed-activations';

type DismissedActivations = Partial<Record<ConnectivityCategory, number | null>>;

// Stable fallback: an inline `{}` would be a new object every render, and
// useStorage returns `data ?? fallback`, so the sync effect below would fire
// on each render and setState forever ("Maximum update depth exceeded").
const NO_DISMISSED_ACTIVATIONS: DismissedActivations = {};

// Every write of the stored record is one read-modify-write in a turn, so a window never puts back a category another
// window just changed (#1158): the Web Lock every extension surface (popup, side panel, tabs) shares, as
// lib/wallet-prompts.ts takes for its record, or, without Web Locks (iOS before 15.4, one window), an in-realm chain as
// lib/miden/activity/bridge-in.ts keeps. A change that returns the record as it is writes nothing. A failed write is
// not retried: this window keeps its change, and storage keeps the old record until a later change writes it.
let dismissedActivationsTail: Promise<unknown> = Promise.resolve();

function inDismissedActivationsTurn(operation: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`turn:${CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY}`, operation);
  }
  const run = dismissedActivationsTail.then(operation, operation);
  dismissedActivationsTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function storeDismissedActivations(
  change: (current: DismissedActivations) => DismissedActivations
): Promise<void> {
  try {
    await inDismissedActivationsTurn(async () => {
      const current = (await fetchFromStorage<DismissedActivations>(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY)) ?? {};
      const next = change(current);
      if (next !== current) await putToStorage(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, next);
    });
  } catch {
    // Not retried (above).
  }
}

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
  const [storedDismissedActivations] = useStorage<DismissedActivations>(
    CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY,
    NO_DISMISSED_ACTIVATIONS
  );
  const [memorySnapshot, setMemorySnapshot] = useState<ConnectivityStateSnapshot>(() => getConnectivityState());
  // This window's own dismissals, kept apart from the stored record (every write re-delivers that one), so a dismissal
  // storage refused, failed to write or has not written yet still hides the banner here.
  const [ownDismissals, setOwnDismissals] = useState<DismissedActivations>(NO_DISMISSED_ACTIVATIONS);

  useEffect(() => {
    return subscribeConnectivityState(setMemorySnapshot);
  }, []);

  const merged: ConnectivityStateSnapshot = isExtension() ? (storageSnapshot ?? memorySnapshot) : memorySnapshot;
  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  useEffect(() => {
    const recovered = CONNECTIVITY_CATEGORIES.filter(
      category => !merged[category].active && (category in ownDismissals || category in storedDismissedActivations)
    );
    if (recovered.length === 0) return;
    // Forget a recovered dismissal only while it is still one this window saw in either input: another window may
    // already hold a dismissal of a newer activation of the same category.
    const forget = (current: DismissedActivations): DismissedActivations => {
      const stale = recovered.filter(
        category =>
          category in current &&
          (current[category] === ownDismissals[category] || current[category] === storedDismissedActivations[category])
      );
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const category of stale) delete next[category];
      return next;
    };
    setOwnDismissals(forget);
    void storeDismissedActivations(forget);
  }, [ownDismissals, storedDismissedActivations, merged]);

  const visible = useMemo(() => {
    let next = merged;
    for (const category of CONNECTIVITY_CATEGORIES) {
      const { active, since } = merged[category];
      if (active && (since === storedDismissedActivations[category] || since === ownDismissals[category])) {
        next = { ...next, [category]: { active: false, since: null } };
      }
    }
    return next;
  }, [merged, storedDismissedActivations, ownDismissals]);

  const hasAnyIssue =
    visible.network.active || visible.node.active || visible.prover.active || visible.resolving.active;

  const dismiss = useCallback((category: ConnectivityCategory) => {
    const activation = mergedRef.current[category];
    if (!activation.active) return;
    const { since } = activation;
    // The window where the user tapped always hides what it shows.
    setOwnDismissals(current => (current[category] === since ? current : { ...current, [category]: since }));
    // In storage a dismissal of a later activation (from another window) outranks this one, so a window still showing
    // an old activation never brings the current one's banner back everywhere.
    void storeDismissedActivations(current => {
      const held = current[category];
      if (held === since || (typeof held === 'number' && typeof since === 'number' && held > since)) return current;
      return { ...current, [category]: since };
    });
  }, []);

  return { state: visible, hasAnyIssue, dismiss };
}
