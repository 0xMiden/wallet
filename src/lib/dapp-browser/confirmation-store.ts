/**
 * Store for managing DApp confirmation requests on mobile.
 *
 * On mobile we can't open popup windows like the extension does, so the
 * backend (`lib/miden/back/dapp.ts`) hands off to this store and waits
 * for the React frontend to render a confirmation modal that resolves
 * the request.
 *
 * PR-4 chunk 8 — multi-session refactor:
 *  - PR-3 used a single `pendingRequest` slot, which prevented two dApps
 *    from having confirmations in flight at the same time. With multi-
 *    instance dApps (PR-4 chunk 7), the store now keys requests by
 *    `sessionId`, so an arbitrary number of confirmations can be in
 *    flight in parallel — one per session.
 *  - The frontend modal still shows ONE request at a time (the one for
 *    the current foreground session), so the bubble for a parked dApp
 *    with a pending confirmation can later restore that session and
 *    immediately surface the confirmation.
 *  - Backwards compat: callers that don't supply a `sessionId` (the
 *    extension flow, faucet-webview, native-notifications) get a
 *    "default" key. Their behavior is unchanged.
 */

import { PrivateDataPermission, AllowedPrivateData } from '@demox-labs/miden-wallet-adapter-base';

import { DappMetadata } from 'lib/miden/types';

export interface DAppConfirmationRequest {
  id: string;
  /**
   * Multi-instance session id (matches the `id` of the
   * `DappWebViewInstance` that originated the request). Optional —
   * non-multi-instance callers (extension popup, faucet-webview, etc.)
   * may omit this and the store keys them under the legacy "default"
   * slot. PR-4 chunk 8.
   */
  sessionId?: string;
  type: 'connect' | 'sign' | 'transaction' | 'consume';
  origin: string;
  appMeta: DappMetadata;
  network: string;
  networkRpc: string;
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
  existingPermission: boolean;
  // Transaction-specific fields
  transactionMessages?: string[];
  sourcePublicKey?: string;
}

export interface DAppConfirmationResult {
  confirmed: boolean;
  accountPublicKey?: string;
  privateDataPermission?: PrivateDataPermission;
  // Transaction-specific result
  delegate?: boolean;
}

type ConfirmationResolver = (result: DAppConfirmationResult) => void;

interface PendingEntry {
  request: DAppConfirmationRequest;
  resolver: ConfirmationResolver;
}

const DEFAULT_SESSION_KEY = '__default__';

function keyFor(sessionId: string | undefined): string {
  return sessionId ?? DEFAULT_SESSION_KEY;
}

/**
 * Multi-session confirmation coordinator. One pending request per session
 * key. Frontend subscribers re-render whenever a request is added or
 * resolved on any session.
 */
class DAppConfirmationStore {
  private pending: Map<string, PendingEntry> = new Map();
  private listeners: Set<() => void> = new Set();
  private instanceId = Math.random().toString(36).substring(7);

  constructor() {
    console.log('[DAppConfirmationStore] Created instance:', this.instanceId);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Request confirmation from the user. Returns a promise that resolves
   * when the user approves or denies the request via the React modal.
   *
   * If a confirmation is already pending for the same session id, the
   * existing pending request is implicit-rejected (treated as canceled)
   * before being replaced, so the old promise never leaks. In practice
   * dappQueue serializes requests per dApp so this edge case is rare —
   * the guard is defensive.
   */
  requestConfirmation(request: DAppConfirmationRequest): Promise<DAppConfirmationResult> {
    const key = keyFor(request.sessionId);
    const previous = this.pending.get(key);
    if (previous) {
      previous.resolver({ confirmed: false });
    }
    return new Promise(resolve => {
      this.pending.set(key, { request, resolver: resolve });
      this.notifyListeners();
    });
  }

  /**
   * Resolve the pending confirmation for a session id. If sessionId is
   * undefined, resolves the legacy default slot (extension/desktop
   * single-session callers).
   */
  resolveConfirmation(sessionId: string | undefined, result: DAppConfirmationResult): void {
    const key = keyFor(sessionId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    entry.resolver(result);
    this.notifyListeners();
  }

  /**
   * Get the pending request for a specific session id, or for the legacy
   * default slot if undefined.
   */
  getPendingRequest(sessionId?: string): DAppConfirmationRequest | null {
    return this.pending.get(keyFor(sessionId))?.request ?? null;
  }

  /**
   * Get all pending requests across every session. Used by the React
   * provider to surface badge counts on parked-bubble overlays.
   */
  getAllPendingRequests(): DAppConfirmationRequest[] {
    return Array.from(this.pending.values()).map(entry => entry.request);
  }

  /**
   * Check if there's any pending confirmation. Without a sessionId
   * argument, returns true if ANY session has a pending request.
   */
  hasPendingRequest(sessionId?: string): boolean {
    if (sessionId === undefined) {
      return this.pending.size > 0;
    }
    return this.pending.has(keyFor(sessionId));
  }

  /** Subscribe to store changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }
}

// Export singleton instance
export const dappConfirmationStore = new DAppConfirmationStore();
