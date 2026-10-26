import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONNECTIVITY_CATEGORIES,
  CONNECTIVITY_STATE_KEY,
  ConnectivityCategory,
  ConnectivityStateSnapshot,
  getConnectivityState,
  isConnectivitySnapshot,
  subscribeConnectivityState
} from './connectivity-state';
import { isExtension } from '../../platform';
import { fetchFromStorage, inStorageTurn, putToStorage, useStorage } from '../front/storage';

export const CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY = 'miden-connectivity-dismissed-activations';

type DismissedActivations = Partial<Record<ConnectivityCategory, number | null>>;

const NO_DISMISSED_ACTIVATIONS: DismissedActivations = {};

// The stored record as it is, keeping only known categories with a timestamp (or null), so a malformed value reads as
// nothing dismissed.
function readDismissedActivations(raw: unknown): DismissedActivations {
  const record: DismissedActivations = {};
  if (!raw || typeof raw !== 'object') return record;
  for (const category of CONNECTIVITY_CATEGORIES) {
    const since: unknown = Reflect.get(raw, category);
    if (typeof since === 'number' || since === null) record[category] = since;
  }
  return record;
}

// One read-modify-write of the stored record in its storage turn, which every extension surface (popup, side panel,
// tabs) shares, so a window never puts back a category another window just changed (#1158). A change that returns the
// record as it is writes nothing. A failed write is not retried: this window keeps its change, and storage keeps the
// old record until a later change writes it.
async function updateDismissedActivations(
  change: (current: DismissedActivations) => DismissedActivations | Promise<DismissedActivations>
): Promise<void> {
  try {
    await inStorageTurn(`turn:${CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY}`, async () => {
      const current = readDismissedActivations(await fetchFromStorage(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY));
      const next = await change(current);
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
  const [storedRecord] = useStorage<unknown>(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, null);
  // Read as the storage turn reads it, so a malformed record hides nothing here either.
  const storedDismissals = useMemo(() => readDismissedActivations(storedRecord), [storedRecord]);
  const [memorySnapshot, setMemorySnapshot] = useState<ConnectivityStateSnapshot>(() => getConnectivityState());
  // This window's own dismissals, kept apart from the stored record (on the extension every write re-delivers that
  // one), so a dismissal storage did not take, failed to write or has not written yet still hides its banner here.
  const [ownDismissals, setOwnDismissals] = useState<DismissedActivations>(NO_DISMISSED_ACTIVATIONS);

  useEffect(() => {
    return subscribeConnectivityState(setMemorySnapshot);
  }, []);

  // Merge: storage wins for any category it knows about (it reflects the
  // SW's authoritative view in the extension), memory fills the rest. In
  // the non-extension case storage is just a mirror of the same in-process
  // state machine, so the two agree by construction.
  const merged: ConnectivityStateSnapshot = isExtension() ? (storageSnapshot ?? memorySnapshot) : memorySnapshot;
  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  // A reactivation within the same millisecond gets the same since, so a kept dismissal would hide it here.
  useEffect(() => {
    setOwnDismissals(current => {
      const recovered = CONNECTIVITY_CATEGORIES.filter(category => category in current && !merged[category].active);
      if (recovered.length === 0) return current;
      const next = { ...current };
      for (const category of recovered) delete next[category];
      return next;
    });
  }, [merged]);

  const visible = useMemo(() => {
    let next = merged;
    for (const category of CONNECTIVITY_CATEGORIES) {
      const { active, since } = merged[category];
      if (
        active &&
        ((category in ownDismissals && since === ownDismissals[category]) ||
          (category in storedDismissals && since === storedDismissals[category]))
      ) {
        next = { ...next, [category]: { active: false, since: null } };
      }
    }
    return next;
  }, [merged, ownDismissals, storedDismissals]);

  const hasAnyIssue =
    visible.network.active || visible.node.active || visible.prover.active || visible.resolving.active;

  const dismiss = useCallback((category: ConnectivityCategory) => {
    const activation = mergedRef.current[category];
    if (!activation.active) return;
    const { since } = activation;
    // The window where the user tapped always hides what it shows, whatever storage decides.
    setOwnDismissals(current => (current[category] === since ? current : { ...current, [category]: since }));
    void updateDismissedActivations(async current => {
      if (current[category] === since) return current;
      // Decided by the activation the connectivity mirror names now, never by comparing since stamps, which a clock
      // step back reorders: a window still showing an older activation keeps its dismissal to itself, so it never
      // replaces another window's dismissal of the current one.
      const mirror = await fetchFromStorage(CONNECTIVITY_STATE_KEY);
      if (isConnectivitySnapshot(mirror) && mirror[category].active && mirror[category].since !== since) return current;
      return { ...current, [category]: since };
    });
  }, []);

  return { state: visible, hasAnyIssue, dismiss };
}
