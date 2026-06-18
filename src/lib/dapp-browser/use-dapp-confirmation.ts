/**
 * React hook for the dApp confirmation flow.
 *
 * Subscribes to `dappConfirmationStore` and exposes the current pending
 * request (if any) for either:
 *  - a specific session id (PR-4 chunk 8 multi-session mode), or
 *  - the legacy default slot (no sessionId arg → falls back to whatever
 *    request exists in the default slot, used by extension popup +
 *    desktop dapp browser).
 *
 * The provider modal calls `useDappConfirmation(foregroundId)` to render
 * the request belonging to the foreground session, while parked sessions
 * with their own pending requests stay queued — the user surfaces them
 * by tapping the corresponding bubble.
 */

import { useEffect, useState } from 'react';

import { type DAppConfirmationRequest, type DAppConfirmationResult, dappConfirmationStore } from './confirmation-store';

export interface UseDappConfirmationResult {
  request: DAppConfirmationRequest | null;
  resolve: (result: DAppConfirmationResult) => void;
}

/**
 * @param sessionId - if provided, returns only the pending request for
 *   that session id; otherwise returns the request from the legacy
 *   default slot (extension/desktop single-session flow).
 */
export function useDappConfirmation(sessionId?: string): UseDappConfirmationResult {
  const [request, setRequest] = useState<DAppConfirmationRequest | null>(() =>
    dappConfirmationStore.getPendingRequest(sessionId)
  );

  useEffect(() => {
    setRequest(dappConfirmationStore.getPendingRequest(sessionId));
    return dappConfirmationStore.subscribe(() => {
      setRequest(dappConfirmationStore.getPendingRequest(sessionId));
    });
  }, [sessionId]);

  return {
    request,
    resolve: (result: DAppConfirmationResult) => dappConfirmationStore.resolveConfirmation(sessionId, result)
  };
}
