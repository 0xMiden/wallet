import { useEffect } from 'react';

import { classifySyncError, isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearReachabilityIssues, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { computeSyncBackoffMs, MAX_CONSECUTIVE_SYNC_FAILURES } from 'lib/miden/sync-backoff';
import { isExtension } from 'lib/platform';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { syncGuardianAccounts } from './guardian-sync';
import { requestNotesRefresh } from './note-refresh';
import { isTestSyncPaused } from './test-sync-pause';

const SYNC_INTERVAL_MS = 3_000;

const immediateSyncListeners = new Set<() => void>();

export function requestImmediateSync(): void {
  for (const listener of immediateSyncListeners) listener();
}

function triggerSync(intercom: ReturnType<typeof getIntercom>) {
  if (isInsideSendFlow() || isTestSyncPaused()) return;
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
    let isRunning = false;
    let retryAfterCurrentRun = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Consecutive sync-failure streak, gating the connectivity banner (#596)
    // and, at the same threshold, the circuit breaker (#777).
    let consecutiveSyncFailures = 0;
    // How many backoff windows the breaker has served in a row (#777) — drives
    // the exponential schedule; any successful sync resets it. Effect-scoped
    // like the streak: a remount starts fresh on the 3s cadence, which is the
    // right bias (a remount usually means the user came back).
    let breakerTripCount = 0;

    const runAndSchedule = async () => {
      if (cancelled) return;
      if (isRunning) {
        retryAfterCurrentRun = true;
        return;
      }

      isRunning = true;
      // Flat 3s by default; a tripped breaker stretches THIS reschedule to the
      // backoff window (#777). Guard-skipped ticks (send flow, generating-tx
      // page) keep the flat cadence — they never reach the network, so they
      // must neither serve nor inflate a window.
      let nextDelayMs = SYNC_INTERVAL_MS;
      try {
        // Same guards the old AutoSync had: skip (don't wait for the lock) when
        // a tx is being generated, to avoid queuing sync behind a long prove.
        const onGeneratingTxPage =
          typeof window !== 'undefined' && window.location.href.includes('generating-transaction');
        const inSendFlow = isInsideSendFlow();

        // There used to be a third guard here — `isMobile() && isTransactionModalOpen`.
        // The transaction progress modal it referred to has been removed, and nothing
        // sets that flag any more, so the guard was permanently false. The two
        // remaining checks (the generating-transaction route and the send flow) are
        // what actually keep a sync from queueing behind a long prove.
        if (!onGeneratingTxPage && !inSendFlow && !isTestSyncPaused()) {
          useWalletStore.getState().setSyncStatus(true);
          try {
            // The sync-specific watchdog ceiling (#777): on wasm32 the SDK's
            // gRPC-web fetch carries no transport deadline, so a parked sync
            // would otherwise hold the lock until the 5-minute last resort —
            // on mobile that is the whole app's WASM access. Expiry evicts the
            // hold and replaces the client; the next tick syncs on a fresh one.
            await withWasmClientLock(
              async () => {
                const client = await getMidenClient();
                if (!client || cancelled) return;
                await client.syncState();
                // Sync genuinely went through — break the failure streak. Kept
                // inside the lock callback so an unmount that flips `cancelled`
                // before the sync (early return above) can't falsely reset it.
                consecutiveSyncFailures = 0;
                breakerTripCount = 0;
              },
              { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
            );
            clearReachabilityIssues();
            // The sync just imported any new notes; surface them NOW instead of
            // waiting out the claimable-notes SWR interval (up to 5s) — the note
            // read runs after the sync's wasm lock has been released (#462).
            requestNotesRefresh();

            const guardianAccountKeys = useWalletStore
              .getState()
              .accounts.filter(acc => acc.type === WalletType.Guardian)
              .map(acc => acc.publicKey);
            if (guardianAccountKeys.length > 0) {
              await syncGuardianAccounts().catch(() => {});
            }
          } catch (error) {
            consecutiveSyncFailures++;
            console.warn(
              `[useSyncTrigger] sync error (${consecutiveSyncFailures}/${MAX_CONSECUTIVE_SYNC_FAILURES}):`,
              error
            );
            // Gate the connectivity banner on a *sustained* failure streak,
            // matching the service-worker path (#273). markConnectivityIssue is
            // idempotent, so re-marking on each further failure while it's up is a
            // no-op; a later successful sync resets the streak and clears it (#596).
            if (isLikelyNetworkError(error) && consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
              markConnectivityIssue(classifySyncError(error));
            }
            // The breaker (#777): a sustained failure streak stops the flat 3s
            // hammering — mirroring the SW path's exponential schedule — so an
            // idle wallet backs off a rate-limiting node instead of feeding it
            // the burst that precedes the freeze. Counted per FAILED ATTEMPT,
            // not per tick, so windows only grow while probes actually fail.
            if (consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
              nextDelayMs = computeSyncBackoffMs(++breakerTripCount);
            }
          } finally {
            useWalletStore.getState().setSyncStatus(false);
          }
        }
      } finally {
        isRunning = false;
        if (!cancelled) {
          // `retryAfterCurrentRun` (a banner Retry or app foreground) probes
          // straight through an open backoff window — user-driven, and the
          // probe's own outcome decides what happens next.
          const delay = retryAfterCurrentRun ? 0 : nextDelayMs;
          retryAfterCurrentRun = false;
          timer = setTimeout(runAndSchedule, delay);
        }
      }
    };

    const retryNow = () => {
      if (cancelled) return;
      if (isRunning) {
        retryAfterCurrentRun = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      void runAndSchedule();
    };

    immediateSyncListeners.add(retryNow);
    runAndSchedule();

    return () => {
      cancelled = true;
      immediateSyncListeners.delete(retryNow);
      if (timer) clearTimeout(timer);
    };
  }, [status]);
}
