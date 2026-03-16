import { useEffect, useRef } from 'react';

import retry from 'async-retry';

import { MidenState } from 'lib/miden/types';
import { WalletMessageType, WalletNotification } from 'lib/shared/types';

import { getIntercom, useWalletStore } from '../index';

/** Wraps a promise with a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), ms);
  });
  return Promise.race([promise, timeoutPromise]);
}

/**
 * Hook that sets up synchronization between the Zustand store and the backend.
 * Should be used once at the root of the app.
 */
export function useIntercomSync() {
  const syncFromBackend = useWalletStore(s => s.syncFromBackend);
  const isInitialized = useWalletStore(s => s.isInitialized);
  const initialFetchDone = useRef(false);

  useEffect(() => {
    // Fetch initial state
    const fetchInitialState = async () => {
      if (initialFetchDone.current) return;
      initialFetchDone.current = true;

      try {
        const state = await fetchStateFromBackend(5);
        syncFromBackend(state);
      } catch (error) {
        console.error('Failed to fetch initial state:', error);
        initialFetchDone.current = false; // Allow retry
      }
    };

    fetchInitialState();
  }, [syncFromBackend]);

  useEffect(() => {
    // Subscribe to state updates from backend
    const intercom = getIntercom();

    const setSyncStatus = useWalletStore.getState().setSyncStatus;

    const unsubscribe = intercom.subscribe((msg: WalletNotification) => {
      if (msg?.type === WalletMessageType.StateUpdated) {
        // Refetch state when backend notifies of changes
        fetchStateFromBackend(0)
          .then(syncFromBackend)
          .catch(error => console.error('Failed to sync state:', error));
      } else if (msg?.type === WalletMessageType.SyncCompleted) {
        // Service worker finished a sync cycle — update sync status
        setSyncStatus(false);
      }
    });

    return unsubscribe;
  }, [syncFromBackend]);

  return isInitialized;
}

/**
 * Fetch state from backend with retry logic
 */
async function fetchStateFromBackend(maxRetries: number = 0): Promise<MidenState> {
  const intercom = getIntercom();

  const res = await retry(
    async () => {
      return withTimeout(
        (async () => {
          const res = await intercom.request({ type: WalletMessageType.GetStateRequest });
          if (res?.type !== WalletMessageType.GetStateResponse) {
            throw new Error('Invalid response type');
          }
          return res;
        })(),
        3_000
      );
    },
    { retries: maxRetries, minTimeout: 0, maxTimeout: 0 } as Parameters<typeof retry>[1]
  );

  return res.state;
}

export { fetchStateFromBackend };
