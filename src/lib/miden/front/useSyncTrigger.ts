import { useEffect } from 'react';

import { classifySyncError, isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearReachabilityIssues, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import {
  isWasmClientPoisonedError,
  poisonReasonOf,
  WASM_LOCK_SYNC_WATCHDOG_MS
} from 'lib/miden/sdk/wasm-client-poison';
import {
  computeSyncBackoffMs,
  MAX_CONSECUTIVE_SYNC_FAILURES,
  MAX_SYNC_BACKOFF_MS,
  monotonicNowMs
} from 'lib/miden/sync-backoff';
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
    // End of the open backoff window (#777) on the monotonic clock, null when
    // none is open. A DEADLINE rather than a one-shot delay, for the same reason
    // the SW path keeps one: a tick the guards skip (send flow, generating-tx
    // page) does not run a probe, so it must not be able to cancel a window
    // either — with a one-shot delay it silently reset the cadence to 3s and the
    // wallet went straight back to probing a node it had just decided to back
    // off from. Monotonic, not `Date.now()`, and `null` rather than 0 for "no
    // window", because 0 is a real stamp on that clock — see `monotonicNowMs`.
    let syncBackoffUntilMs: number | null = null;

    const runAndSchedule = async () => {
      if (cancelled) return;
      if (isRunning) {
        retryAfterCurrentRun = true;
        return;
      }

      isRunning = true;
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
            const synced = await withWasmClientLock(
              async () => {
                const client = await getMidenClient();
                if (!client || cancelled) return false;
                await client.syncState();
                return true;
              },
              { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
            );
            // Break the failure streak only on a sync that genuinely went
            // through. Reported OUT of the lock callback rather than assigned
            // inside it, because an eviction ABANDONS that callback without
            // cancelling it (#775): a sync that overran the ceiling and then
            // settled would run these resets late, after the catch below had
            // already counted the eviction as a failure — zeroing the streak
            // from a hold the loop had given up on. A node slow enough to be
            // evicted every time would then never trip the breaker at all,
            // and keep the 3s cadence this backoff exists to stop. The flag
            // still distinguishes a real sync from the `!client || cancelled`
            // early return, which is why the reset is not simply unconditional
            // after the await.
            if (synced) {
              consecutiveSyncFailures = 0;
              breakerTripCount = 0;
              // Clear the window too, not just the counters: a user Retry (or an
              // app foreground) probes straight through an open window, so a
              // success can land mid-window — leaving the deadline standing
              // would reschedule onto its remainder and keep the wallet backed
              // off from a node that just answered.
              syncBackoffUntilMs = null;
            }
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
            // A WATCHDOG eviction is transport-shaped in every way that matters
            // to the user: on the sync path it means the node stopped answering
            // and the parked gRPC-web fetch had to be torn off the lock. Its
            // message is a closed wallet-authored string, so it matches none of
            // `isLikelyNetworkError`'s tokens — the same reason the SW path
            // special-cases its own synthetic `Sync timeout` alongside that
            // predicate. Without this the #777 hang is the one failure that
            // backs off SILENTLY: no banner, and therefore no Retry, which is
            // the only affordance that probes through an open window.
            //
            // The other poison reason is deliberately excluded. A `realm-error`
            // eviction is a WASM trap in this realm, not an unreachable node, so
            // `classifySyncError`'s only verdict ('node') would tell the user
            // something false — and it needs no banner anyway: the client is
            // replaced in milliseconds and the next 3s tick syncs on a fresh
            // one, which is precisely the case Retry cannot improve on.
            const transportShaped =
              isLikelyNetworkError(error) || (isWasmClientPoisonedError(error) && poisonReasonOf(error) === 'watchdog');
            if (transportShaped && consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
              markConnectivityIssue(classifySyncError(error));
            }
            // The breaker (#777): a sustained failure streak stops the flat 3s
            // hammering so an idle wallet backs off a rate-limiting node
            // instead of feeding it the burst that precedes the freeze.
            // Counted per FAILED ATTEMPT, not per tick, so windows only grow
            // while probes actually fail.
            if (consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
              syncBackoffUntilMs = monotonicNowMs() + computeSyncBackoffMs(++breakerTripCount);
            }
          } finally {
            useWalletStore.getState().setSyncStatus(false);
          }
        }
      } finally {
        isRunning = false;
        if (!cancelled) {
          // Flat 3s, or the rest of an open backoff window if one outlasts it.
          // Reading the deadline here rather than carrying a per-run delay is
          // what makes a guard-skipped tick harmless: it reschedules on
          // whatever is LEFT of the window instead of resetting to 3s.
          //
          // `retryAfterCurrentRun` (a banner Retry or app foreground) probes
          // straight through an open window — user-driven, and the probe's own
          // outcome decides what happens next. The window is deliberately left
          // standing rather than cleared, exactly as the SW path's `force`
          // bypasses `syncBackoffUntilMs` without resetting it: one punch-
          // through should not hand the node back the 3s cadence.
          //
          // Clamped to the curve's own maximum on the way out: this timer is the
          // loop's ONLY driver, so an over-large remainder would not merely
          // stretch a backoff, it would stop syncing altogether for that long.
          // The monotonic clock makes that hard to reach; the clamp makes it
          // impossible, and costs nothing when the deadline is sane.
          const backoffRemainingMs =
            syncBackoffUntilMs === null ? 0 : Math.min(syncBackoffUntilMs - monotonicNowMs(), MAX_SYNC_BACKOFF_MS);
          const delay = retryAfterCurrentRun ? 0 : Math.max(SYNC_INTERVAL_MS, backoffRemainingMs);
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
