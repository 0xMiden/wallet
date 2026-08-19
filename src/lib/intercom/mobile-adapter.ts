import * as Actions from 'lib/miden/back/actions';
import { store, toFront } from 'lib/miden/back/store';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

import { processInProcessRequest } from './in-process-request-handler';

type SubscriptionCallback = (data: any) => void;

/**
 * Mobile adapter for intercom that directly calls backend handlers
 * instead of using browser extension port messaging.
 */
export class MobileIntercomAdapter {
  private initialized = false;
  private subscribers: Set<SubscriptionCallback> = new Set();

  /**
   * Initialize the mobile backend
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    console.log('MobileIntercomAdapter: Initializing backend');
    await Actions.init();

    // E2E-only (dead-stripped in prod): mobile runs a single page/backend
    // context, so the bridge-in reconciliation hooks — which the extension
    // installs SW-side in back/main.ts — are installed here. They only
    // create/read a tracking row and set a module var (no SW-direct signing),
    // so they run correctly in the mobile WebView.
    if (process.env.MIDEN_E2E_TEST === 'true') {
      const { installBridgeInTestHooks } = await import('lib/miden/activity/bridge-in-test-hooks');
      installBridgeInTestHooks();
    }

    // Watch store changes and notify subscribers
    const frontStore = store.map(toFront);
    frontStore.watch(() => {
      this.notifySubscribers({ type: WalletMessageType.StateUpdated });
    });

    this.initialized = true;
    console.log('MobileIntercomAdapter: Backend initialized');
  }

  /**
   * Makes a request directly to the backend handlers
   */
  async request(payload: WalletRequest, _options?: { signal?: AbortSignal }): Promise<WalletResponse | void> {
    // Ensure backend is initialized
    if (!this.initialized) {
      await this.init();
    }

    return this.processRequest(payload);
  }

  /**
   * Subscribe to notifications (state updates)
   */
  subscribe(callback: SubscriptionCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Process a request directly. Delegates to the ONE switch shared with the
   * desktop adapter (`processInProcessRequest`); see that module for why the
   * switch no longer lives in the adapters themselves.
   */
  private async processRequest(req: WalletRequest): Promise<WalletResponse | void> {
    return processInProcessRequest(req, 'MobileIntercomAdapter');
  }

  /**
   * Notify all subscribers of a state change
   */
  private notifySubscribers(data: any): void {
    this.subscribers.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('MobileIntercomAdapter: Error in subscriber callback', error);
      }
    });
  }
}

// Singleton instance
let mobileAdapter: MobileIntercomAdapter | null = null;

/**
 * Gets the singleton mobile adapter instance
 */
export function getMobileIntercomAdapter(): MobileIntercomAdapter {
  if (!mobileAdapter) {
    mobileAdapter = new MobileIntercomAdapter();
  }
  return mobileAdapter;
}

export default MobileIntercomAdapter;
