import { ACTIVITY_VIEW_STORAGE_KEY, ACTIVITY_VIEWS, ActivityView, DEFAULT_ACTIVITY_VIEW } from './constants';
import { createPersistedSetting } from './persisted-setting';

/**
 * Which view the Activity tab opens in, persisted as plain text under `activity_view_setting`.
 *
 * The same shape as the balance card's colour (`card-color.ts`): a per-device display preference
 * the app's settings module owns, read through `useActivityView()` so every mounted Activity
 * surface re-renders when the header's view switcher changes it. It is deliberately NOT part of
 * the vault-backed `WalletSettings`, which is account data that syncs with the wallet.
 */
const activityView = createPersistedSetting<ActivityView>(
  ACTIVITY_VIEW_STORAGE_KEY,
  ACTIVITY_VIEWS,
  DEFAULT_ACTIVITY_VIEW
);

export const getActivityView = activityView.get;

/** Persist the chosen view and notify subscribers. */
export const setActivityView = activityView.set;

/** Reactive Activity view — re-renders when the header's switcher changes it. */
export const useActivityView = activityView.useValue;
