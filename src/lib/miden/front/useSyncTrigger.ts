import { useEffect } from 'react';

import { classifySyncError, isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearReachabilityIssues, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isSyncWatchdogEviction, WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import {
  computeSyncBackoffMs,
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_SYNC_FAILURES,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
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

/**
 * The fuse's evidence and its deadline (#777), deliberately at MODULE scope
 * while the breaker's state is effect-scoped.
 *
 * What the fuse knows is a fact about the REALM's WASM client, not about this
 * effect: the dead in-flight sync promise lives in the SDK's module-level map
 * and outlives any remount. The effect, meanwhile, is rebuilt on every
 * `status` transition — so an idle auto-lock followed by an unlock used to
 * throw the evidence away and hand a provably parked realm back the 3s
 * cadence, plus four more two-minute evictions to re-earn a conclusion it had
 * already reached. Eight minutes of the whole app's WASM access, per unlock.
 *
 * The breaker's own state stays effect-scoped, and that asymmetry is the
 * point: a remount there legitimately means the user came back and a node
 * outage may well be over, whereas a remount tells you nothing at all about a
 * promise parked in a module the remount did not touch.
 *
 * A standing deadline rather than a flag plus the breaker's window, because
 * the two must not share one field: while fused, any single non-watchdog
 * failure re-entered the breaker's arm and overwrote the fused deadline with a
 * window at most a fifth as long, so one offline blip mid-fuse cost the user
 * the whole cadence. Kept separate, the scheduler simply waits for the later
 * of the two.
 */
let realmWatchdogEvictions = 0;
let realmFusedUntilMs: number | null = null;

/** Test-only: the module-scoped fuse above would otherwise leak between tests. */
export function __resetSyncFuseStateForTests(): void {
  realmWatchdogEvictions = 0;
  realmFusedUntilMs = null;
}

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
    // Whether the NEXT run was asked for by the user (banner Retry, app
    // foreground) rather than the timer. Granted by `retryNow`, consumed by the
    // run it precedes. Its job is to keep a user's attempt out of the automatic
    // cadence's two ledgers — it neither escalates the breaker nor adds to (or
    // withdraws from) the fuse's evidence. It grants no SCHEDULING privilege,
    // because a forced run needs none: it punches through an open window via
    // `retryAfterCurrentRun`, and no guard gates the probe on the fuse.
    let forceNextRun = false;

    const runAndSchedule = async () => {
      if (cancelled) return;
      if (isRunning) {
        retryAfterCurrentRun = true;
        return;
      }

      const forced = forceNextRun;
      forceNextRun = false;
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
            // hold and replaces the client, so the next tick runs on a fresh
            // one — which recovers the MUTEX, not necessarily the sync: the SDK
            // memoises the parked call, so the fresh client may join it (which is
            // what the fuse is for).
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
              // The only thing that clears the fuse. A sync that goes through
              // proves the realm's sync is not parked after all, which is the
              // one observation the fuse is waiting for.
              realmWatchdogEvictions = 0;
              realmFusedUntilMs = null;
              // Gated with the counters rather than run unconditionally after
              // the await: on the `!client || cancelled` early return no sync
              // happened, so dismissing the "cannot reach the node" banner there
              // would clear it on the strength of a torn-down effect.
              clearReachabilityIssues();
            }
            // A teardown mid-sync means this effect no longer owns the loop, so
            // the work that follows the sync belongs to the successor's run, not
            // to this one. (The spinner clear in the `finally` stays
            // unconditional: a successor sets it true at the top of every run,
            // whereas skipping the clear here could strand it true with no owner
            // at all.)
            if (cancelled) return;

            // The sync just imported any new notes; surface them NOW instead of
            // waiting out the claimable-notes SWR interval (up to 5s) — the note
            // read runs after the sync's wasm lock has been released (#462).
            requestNotesRefresh();

            const guardianAccountKeys = useWalletStore
              .getState()
              .accounts.filter(acc => acc.type === WalletType.Guardian)
              .map(acc => acc.publicKey);
            if (guardianAccountKeys.length > 0) {
              // NOT awaited, deliberately. `MultisigService.runSync` retries in a
              // loop and each attempt is its own lock hold, so awaiting it put
              // the guardian endpoint in charge of this loop's cadence: while it
              // hung, `isRunning` stayed true, no next tick was scheduled, the
              // spinner stayed on, and because the failure is swallowed the
              // breaker, the fuse and the banner never saw it. Guardian accounts
              // are the wallet's default type, so that was the #777 freeze with
              // none of the instrumentation #777 added.
              //
              // Safe to fire and forget because `sync()` coalesces overlapping
              // ticks onto one in-flight run, so a slow guardian gets one
              // outstanding sync, not one per tick.
              void syncGuardianAccounts().catch(e => {
                // Per-account failures are already logged inside; this catch is
                // for a throw from the accounts read itself, which would otherwise
                // be the one failure on this path that logs nothing at all.
                console.warn('[useSyncTrigger] guardian sync failed', e);
              });
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
            // The other poison reason is deliberately excluded from the BANNER
            // only. A `realm-error` eviction is a WASM trap in this realm, not
            // an unreachable node, and `classifySyncError` can only answer
            // 'network' or 'node' — neither describes a trap in this realm — so
            // the banner would tell the user something false, and Retry, the
            // affordance it exists to offer, cannot improve on a client that was
            // already replaced in milliseconds. It still counts toward the
            // failure streak and so can still trip the breaker: a realm that
            // traps on every sync should not be probed every 3s either. What it
            // must not do is blow the fuse.
            const transportShaped = isLikelyNetworkError(error) || isSyncWatchdogEviction(error);
            if (transportShaped && consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
              markConnectivityIssue(classifySyncError(error));
            }
            // The breaker (#777): a sustained failure streak stops the flat 3s
            // hammering so an idle wallet backs off a rate-limiting node
            // instead of feeding it the burst that precedes the freeze.
            // Counted per FAILED ATTEMPT, not per tick, so windows only grow
            // while probes actually fail.
            //
            // A user-FORCED probe (banner Retry, app foreground) can open or
            // re-arm a window but never ESCALATES one. Without that exemption a
            // forced probe reached this arm like any other failure, so three
            // Retry taps against a down node walked the user's own wallet from
            // 30s to 240s of enforced silence — the escalation is meant to
            // measure how long the node has been failing, not how many times the
            // user asked.
            //
            // Note this deliberately does NOT mirror the SW path, which zeroes
            // its streak when a window opens (`sync-manager.ts`) and so fires
            // three fast probes between windows. That is the burst #777 exists
            // to stop: one sync tick already issues SyncChainMmr, SyncNotes and
            // SyncTransactions back-to-back, which is the three-429s-in-20ms
            // signature the incident recorded. Keeping the streak latched gives
            // one probe per window, which is what a breaker is for.
            if (consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
              if (!forced) breakerTripCount++;
              syncBackoffUntilMs = monotonicNowMs() + computeSyncBackoffMs(Math.max(1, breakerTripCount));
            }
            // Blow the fuse only on a repeated WATCHDOG eviction, which is the
            // one failure that proves the realm's sync is unrecoverable rather
            // than merely failing: the node accepted the request and never
            // answered, and the SDK will hand the same dead promise to every
            // later probe. Any other error — including a `realm-error` eviction,
            // whose client IS replaced in milliseconds — resets the count, so an
            // ordinary outage keeps retrying on the breaker's schedule as before.
            //
            // Only the loop's OWN probes count, for the same reason they alone
            // escalate the breaker: this measures what the automatic cadence
            // costs, and a user tap is neither part of that cadence nor
            // throttled by it. A forced probe therefore neither adds evidence
            // nor withdraws it.
            if (!forced) {
              if (isSyncWatchdogEviction(error)) {
                realmWatchdogEvictions++;
              } else if (realmFusedUntilMs === null) {
                // Once the fuse is lit, a non-eviction failure does NOT withdraw
                // the evidence: it is no proof the parked sync recovered — only a
                // SUCCESS is that — and zeroing here meant one offline blip
                // mid-fuse bought four fresh evictions, eight more minutes of
                // parked WASM, to re-reach a conclusion nothing had contradicted.
                realmWatchdogEvictions = 0;
              }
              if (realmWatchdogEvictions >= MAX_CONSECUTIVE_WATCHDOG_EVICTIONS) {
                if (realmFusedUntilMs === null) {
                  console.warn(
                    `[useSyncTrigger] ${realmWatchdogEvictions} consecutive sync watchdog evictions — ` +
                      "the realm's sync is parked and replacing the client cannot reach it; dropping automatic " +
                      `probes to one per ${Math.round(FUSED_SYNC_PROBE_INTERVAL_MS / 60_000)} min until one ` +
                      'succeeds (#777)'
                  );
                }
                // Re-armed after EVERY failed probe while the evidence stands,
                // not only after the eviction that lit the fuse. "One probe per
                // 30 min until one succeeds" is the contract, and a probe that
                // fails some other way has not succeeded — arming only on the
                // eviction let the deadline expire and the loop fall back to the
                // breaker's much shorter windows.
                //
                // A DEADLINE rather than a per-run delay, for the same reason the
                // breaker keeps one: a tick the guards skip must serve out the
                // wait, not restart it. As a per-run delay, every skipped tick
                // re-armed the full cadence, so a user who opened the send flow
                // while fused pushed their next probe out by another half hour
                // each time the loop ticked past the guard.
                realmFusedUntilMs = monotonicNowMs() + FUSED_SYNC_PROBE_INTERVAL_MS;
              }
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
          //
          // A fused loop still probes, just far more slowly. Its deadline is
          // read here beside the breaker's and the loop simply waits for the
          // later of the two — each clamped to its OWN maximum, since the fused
          // wait is legitimately longer than anything the breaker's curve can
          // produce and clamping it to that curve would silently shorten it.
          const remainingMs = (until: number | null, ceilingMs: number) =>
            until === null ? 0 : Math.min(until - monotonicNowMs(), ceilingMs);
          const idleMs = Math.max(
            SYNC_INTERVAL_MS,
            remainingMs(syncBackoffUntilMs, MAX_SYNC_BACKOFF_MS),
            remainingMs(realmFusedUntilMs, FUSED_SYNC_PROBE_INTERVAL_MS)
          );
          const delay = retryAfterCurrentRun ? 0 : idleMs;
          retryAfterCurrentRun = false;
          timer = setTimeout(runAndSchedule, delay);
        }
      }
    };

    const retryNow = () => {
      if (cancelled) return;
      forceNextRun = true;
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
