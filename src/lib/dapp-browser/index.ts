export { INJECTION_SCRIPT } from './injection-script';
export { handleWebViewMessage } from './message-handler';
export type { WebViewMessage, WebViewResponse } from './message-handler';
export { createDappSession, parseOrigin, type DappSession, type DappSessionStatus } from './dapp-session';
export { buildFaviconUrl, getFaviconUrl, setFavicon, getFallbackColor, getFallbackLetter } from './favicon-cache';
export { rectFromDOMRect, rectsEqual, type WebViewRect } from './webview-rect';
export { useDappConfirmation, type UseDappConfirmationResult } from './use-dapp-confirmation';
export { FEATURED_DAPPS, type FeaturedDapp } from './featured-dapps';
