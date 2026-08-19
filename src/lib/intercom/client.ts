import type { Browser } from 'webextension-polyfill';

import { isDesktop, isMobile } from 'lib/platform';

import { deserializeError } from './helpers';
import { MessageType, RequestMessage } from './types';

/**
 * Interface for intercom clients (extension, mobile, and desktop)
 */
export interface IIntercomClient {
  request(payload: any, options?: { signal?: AbortSignal }): Promise<any>;
  subscribe(callback: (data: any) => void): () => void;
}

// Lazy-loaded browser polyfill (only loaded in extension context)
let browserInstance: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    const module = await import('webextension-polyfill');
    browserInstance = module.default;
  }
  return browserInstance;
}

// Lazy-loaded mobile adapter (only loaded in mobile context)
let mobileAdapterModule: typeof import('./mobile-adapter') | null = null;
async function getMobileAdapter() {
  if (!mobileAdapterModule) {
    mobileAdapterModule = await import('./mobile-adapter');
  }
  return mobileAdapterModule.getMobileIntercomAdapter();
}

// Lazy-loaded desktop adapter (only loaded in desktop context)
let desktopAdapterModule: typeof import('./desktop-adapter') | null = null;
async function getDesktopAdapter() {
  if (!desktopAdapterModule) {
    desktopAdapterModule = await import('./desktop-adapter');
  }
  return desktopAdapterModule.getDesktopIntercomAdapter();
}

/**
 * Creates the appropriate intercom client based on the platform
 */
export function createIntercomClient(): IIntercomClient {
  const mobile = isMobile();
  const desktop = isDesktop();

  // Extra check for Tauri - look for globals directly
  const hasTauriGlobal = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

  if (mobile) {
    return new MobileIntercomClientWrapper();
  }

  // Use desktop adapter if either isDesktop() returns true OR we detect Tauri globals
  if (desktop || hasTauriGlobal) {
    return new DesktopIntercomClientWrapper();
  }

  // Extension: use browser.runtime port messaging
  return new IntercomClient();
}

/**
 * Wrapper that lazily loads the mobile adapter
 */
class MobileIntercomClientWrapper implements IIntercomClient {
  private adapterPromise: Promise<IIntercomClient> | null = null;

  private getAdapter(): Promise<IIntercomClient> {
    if (!this.adapterPromise) {
      this.adapterPromise = getMobileAdapter();
    }
    return this.adapterPromise;
  }

  async request(payload: any, options?: { signal?: AbortSignal }): Promise<any> {
    const adapter = await this.getAdapter();
    return adapter.request(payload, options);
  }

  subscribe(callback: (data: any) => void): () => void {
    let unsubscribe: (() => void) | null = null;
    this.getAdapter().then(adapter => {
      unsubscribe = adapter.subscribe(callback);
    });
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }
}

/**
 * Wrapper that lazily loads the desktop adapter
 */
class DesktopIntercomClientWrapper implements IIntercomClient {
  private adapterPromise: Promise<IIntercomClient> | null = null;

  private getAdapter(): Promise<IIntercomClient> {
    if (!this.adapterPromise) {
      this.adapterPromise = getDesktopAdapter();
    }
    return this.adapterPromise;
  }

  async request(payload: any, options?: { signal?: AbortSignal }): Promise<any> {
    const adapter = await this.getAdapter();
    return adapter.request(payload, options);
  }

  subscribe(callback: (data: any) => void): () => void {
    let unsubscribe: (() => void) | null = null;
    this.getAdapter().then(adapter => {
      unsubscribe = adapter.subscribe(callback);
    });
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }
}

export class IntercomClient implements IIntercomClient {
  private port: any; // Runtime.Port - typed as any to avoid import
  private reqId: number;
  private portReady: Promise<void>;
  /**
   * Broadcast subscribers, held on the INSTANCE rather than on a port.
   *
   * A `Runtime.Port` dies whenever the MV3 service worker is evicted, restarted
   * or reloaded, and `buildPort`'s `onDisconnect` handler replaces `this.port`
   * with a brand-new one. A listener attached directly to the old port object is
   * gone at that moment and nothing re-attaches it — `request()` survives only
   * because it re-reads `this.port` per call, which is exactly what made the loss
   * invisible. Keeping the callbacks here (mirroring the mobile/desktop adapters,
   * which hold a plain `Set` no transport can drop) lets `buildPort` re-attach one
   * dispatching listener to every port it creates.
   */
  private readonly subscribers = new Set<(data: any) => void>();

  constructor() {
    this.reqId = 0;
    this.portReady = this.initPort();
  }

  private async initPort() {
    try {
      const browser = await getBrowser();
      this.port = this.buildPort(browser);
    } /* c8 ignore start -- port init errors untestable with mock getBrowser */ catch (error) {
      throw error;
    } /* c8 ignore stop */
  }

  /**
   * Makes a request to background process and returns a response promise
   */
  async request(payload: any, options?: { signal?: AbortSignal }): Promise<any> {
    await this.portReady;
    const reqId = this.reqId++;
    const port = this.port;

    this.send({ type: MessageType.Req, data: payload, reqId });

    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        // port may already be disconnected & replaced by onDisconnect — don't
        // let its onMessage throw through cleanup.
        try {
          port.onMessage.removeListener(listener);
        } catch {
          /* noop */
        }
        if (options?.signal) options.signal.removeEventListener('abort', onAbort);
      };
      const listener = (msg: any) => {
        if (msg?.reqId !== reqId) return;
        if (msg?.type === MessageType.Res) resolve(msg.data);
        else if (msg?.type === MessageType.Err) reject(deserializeError(msg.data));
        cleanup();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Aborted'));
      };

      port.onMessage.addListener(listener);
      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort);
      }
    });
  }

  /**
   * Allows to subscribe to notifications channel from background process.
   *
   * Registration is against the instance-level {@link subscribers} set, not
   * against whichever port happens to be live — see that field for why. Safe to
   * call before the first port exists: every port `buildPort` creates gets the
   * dispatching listener, so a callback registered at any time receives every
   * later broadcast.
   */
  subscribe(callback: (data: any) => void) {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Attach the single dispatching `Sub` listener to a freshly-created port. One
   * throwing subscriber must not stop the others from being notified, nor bubble
   * into the extension's message plumbing.
   */
  private attachSubscriptionListener(port: any) {
    port.onMessage.addListener((msg: any) => {
      if (msg?.type !== MessageType.Sub) return;
      for (const callback of this.subscribers) {
        try {
          callback(msg.data);
        } catch (err) {
          console.error('[intercom] subscriber threw while handling a broadcast', err);
        }
      }
    });
  }

  private buildPort(browser: any) {
    const port = browser.runtime.connect({ name: 'INTERCOM' });
    // Re-attach on EVERY port, including the ones built by the reconnect below —
    // otherwise the first service-worker restart silently ends all broadcasts
    // (lock/StateUpdated, SyncCompleted, NoteClaimStarted) for this page.
    this.attachSubscriptionListener(port);
    port.onDisconnect.addListener(() => {
      setTimeout(async () => {
        const browser = await getBrowser();
        this.port = this.buildPort(browser);
      }, 1000);
    });

    return port;
  }

  private send(msg: RequestMessage) {
    this.port.postMessage(msg);
  }
}
