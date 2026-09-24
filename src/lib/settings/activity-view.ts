import { useSyncExternalStore } from 'react';

import { createListenerSet } from 'lib/listener-set';

import { ACTIVITY_VIEW_STORAGE_KEY, ACTIVITY_VIEWS, ActivityView, DEFAULT_ACTIVITY_VIEW } from './constants';

/**
 * Which view the Activity tab opens in, persisted as plain text under `activity_view_setting`.
 *
 * The same shape as the balance card's colour (`card-color.ts`): a per-device display preference
 * the app's settings module owns, read through `useActivityView()` so every mounted Activity
 * surface re-renders when the header's view switcher changes it. It is deliberately NOT part of
 * the vault-backed `WalletSettings`, which is account data that syncs with the wallet.
 */

const { subscribe, notify } = createListenerSet();

export function getActivityView(): ActivityView {
  try {
    const stored = localStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY);
    const match = ACTIVITY_VIEWS.find(view => view === stored);
    if (match) return match;
  } catch {}
  return DEFAULT_ACTIVITY_VIEW;
}

/** Persist the chosen view and notify subscribers. */
export function setActivityView(view: ActivityView) {
  try {
    localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, view);
  } catch {}
  notify();
}

/** Reactive Activity view — re-renders when the header's switcher changes it. */
export function useActivityView(): ActivityView {
  return useSyncExternalStore(subscribe, getActivityView);
}
