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

/**
 * Reconnect backoff for the INTERCOM port.
 *
 * The old behaviour was a flat 1s retry with no ceiling and no give-up, which
 * is why a wallet page whose receiving end had gone away logged
 * "Could not establish connection" once per second for as long as the page
 * stayed open. Backing off keeps a genuinely-transient MV3 service-worker
 * restart cheap to recover from (first retry is still fast) while making a
 * permanently-dead receiving end quiet.
 */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** A port that survives this long is treated as healthy, resetting the backoff. */
const RECONNECT_HEALTHY_MS = 10_000;

/**
 * True when the error means this JS context can never reach the extension
 * again — the context was orphaned by a reload/update/uninstall. Retrying is
 * pointless forever, not just for now, so the loop stops instead of spinning.
 */
function isContextInvalidated(error: unknown): boolean {
  const message = typeof error === 'string' ? error : ((error as { message?: string } | undefined)?.message ?? '');
  return /extension context invalidated|context invalidated|extension is disabled/i.test(message);
}

export class IntercomClient implements IIntercomClient {
  private port: any; // Runtime.Port - typed as any to avoid import
  private reqId: number;
  private portReady: Promise<void>;
  /** Consecutive failed reconnects; drives the backoff. */
  private reconnectAttempts = 0;
  /** Set once the context is orphaned — stops the reconnect loop for good. */
  private stopped = false;

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
   * Allows to subscribe to notifications channel from background process
   */
  subscribe(callback: (data: any) => void) {
    // Note: This is sync but port might not be ready yet
    // In practice, this is called after the app is loaded
    const listener = (msg: any) => {
      if (msg?.type === MessageType.Sub) {
        callback(msg.data);
      }
    };

    // Wait for port to be ready before subscribing
    this.portReady.then(() => {
      this.port.onMessage.addListener(listener);
    });

    return () => {
      if (this.port) {
        this.port.onMessage.removeListener(listener);
      }
    };
  }

  private buildPort(browser: any) {
    const port = browser.runtime.connect({ name: 'INTERCOM' });

    // A port that stays up is a working port: clear the backoff so the NEXT
    // service-worker recycle reconnects promptly instead of inheriting the
    // delay from an unrelated earlier outage.
    const healthyTimer = setTimeout(() => {
      this.reconnectAttempts = 0;
    }, RECONNECT_HEALTHY_MS);

    port.onDisconnect.addListener(() => {
      clearTimeout(healthyTimer);

      // READ the error. When `connect()` finds no receiving end, Chrome sets
      // `runtime.lastError` and fires this listener; a listener that does not
      // read it is exactly what makes Chrome log
      // "Unchecked runtime.lastError: Could not establish connection."
      // Reading it here is what marks it handled — the console spam this
      // silences was one line per retry, in every tab, via the content script.
      const error = port.error ?? browser.runtime?.lastError;

      if (this.stopped) return;

      if (isContextInvalidated(error)) {
        // Orphaned by an extension reload/update: this context can never
        // reconnect, so retrying would spin until the tab closes.
        this.stopped = true;
        return;
      }

      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
      this.reconnectAttempts++;

      setTimeout(async () => {
        if (this.stopped) return;
        try {
          const nextBrowser = await getBrowser();
          this.port = this.buildPort(nextBrowser);
        } catch (e) {
          // `connect()` throws synchronously once the context is gone.
          if (isContextInvalidated(e)) this.stopped = true;
        }
      }, delay);
    });

    return port;
  }

  private send(msg: RequestMessage) {
    this.port.postMessage(msg);
  }
}
