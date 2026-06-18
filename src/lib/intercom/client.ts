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
