export { INJECTION_SCRIPT } from './injection-script';
export { handleWebViewMessage } from './message-handler';
export type { WebViewMessage, WebViewResponse } from './message-handler';
export {
  createDappSession,
  parseOrigin,
  getDappHostname,
  getDappDisplayName,
  type DappSession,
  type DappSessionStatus
} from './dapp-session';
export { buildFaviconUrl, getFaviconUrl, getFallbackColor, getFallbackLetter } from './favicon-cache';
export { rectFromDOMRect, rectsEqual, type WebViewRect } from './webview-rect';
export { useDappConfirmation, type UseDappConfirmationResult } from './use-dapp-confirmation';
export { useNativeNavbarAction, type NavbarAction } from './use-native-navbar-action';
export {
  FEATURED_DAPPS,
  CAROUSEL_DAPPS,
  type FeaturedDapp,
  type FeaturedDappBadge,
  type FeaturedDappCategory
} from './featured-dapps';
export { CATEGORIES, type CategoryDescriptor } from './category-data';
export { getRecentDapps, recordRecentDapp, forgetRecentDapp, type RecentDapp } from './recent-dapps';
// PR-6: persistence for cold-bubble restore across app restart.
export {
  loadPersistedSessions,
  savePersistedSessions,
  upsertPersistedSession,
  removePersistedSession,
  clearAllPersistedSessions,
  toPersisted,
  fromPersisted,
  type PersistedSession
} from './session-persistence';
export {
  writeSnapshotToDisk,
  readSnapshotFromDisk,
  removeSnapshotFromDisk,
  clearAllSnapshotsFromDisk
} from './snapshot-persistence';
