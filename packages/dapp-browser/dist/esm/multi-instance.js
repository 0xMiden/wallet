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
  constructor(id, managedHostCloseToken) {
    this.id = id;
    this.managedHostCloseToken = managedHostCloseToken;
    this.closed = false;
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
    // PR-4 chunk 7: native executeScript is now id-aware on iOS and Android,
    // so the call routes to this specific instance's WebView even when other
    // dApps are open in parallel.
    return InAppBrowser.executeScript({ id: this.id, code });
  }

  /** Close this instance and tear down its WebView. */
  close() {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    if (this.managedHostCloseToken) closingInstances.set(this.id, this.managedHostCloseToken);
    this.closePromise = InAppBrowser.close({ id: this.id, managedHostCloseToken: this.managedHostCloseToken })
      .finally(() => {
        // A host-owned reservation also waits for its persisted cleanup.
        if (!this.closed && closingInstances.get(this.id) === this.managedHostCloseToken) closingInstances.delete(this.id);
        this.closed = true;
        if (liveInstances.get(this.id)?.instance === this) liveInstances.delete(this.id);
      });
    return this.closePromise;
  }
}

const liveInstances = new Map();
const closingInstances = new Map();

export const dappWebViewManager = {
  /**
   * Open a new dApp webview. If `id` is omitted, a UUID is generated. If
   * an instance with the given id already exists in this manager's map, the
   * existing one is returned (idempotent — protects against double-open
   * races without throwing).
   */
  async open(opts) {
    const id = opts.id || generateId();
    if (closingInstances.has(id)) throw new Error("A managed instance is closing");
    const existing = liveInstances.get(id);
    if (existing?.instance.managedHostCloseToken && existing.instance.managedHostCloseToken !== opts.managedHostClose?.token)
      throw new Error("A managed instance already owns this id");
    if (existing) return existing.opening;
    const instance = new DappWebViewInstance(id, opts.managedHostClose?.token);
    const entry = { instance, opening: null };
    liveInstances.set(id, entry);
    entry.opening = InAppBrowser.openWebView({ ...opts, id }).then(() => instance, error => {
      instance.closed = true;
      if (liveInstances.get(id) === entry) liveInstances.delete(id);
      throw error;
    });
    return entry.opening;
  },

  reserveClose(id, token) {
    const entry = liveInstances.get(id);
    if (!entry || entry.instance.managedHostCloseToken !== token) return;
    closingInstances.set(id, token);
    entry.instance.closed = true;
    liveInstances.delete(id);
  },

  forget(id, token) {
    if (closingInstances.get(id) === token) closingInstances.delete(id);
    const entry = liveInstances.get(id);
    if (!entry || entry.instance.managedHostCloseToken !== token) return;
    entry.instance.closed = true;
    liveInstances.delete(id);
  },

  /** Look up a previously-opened instance by id. */
  get(id) {
    return liveInstances.get(id)?.instance;
  },

  /** Snapshot of all live JS-side instances. Doesn't query the native registry. */
  list() {
    return Array.from(liveInstances.values(), entry => entry.instance);
  },

  /**
   * Re-sync the JS-side cache from the native registry. Useful after a
   * cold start when the native side may already have instances from a
   * previous app session (PR-6 cold-bubble restore).
   */
  async sync() {
    const result = await InAppBrowser.listInstances();
    for (const [id, entry] of liveInstances) {
      if (!(result.ids || []).includes(id)) {
        entry.instance.closed = true;
        liveInstances.delete(id);
      }
    }
    for (const id of result.ids || []) {
      if (liveInstances.has(id) || closingInstances.has(id)) continue;
      const instance = new DappWebViewInstance(id);
      liveInstances.set(id, { instance, opening: Promise.resolve(instance) });
    }
  },

  /** Close every live instance. Used on app shutdown / wallet reset. */
  async closeAll() {
    for (const [id, entry] of liveInstances) {
      entry.instance.closed = true;
      if (entry.instance.managedHostCloseToken) closingInstances.set(id, entry.instance.managedHostCloseToken);
    }
    const closing = new Map(closingInstances);
    liveInstances.clear();
    await InAppBrowser.closeAll();
    for (const [id, token] of closing) if (closingInstances.get(id) === token) closingInstances.delete(id);
  }
};
