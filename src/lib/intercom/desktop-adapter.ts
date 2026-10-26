/**
 * Desktop adapter for intercom that directly calls backend handlers
 * instead of using browser extension port messaging.
 *
 * Desktop and mobile both run the backend in-process rather than in a separate
 * service worker, and both dispatch requests through the SAME switch
 * (`processInProcessRequest`). Only the lifecycle differs: this adapter has no
 * mobile-only E2E bridge-in hook in `init`.
 */

import * as Actions from 'lib/miden/back/actions';
import { store, toFront } from 'lib/miden/back/store';
import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';

import { processInProcessRequest } from './in-process-request-handler';

type SubscriptionCallback = (data: any) => void;

/**
 * Desktop adapter for intercom that directly calls backend handlers
 * instead of using browser extension port messaging.
 */
export class DesktopIntercomAdapter {
  private initialized = false;
  private subscribers: Set<SubscriptionCallback> = new Set();

  /**
   * Initialize the desktop backend
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    console.log('DesktopIntercomAdapter: Initializing backend');
    await Actions.init();

    // Watch store changes and notify subscribers
    const frontStore = store.map(toFront);
    frontStore.watch(() => {
      this.notifySubscribers({ type: WalletMessageType.StateUpdated });
    });

    this.initialized = true;
    console.log('DesktopIntercomAdapter: Backend initialized');
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
   * mobile adapter (`processInProcessRequest`) so the two in-process adapters
   * cannot drift again — desktop used to implement 16 of the 27 message types
   * and silently dropped the 11 guardian ones.
   */
  private async processRequest(req: WalletRequest): Promise<WalletResponse | void> {
    return processInProcessRequest(req, 'DesktopIntercomAdapter');
  }

  /**
   * Notify all subscribers of a state change
   */
  private notifySubscribers(data: any): void {
    this.subscribers.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('DesktopIntercomAdapter: Error in subscriber callback', error);
      }
    });
  }
}

// Singleton instance
let desktopAdapter: DesktopIntercomAdapter | null = null;

/**
 * Gets the singleton desktop adapter instance
 */
export function getDesktopIntercomAdapter(): DesktopIntercomAdapter {
  if (!desktopAdapter) {
    desktopAdapter = new DesktopIntercomAdapter();
  }
  return desktopAdapter;
}

export default DesktopIntercomAdapter;
