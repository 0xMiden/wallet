import { useEffect } from 'react';

import { MidenState } from 'lib/miden/types';
import { isExtension } from 'lib/platform';
import { NoteClaimStarted, SyncData, WalletMessageType, WalletNotification } from 'lib/shared/types';

import { getIntercom, useWalletStore } from '../index';
import { updateBalancesFromSyncData } from '../utils/updateBalancesFromSyncData';

/**
 * Retry config for GetStateRequest. The MV3 service worker's cold-start
 * (WASM init + initial chain sync) can take tens of seconds on slow machines;
 * a fixed budget was the cause of #113 (popup white-screens with no recovery).
 */
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 3_000; // cap of the exponential growth
const PER_ATTEMPT_TIMEOUT_MS = 3_000;
const WARN_AFTER_ATTEMPTS = 20; // ~1 min of failed retries — indicates a wedged SW

/**
 * Keep trying `fetchStateFromBackend` until it succeeds or `isCancelled`
 * returns true. Emits a single `console.warn` once `WARN_AFTER_ATTEMPTS` is
 * crossed so a permanently-wedged SW surfaces in logs / analytics instead of
 * spinning invisibly.
 */
async function retryFetchState(isCancelled: () => boolean): Promise<MidenState | null> {
  let backoffMs = INITIAL_BACKOFF_MS;
  let attempt = 0;
  let warned = false;
  while (!isCancelled()) {
    try {
      return await fetchStateFromBackend();
    } /* c8 ignore next 11 -- retry path exercised by fake-timers test */ catch (error) {
      if (isCancelled()) return null;
      attempt += 1;
      if (!warned && attempt >= WARN_AFTER_ATTEMPTS) {
        warned = true;
        console.warn(
          `[useIntercomSync] backend unresponsive after ${WARN_AFTER_ATTEMPTS} attempts; still retrying:`,
          error
        );
      }
      const wait = backoffMs;
      await new Promise(resolve => setTimeout(resolve, wait));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
  return null;
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

  useEffect(() => {
    // The backend broadcasts `StateUpdated` once SW init completes (see
    // main.ts:start), which is caught by the subscriber below — either path
    // hydrates the store. Unbounded retry here is a belt-and-braces guarantee
    // that a missed broadcast or slow port setup never leaves the popup
    // permanently stuck (the failure mode in #113).
    let cancelled = false;

    (async () => {
      const state = await retryFetchState(() => cancelled);
      if (cancelled || !state) return;
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
    })();

    return () => {
      cancelled = true;
    };
  }, [syncFromBackend]);

  useEffect(() => {
    // Subscribe to state updates from backend
    const intercom = getIntercom();

    const setSyncStatus = useWalletStore.getState().setSyncStatus;

    const store = useWalletStore.getState;

    // Each StateUpdated broadcast launches a retry-wrapped refetch. A slow
    // retry from an earlier broadcast must not clobber the newer state, so we
    // cancel the previous loop's token on every new broadcast (and on unmount).
    let currentRefetchToken = { cancelled: false };

    const unsubscribe = intercom.subscribe((msg: WalletNotification) => {
      if (msg?.type === WalletMessageType.StateUpdated) {
        currentRefetchToken.cancelled = true;
        const token = { cancelled: false };
        currentRefetchToken = token;
        retryFetchState(() => token.cancelled).then(state => {
          if (state && !token.cancelled) syncFromBackend(state);
        });
      } else if (msg?.type === WalletMessageType.SyncCompleted) {
        // Service worker finished a sync cycle — update sync status
        setSyncStatus(false);
      } else if (msg?.type === WalletMessageType.NoteClaimStarted) {
        if (isExtension()) {
          store().addExtensionClaimingNoteId((msg as NoteClaimStarted).noteId);
        }
      }
    });

    return () => {
      currentRefetchToken.cancelled = true;
      unsubscribe();
    };
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
}

/**
 * Fetch state from backend — single attempt, bounded by
 * `PER_ATTEMPT_TIMEOUT_MS`. On timeout the underlying intercom request is
 * aborted via AbortController so the port listener is removed (otherwise the
 * extension port would accumulate dead listeners across retries — the intercom
 * port is long-lived and only recycled on disconnect).
 *
 * Callers that want to keep trying until the SW is ready should wrap this in
 * `retryFetchState` (see above).
 */
async function fetchStateFromBackend(): Promise<MidenState> {
  const intercom = getIntercom();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await intercom.request({ type: WalletMessageType.GetStateRequest }, { signal: controller.signal });
    if (res?.type !== WalletMessageType.GetStateResponse) {
      throw new Error('Invalid response type');
    }
    return res.state;
  } finally {
    clearTimeout(timer);
  }
}

export { fetchStateFromBackend, retryFetchState };
