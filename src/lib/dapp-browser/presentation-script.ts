export interface PresentationMessage {
  token: string;
  type: 'configure' | 'ready' | 'close';
  requestId?: string;
  display?: 'browser' | 'fullscreen';
  manualReady?: boolean;
  themeColor?: string;
}

export interface PresentationResponse {
  token: string;
  requestId: string;
  ok: boolean;
  error?: string;
}

/** Document-start API for the native Bread dApp WebView. */
export const PRESENTATION_SCRIPT = `
(function() {
  if (window.top !== window || window.__breadPresentationToken) return;
  const ios = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.breadPresentation;
  const android = window.breadPresentation;
  const transport = ios || android;
  if (!transport || typeof transport.postMessage !== 'function') return;

  // Native provenance and navigation-generation checks remain the authority for this token.
  const random = new Uint32Array(4);
  crypto.getRandomValues(random);
  const token = Array.from(random, value => value.toString(16).padStart(8, '0')).join('');
  const pending = new Map();
  let sequence = 0;
  let configuration;
  let settled = false;
  // Metadata requests fullscreen; only native confirmation changes the padding policy.
  let state = Object.freeze({ token, display: 'browser' });

  function send(message) {
    transport.postMessage(JSON.stringify({ token, ...message }));
  }
  function request(type) {
    if (pending.size >= 32) return Promise.reject(new Error('Too many pending presentation requests'));
    return new Promise((resolve, reject) => {
      const requestId = 'presentation_' + (++sequence);
      // Transport bounds are separate from native's foreground-only readiness budget.
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Presentation request timed out'));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        send({ type, requestId });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  Object.defineProperty(window, '__breadPresentationToken', { value: token });
  Object.defineProperty(window, '__breadPresentationState', { get: () => state });
  Object.defineProperty(window, '__breadPresentationRespond', { value: function(response) {
    if (!response || response.token !== token || typeof response.requestId !== 'string' || typeof response.ok !== 'boolean') return;
    const call = pending.get(response.requestId);
    if (!call) return;
    pending.delete(response.requestId);
    clearTimeout(call.timer);
    if (response.ok) call.resolve();
    else call.reject(new Error(typeof response.error === 'string' ? response.error : 'Presentation request rejected'));
  } });
  Object.defineProperty(window, '__breadPresentationUpdate', { value: function(update) {
    if (!update || update.token !== token || (update.display !== 'fullscreen' && update.display !== 'browser')) return;
    if (!Number.isFinite(update.controlInsetTop) || update.controlInsetTop < 0) return;
    state = Object.freeze({ token, display: update.display });
    document.documentElement.style.setProperty('--bread-control-inset-top', update.controlInsetTop + 'px');
    document.dispatchEvent(new Event('breadpresentationchange'));
  } });
  const presentation = Object.freeze({ ready: () => request('ready'), close: () => request('close') });
  Object.defineProperty(window, 'bread', { value: Object.freeze({ version: 1, presentation }) });

  function metadata() {
    const head = document.head;
    const display = head && head.querySelector('meta[name="bread-display"]');
    const ready = head && head.querySelector('meta[name="bread-ready"]');
    const theme = head && head.querySelector('meta[name="theme-color"]');
    return {
      type: 'configure',
      display: display && display.content === 'fullscreen' ? 'fullscreen' : 'browser',
      manualReady: Boolean(ready && ready.content === 'manual'),
      ...(theme && theme.content ? { themeColor: theme.content } : {})
    };
  }
  function configure(final) {
    const next = metadata();
    // Only fullscreen opts into preparation before the head has finished parsing.
    if (!final && next.display !== 'fullscreen') return;
    const key = JSON.stringify(next);
    if (key !== configuration) {
      configuration = key;
      send(next);
    }
    return next;
  }
  const observer = new MutationObserver(() => configure(false));
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['name', 'content'] });
  configure(false);
  function loaded() {
    if (settled) return;
    settled = true;
    // Launch metadata settles once; later application mutations cannot reconfigure it.
    observer.disconnect();
    const final = configure(true);
    if (!final.manualReady) request('ready').catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loaded, { once: true });
  else loaded();
})();
`;
