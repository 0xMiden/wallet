import { InAppBrowser } from './index.js';
/**
 * Multi-instance dApp browser API.
 *
 * The legacy `InAppBrowser` export is a single-instance proxy: every
 * call goes to a hardcoded `'default'` instance. PR-4 chunks 2-5 made
 * the native plugin id-aware so multiple webviews can coexist; this
 * file is the JS-side ergonomic layer that wraps that with per-instance
 * objects + a `dappWebViewManager` factory.
 *
 * Usage from the wallet (PR-4 chunk 7):
 *
 *   import { dappWebViewManager } from '@miden/dapp-browser';
 *
 *   const inst = await dappWebViewManager.open({ url: 'https://miden.xyz' });
 *   await inst.setVisible(false);   // park
 *   const snap = await inst.snapshot(0.5);
 *   await inst.setVisible(true);    // restore (state preserved)
 *   await inst.close();
 */

function generateId() {
  // Crypto.randomUUID is available on iOS WKWebView 16+ / Android WebView 102+
  // (current min targets are well above), but fall back to a timestamp +
  // random just in case.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'dapp-' + crypto.randomUUID();
  }
  return 'dapp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class DappWebViewInstance {
  constructor(id) {
    this.id = id;
  }

  /** Move the webview to the given rect (delegates to updateDimensions). */
  setRect(rect) {
    return InAppBrowser.updateDimensions({
      id: this.id,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    });
  }

  /** Toggle this instance's visibility. The WebView's JS context survives. */
  setVisible(visible) {
    return InAppBrowser.setVisible({ id: this.id, visible });
  }

  /** Take a JPEG snapshot of the current page as a base64 data URL. */
  snapshot(scale = 0.5, quality = 0.7) {
    return InAppBrowser.snapshot({ id: this.id, scale, quality });
  }

  /** Inject JS into this instance's webview. */
  executeScript(code) {
    // The native executeScript method is currently single-instance-only.
    // Until we add an id-aware variant, callers must keep this instance as
    // the foreground 'default' before calling executeScript. The wallet's
    // PR-3 useDappBrowserWebView already wraps this — chunk 7's migration
    // routes through the same path.
    return InAppBrowser.executeScript({ code });
  }

  /** Close this instance and tear down its WebView. */
  close() {
    return InAppBrowser.close({ id: this.id });
  }
}

const liveInstances = new Map();

export const dappWebViewManager = {
  /**
   * Open a new dApp webview. If `id` is omitted, a UUID is generated. If
   * an instance with the given id already exists in this manager's map, the
   * existing one is returned (idempotent — protects against double-open
   * races without throwing).
   */
  async open(opts) {
    const id = opts.id || generateId();
    const existing = liveInstances.get(id);
    if (existing) return existing;
    await InAppBrowser.openWebView({ ...opts, id });
    const instance = new DappWebViewInstance(id);
    liveInstances.set(id, instance);
    return instance;
  },

  /** Look up a previously-opened instance by id. */
  get(id) {
    return liveInstances.get(id);
  },

  /** Snapshot of all live JS-side instances. Doesn't query the native registry. */
  list() {
    return Array.from(liveInstances.values());
  },

  /**
   * Re-sync the JS-side cache from the native registry. Useful after a
   * cold start when the native side may already have instances from a
   * previous app session (PR-6 cold-bubble restore).
   */
  async sync() {
    const result = await InAppBrowser.listInstances();
    liveInstances.clear();
    for (const id of result.ids || []) {
      liveInstances.set(id, new DappWebViewInstance(id));
    }
  },

  /** Close every live instance. Used on app shutdown / wallet reset. */
  async closeAll() {
    await InAppBrowser.closeAll();
    liveInstances.clear();
  }
};
