import { useEffect } from 'react';

import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension, isMobile } from 'lib/platform';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { syncGuardianAccounts } from './guardian-sync';

const SYNC_INTERVAL_MS = 3_000;

function triggerSync(intercom: ReturnType<typeof getIntercom>) {
  if (isInsideSendFlow()) return;
  intercom
    .request({ type: WalletMessageType.SyncRequest })
    .then(() => {
      // Guardian sync runs in the frontend where the wallet is unlocked and signWord is available
      const guardianAccountKeys = useWalletStore
        .getState()
        .accounts.filter(acc => acc.type === WalletType.Guardian)
        .map(acc => acc.publicKey);
      if (guardianAccountKeys.length > 0) {
        syncGuardianAccounts().catch(() => {});
      }
    })
    .catch(() => {});
}

/**
 * Returns true when the wallet is inside the Send flow (any step of
 * SendManager — SelectToken, SelectRecipient, SelectAmount, Review, etc.).
 *
 * Woozie routes the extension under a hash URL (`USE_LOCATION_HASH_AS_URL`),
 * so the Send root is reachable at `#/send`. All internal SendManager steps
 * live under that same hash prefix.
 *
 * We pause `syncState` polling while the user is in the Send flow because:
 *   - `SelectToken` renders its TST tile from `useAllBalances → fetchBalances
 *     → getAccount` — an IndexedDB read serialized by the SDK. When sync is
 *     holding the SDK's internal queue on a slow testnet (5-25s per tick),
 *     the balance read waits and Playwright's 10s click budget on the tile
 *     times out.
 *   - The Send flow doesn't need fresh chain state to let the user pick a
 *     token / recipient / amount. The sync that matters for Send happens
 *     after submit, not during selection.
 */
function isInsideSendFlow(): boolean {
  if (typeof window === 'undefined') return false;
  // Hash can be `#/send`, `#/send/`, `#/send?...`, etc.
  return window.location.hash.startsWith('#/send');
}

/**
 * Periodic sync every 3s while the wallet is Ready.
 *
 * - Extension: sends SyncRequest to the service worker, which runs syncState()
 *   on its warm WASM client and broadcasts SyncCompleted with notes + balances.
 * - Mobile / desktop: calls client.syncState() directly in-process (under the
 *   wasm client lock), mirroring the old AutoSync behaviour that was removed
 *   when the zustand balance/sync state was handed off to the React SDK.
 *   Without this, nothing polls on mobile and the UI never sees new notes.
 *
 * After each chain sync, Guardian accounts are synced in the frontend context
 * (where the wallet is unlocked and signWord is available).
 *
 * Sync is paused for the duration of the Send flow (see `isInsideSendFlow`).
 */
export function useSyncTrigger() {
  const status = useWalletStore(s => s.status);

  useEffect(() => {
    if (status !== WalletStatus.Ready) return;

    if (isExtension()) {
      const intercom = getIntercom();
      const tick = () => triggerSync(intercom);
      tick();
      const timer = setInterval(tick, SYNC_INTERVAL_MS);
      return () => clearInterval(timer);
    }

    // Mobile / desktop: direct in-process sync (restored from old AutoSync).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const runAndSchedule = async () => {
      if (cancelled) return;

      // Same guards the old AutoSync had: skip (don't wait for the lock) when
      // a tx is being generated, to avoid queuing sync behind a long prove.
      const storeState = useWalletStore.getState();
      const onGeneratingTxPage =
        typeof window !== 'undefined' && window.location.href.includes('generating-transaction');
      const mobileTxModalOpen = isMobile() && storeState.isTransactionModalOpen;
      const inSendFlow = isInsideSendFlow();

      if (!onGeneratingTxPage && !mobileTxModalOpen && !inSendFlow) {
        useWalletStore.getState().setSyncStatus(true);
        try {
          await withWasmClientLock(async () => {
            const client = await getMidenClient();
            if (!client || cancelled) return;
            await client.syncState();
          });

          // Guardian sync runs outside the WASM lock — HTTP calls only.
          const guardianAccountKeys = useWalletStore
            .getState()
            .accounts.filter(acc => acc.type === WalletType.Guardian)
            .map(acc => acc.publicKey);
          if (guardianAccountKeys.length > 0) {
            await syncGuardianAccounts().catch(() => {});
          }
        } catch (error) {
          console.warn('[useSyncTrigger] sync error:', error);
        } finally {
          // Mirrors the old AutoSync: flipping isSyncing false also sets
          // hasCompletedInitialSync=true, which the header spinner watches.
          useWalletStore.getState().setSyncStatus(false);
        }
      }

      if (!cancelled) {
        timer = setTimeout(runAndSchedule, SYNC_INTERVAL_MS);
      }
    };
    runAndSchedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status]);
}
