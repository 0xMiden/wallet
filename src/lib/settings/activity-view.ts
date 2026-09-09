import { useSyncExternalStore } from 'react';

import { ACTIVITY_VIEW_STORAGE_KEY } from './constants';

/**
 * Which lens the Activity root shows: `time` is the chronological feed,
 * `group` folds the same transactions into one row per counterparty.
 */
export type ActivityView = 'time' | 'group';

const ACTIVITY_VIEWS: ActivityView[] = ['time', 'group'];
const DEFAULT_ACTIVITY_VIEW: ActivityView = 'time';

/**
 * Persisted rather than held in component state because opening a group
 * unmounts the Activity root — coming back from a drill-in would otherwise
 * silently drop the user into the other view. Mirrors `card-color.ts`.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function getActivityView(): ActivityView {
  try {
    const stored = localStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY);
    const match = ACTIVITY_VIEWS.find(view => view === stored);
    if (match) return match;
  } catch {}
  return DEFAULT_ACTIVITY_VIEW;
}

/** Persist the Activity lens and notify subscribers. */
export function setActivityView(view: ActivityView) {
  try {
    localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, view);
  } catch {}
  listeners.forEach(listener => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive Activity lens — re-renders when the header toggle changes it. */
export function useActivityView(): ActivityView {
  return useSyncExternalStore(subscribe, getActivityView);
}
