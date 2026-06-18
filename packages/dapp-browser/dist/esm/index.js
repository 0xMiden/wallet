import { registerPlugin } from '@capacitor/core';
const InAppBrowser = registerPlugin('InAppBrowser', {
    web: () => import('./web').then((m) => new m.InAppBrowserWeb()),
});
export * from './definitions';
export { InAppBrowser };
// Miden patch (PR-4 chunk 6): re-export the multi-instance helpers from
// the package root so wallet code can import { dappWebViewManager,
// DappWebViewInstance } from '@miden/dapp-browser' alongside the legacy
// InAppBrowser export.
export { DappWebViewInstance, dappWebViewManager } from './multi-instance.js';
//# sourceMappingURL=index.js.map