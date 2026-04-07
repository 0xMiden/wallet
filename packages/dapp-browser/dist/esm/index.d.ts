import type { InAppBrowserPlugin } from './definitions';
declare const InAppBrowser: InAppBrowserPlugin;
export * from './definitions';
export { InAppBrowser };
// Miden patch (PR-4 chunk 6): multi-instance helpers re-exported from
// the package root.
export { DappWebViewInstance, dappWebViewManager } from './multi-instance';
export type { Rect, DappWebViewManager } from './multi-instance';
