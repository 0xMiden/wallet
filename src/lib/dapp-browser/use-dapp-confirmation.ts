/**
 * React hook for the dApp confirmation flow.
 *
 * Subscribes to `dappConfirmationStore` and exposes the current pending
 * request (if any) plus a `resolve` callback. The React confirmation
 * modal renders when `request !== null` and calls `resolve` when the
 * user approves or denies.
 *
 * In PR-1 there's only one possible pending request at a time (the store
 * is still single-instance). PR-4 refactors the store to a per-session
 * map and this hook becomes per-session aware.
 */

import { useEffect, useState } from 'react';

import { type DAppConfirmationRequest, type DAppConfirmationResult, dappConfirmationStore } from './confirmation-store';

export interface UseDappConfirmationResult {
  request: DAppConfirmationRequest | null;
  resolve: (result: DAppConfirmationResult) => void;
}

export function useDappConfirmation(): UseDappConfirmationResult {
  const [request, setRequest] = useState<DAppConfirmationRequest | null>(() =>
    dappConfirmationStore.getPendingRequest()
  );

  useEffect(() => {
    return dappConfirmationStore.subscribe(() => {
      setRequest(dappConfirmationStore.getPendingRequest());
    });
  }, []);

  return {
    request,
    resolve: (result: DAppConfirmationResult) => dappConfirmationStore.resolveConfirmation(result)
  };
}
