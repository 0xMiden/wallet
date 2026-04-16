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
 * Read the SW's last-broadcast sync snapshot from chrome.storage.local and
 * invoke `onData` with it if present and for the current account.
 */
/* c8 ignore start -- extension-only chrome.storage bridge */
function readSyncData(accountPublicKey: string, onData: (d: SyncData) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.chrome?.storage?.local) return;
  g.chrome.storage.local.get('miden_sync_data', (result: any) => {
    const syncData: SyncData | undefined = result?.miden_sync_data;
    if (!syncData) return;
    if (syncData.accountPublicKey !== accountPublicKey) return;
    onData(syncData);
  });
}

/**
 * One-shot balance rehydration from the SW's last sync snapshot.
 * Used on app mount so `useAllBalances` has something real to render
 * instead of falling back to DEFAULT_ZERO_MIDEN_BALANCE while the 3s poll
 * catches up.
 */
async function rehydrateBalancesFromStorage(accountPublicKey: string): Promise<void> {
  await new Promise<void>(resolve => {
    readSyncData(accountPublicKey, syncData => {
      updateBalancesFromSyncData(syncData.accountPublicKey, syncData.vaultAssets)
        .catch(err => console.warn('[useIntercomSync] Initial balance rehydrate failed:', err))
        .finally(() => resolve());
    });
    // Resolve anyway if there's no sync data yet — don't block app mount.
    setTimeout(resolve, 1_000);
  });
}
/* c8 ignore stop */

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
      /* c8 ignore next -- ref guard for double-mount in StrictMode */
      if (initialFetchDone.current) return;
      initialFetchDone.current = true;

      try {
        const state = await fetchStateFromBackend(5);
        syncFromBackend(state);

        // Rehydrate balances from the last SW sync snapshot BEFORE the app
        // renders. Without this, any non-MIDEN token (e.g. a custom faucet)
        // is missing from `useAllBalances` until the 3s poll ticks below,
        // so Send's token list shows only the MIDEN fallback for the first
        // few seconds after any page (re)load. Surfaced by the E2E stress
        // suite — receivers that claim mid-run would render Send as
        // MIDEN-only until the next poll cycle.
        if (isExtension() && state.currentAccount) {
          await rehydrateBalancesFromStorage(state.currentAccount.publicKey);
        }
      } /* c8 ignore next 3 -- retry path, requires backend error simulation */ catch (error) {
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
  // Re-run when currentAccount changes so the first poll isn't wasted
  // (on mount, currentAccount is null until initial state fetch completes).
  const currentAccount = useWalletStore(s => s.currentAccount);

  /* c8 ignore start -- extension-only chrome.storage.local polling */
  useEffect(() => {
    if (!isExtension()) return;
    if (!currentAccount) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (!g.chrome?.storage?.local) return;

    const accountPublicKey = currentAccount.publicKey;
    const store = useWalletStore.getState;

    const poll = () => {
      readSyncData(accountPublicKey, syncData => {
        const noteIds = syncData.notes.map(n => n.id);

        // Drop claiming IDs for notes that are no longer consumable (the SW has
        // confirmed the consume). A blanket reset here would defeat the
        // isBeingClaimed gate used by Explore's auto-consume, because
        // NoteClaimStarted broadcasts fire once while this poll ticks every 3s.
        const consumableIds = new Set(noteIds);
        const staleClaimingIds: string[] = [];
        for (const id of store().extensionClaimingNoteIds) {
          if (!consumableIds.has(id)) staleClaimingIds.push(id);
        }
        if (staleClaimingIds.length > 0) {
          store().removeExtensionClaimingNoteIds(staleClaimingIds);
        }

        // Note: we used to call `store().checkForNewNotes(noteIds)` here too.
        // `useNoteToastMonitor` (driven by `useClaimableNotes`) is now the single
        // authoritative source for new-note detection — having two racing paths
        // caused flaky toasts (spurious toasts when this poll landed before the
        // async `seenNoteIds` hydration resolved; missing toasts when custom-faucet
        // metadata arrived after Path A's notes had already been marked seen).
        // Convert vault assets → balances, update Zustand
        updateBalancesFromSyncData(syncData.accountPublicKey, syncData.vaultAssets).catch(err =>
          console.warn('[useIntercomSync] Balance update failed:', err)
        );
      });
    };

    poll();
    const timer = setInterval(poll, 3_000);
    return () => clearInterval(timer);
  }, [currentAccount]);
  /* c8 ignore stop */

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
