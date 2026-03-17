import { useEffect, useRef } from 'react';

import retry from 'async-retry';

import { MidenState } from 'lib/miden/types';
import { isExtension } from 'lib/platform';
import { NoteClaimStarted, SyncData, WalletMessageType, WalletNotification } from 'lib/shared/types';

import { getIntercom, useWalletStore } from '../index';
import { updateBalancesFromSyncData } from '../utils/updateBalancesFromSyncData';

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

    const store = useWalletStore.getState;

    const unsubscribe = intercom.subscribe((msg: WalletNotification) => {
      if (msg?.type === WalletMessageType.StateUpdated) {
        // Refetch state when backend notifies of changes
        fetchStateFromBackend(0)
          .then(syncFromBackend)
          .catch(error => console.error('Failed to sync state:', error));
      } else if (msg?.type === WalletMessageType.SyncCompleted) {
        // Service worker finished a sync cycle — update sync status
        setSyncStatus(false);
      } else if (msg?.type === WalletMessageType.NoteClaimStarted) {
        if (isExtension()) {
          store().addExtensionClaimingNoteId((msg as NoteClaimStarted).noteId);
        }
      }
    });

    return unsubscribe;
  }, [syncFromBackend]);

  // Poll balance data from chrome.storage.local (vault assets).
  // Notes are polled separately by useExtensionClaimableNotes.
  useEffect(() => {
    if (!isExtension()) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (!g.chrome?.storage?.local) return;

    const store = useWalletStore.getState;

    const poll = () => {
      g.chrome.storage.local.get('miden_sync_data', (result: any) => {
        const syncData: SyncData | undefined = result?.miden_sync_data;
        if (!syncData) return;

        const currentAccount = store().currentAccount;
        if (!currentAccount || syncData.accountPublicKey !== currentAccount.publicKey) return;

        // Clear stale claiming IDs (sync data is authoritative)
        store().clearExtensionClaimingNoteIds();
        // Trigger note toast check (so popup shows toast for new notes)
        const noteIds = syncData.notes.map(n => n.id);
        store().checkForNewNotes(noteIds);
        // Convert vault assets → balances, update Zustand
        updateBalancesFromSyncData(syncData.accountPublicKey, syncData.vaultAssets).catch(err =>
          console.warn('[useIntercomSync] Balance update failed:', err)
        );
      });
    };

    poll();
    const timer = setInterval(poll, 3_000);
    return () => clearInterval(timer);
  }, []);

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
