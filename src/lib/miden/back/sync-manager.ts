import browser from 'webextension-polyfill';

import { getMessage } from 'lib/i18n';
import { classifySyncError, isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearReachabilityIssues, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { getQuarantinedNoteIds } from 'lib/miden/note-quarantine';
import { computeSyncBackoffMs, MAX_CONSECUTIVE_SYNC_FAILURES, monotonicNowMs } from 'lib/miden/sync-backoff';
import {
  areBackgroundSettingsMirrored,
  isAutoConsumeEnabledAsync,
  isDelegateProofEnabledAsync
} from 'lib/settings/helpers';
import { SerializedConsumableNote, SerializedVaultAsset, SyncData, WalletMessageType } from 'lib/shared/types';

import { toNoteTypeString } from '../helpers';
import { fetchTokenMetadata } from '../metadata';
import { showBackgroundNotification } from './background-notification';
import { getIntercom } from './defaults';
import { midenClientProxy } from './miden-client-proxy';
import { mergeAndPersistSeenNoteIds } from './note-checker-storage';
import { Vault } from './vault';
import { getFaucetIdSetting } from '../assets';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { classifySwapOrderNotes, localSwapOrders } from '../swap/classification';
import { reconcileSwapOrderNotes } from '../swap/settlement';
import { initiateConsumeTransaction } from '../transaction/initiate';
import { sweepNoteDeliveries } from '../transaction/note-delivery-sweep';
import { ConsumableNote, NoteTypeEnum } from '../types';

// `init_vault` is the ESM module factory for `./vault`, injected by Vite's
// SW bundle transform. We must NOT add a source-level binding (e.g.
// `declare const init_vault`) because Rolldown would rename the factory to
// `init_vault$1` to avoid the collision, breaking the lazy accessor at
// runtime. The @ts-expect-error below is the intended escape hatch.

const ALARM_NAME = 'miden-sync';

// Watchdog ceiling for a single syncState call. On testnet with slow RPC a
// sync can legitimately take 5-25s, so this is set well above the typical
// worst case: it exists to catch a genuinely wedged sync, not to cap a
// slow-but-healthy one. Note this timeout does NOT release the WASM client
// WASM work early — withTimeout (below) only rejects the outer promise; the
// underlying syncState keeps running. It DOES release the JS mutex, because the
// rejection propagates out of the lock callback (which is why this hold needs no
// watchdog ceiling of its own — see `WASM_LOCK_SYNC_WATCHDOG_MS`), but the
// abandoned sync still occupies the SDK's in-flight map, so an aggressive ceiling
// buys little and merely turns healthy slow syncs into spurious "node
// unreachable" reports.
// On a real breach the circuit breaker (below) trips and we back off.
const SYNC_TIMEOUT_MS = 30_000;

// Circuit breaker: after MAX_CONSECUTIVE_SYNC_FAILURES timeouts/errors in
// a row we skip sync attempts for the backoff window, then allow probes until
// the streak fills again (the inline loop is stricter — one probe per window —
// see `sync-backoff.ts`). A
// successful sync resets the counter. Protects both the wasm client and the
// RPC backend from being hammered when the network (or the node) is flapping.
// The parameters are shared with the mobile/desktop inline loop (#777) — see
// `lib/miden/sync-backoff`. Re-exported so this module's own test can keep
// asserting the curve through the path that consumes it; new callers should
// import from `sync-backoff` directly.
export { computeSyncBackoffMs };

// Concurrent doSync() callers join the in-flight sync instead of being dropped.
// The previous boolean-guard silently no-op'd concurrent calls, so a single stuck
// sync made every triggerSync() during that window return without having synced.
let inFlight: Promise<void> | null = null;
let queuedForcedSync: Promise<void> | null = null;

// Circuit-breaker state. Module-level is fine — the SW process is the only
// doSync caller in the extension path; mobile/desktop runs have one sync loop.
let consecutiveSyncFailures = 0;
// On the monotonic clock (`monotonicNowMs`), like the inline loop's: a wall-clock
// deadline stepped backwards keeps this window "open" for the size of the step,
// and while the alarm keeps firing, every attempt inside it is skipped — so the
// user-visible outcome is a wallet that stops syncing, same as on mobile. Safe to
// hold monotonically because the window is module state that dies with the SW
// realm; it is never persisted across a restart.
//
// Which cuts the other way too, and is worth knowing: an idle MV3 worker is
// terminated between alarm wakes, so with no page open each wake starts with no
// window at all and the breaker only really holds while a page keeps the worker
// alive. Not introduced here — the `Date.now()` state it replaced was just as
// realm-local — and not a freeze risk on this platform, where the alarm is
// clamped to one minute anyway. `null` rather than 0 for "no
// window": 0 is a real stamp on this clock (it is the time origin), so the
// sentinel has to be outside the number domain — see `monotonicNowMs`.
let syncBackoffUntilMs: number | null = null;
// How many times the breaker has tripped in a row (drives the exponential
// backoff); reset by any successful sync.
let breakerTripCount = 0;

// Lazy Vault initialization to prevent service worker cold-start race.
// See actions.ts:getVault for the full explanation. In Jest, `init_vault`
// is undefined; the typeof guard skips the factory call.
let _vault: typeof Vault | null = null;
async function getVault() {
  if (!_vault) {
    // @ts-expect-error init_vault is injected by Vite's SW bundle transform
    if (typeof init_vault === 'function') await init_vault();
    _vault = Vault;
  }
  return _vault;
}

export function doSync(force = false): Promise<void> {
  if (inFlight) {
    if (!force) return inFlight;
    if (!queuedForcedSync) {
      queuedForcedSync = inFlight
        .catch(() => {})
        .then(() => {
          queuedForcedSync = null;
          return doSync(true);
        });
    }
    return queuedForcedSync;
  }
  // Circuit-breaker: short-circuit if recent syncs failed and we're waiting out
  // the backoff window. Returning resolved-void here keeps the existing contract
  // for callers (triggerSync, alarm) that don't distinguish success from skip.
  if (!force && syncBackoffUntilMs !== null && monotonicNowMs() < syncBackoffUntilMs) {
    return Promise.resolve();
  }
  inFlight = runSync(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(force: boolean): Promise<void> {
  try {
    // Skip if wallet not set up
    const vault = await getVault();
    const exists = await vault.isExist();
    if (!exists) return;

    // [Lock 1] THE sync for the whole app. The timeout bounds only the
    // RPC itself, NOT the lock acquisition — when a local prove is in
    // flight it holds the wasm-client mutex for the full prove window
    // (~5–15 s on a typical send/consume), and previously that contention
    // looked indistinguishable from a real node-unreachable timeout. The
    // banner that fires on `markConnectivityIssue('node')` is the
    // user-visible "cannot reach the miden node" toast, and seeing it
    // every time a local-prove tx runs is the wrong UX. With the bound
    // around the RPC only, a queued sync waits patiently behind the
    // prove (which itself yields the lock via `yieldWasmClientLock`
    // around the offscreen-doc step, so the wait is short), then runs
    // its actual network call — and only THAT call's slowness fires
    // the timeout. A subsequent sync after the prove yields is the one
    // that clears any active issue, so the steady state is correct.
    try {
      await withWasmClientLock(async () => {
        await withTimeout(midenClientProxy.syncState(), SYNC_TIMEOUT_MS);
      });
      consecutiveSyncFailures = 0;
      syncBackoffUntilMs = null;
      breakerTripCount = 0;
      // Sync went through end-to-end: the user has connectivity AND the
      // node is responding. Clear any active reachability category. We
      // don't touch `prover` — that's a separate service with separate
      // health and is owned by withProverFallback.
      clearReachabilityIssues();
    } catch (err) {
      consecutiveSyncFailures++;
      console.warn(
        `[SyncManager] syncState failed (${consecutiveSyncFailures}/${MAX_CONSECUTIVE_SYNC_FAILURES}):`,
        err
      );
      // Only surface a connectivity banner once failures are *sustained*.
      // Testnet RPC syncs can legitimately run longer than the watchdog
      // window, so a lone failure (especially a synthetic `Sync timeout`)
      // routinely fires while the node is healthy and block height is still
      // advancing; banner-ing on it produces a flapping false "node
      // unreachable". Gate the banner on the same MAX_CONSECUTIVE_SYNC_FAILURES
      // streak that opens the circuit breaker, so it only appears when the node
      // is persistently unreachable. A later successful sync resets the counter
      // and clears the banner via clearReachabilityIssues().
      if (consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
        // Categorize as network (browser is offline) or node (we reached the
        // open net but the Miden RPC didn't answer). Skip semantic /
        // non-transport errors so a malformed-response bug in the SDK doesn't
        // masquerade as connectivity. The synthetic `Sync timeout` from
        // withTimeout counts — timeouts are themselves transport-shaped.
        if (isLikelyNetworkError(err) || /sync timeout/i.test(String((err as any)?.message ?? err))) {
          markConnectivityIssue(classifySyncError(err));
        }
        // A FORCED sync — one the automatic cadence did not schedule: the banner's
        // Retry (`SyncRequest` with `force`) and the guardian recovery pass's
        // closing sync — opens or re-arms a window but never ESCALATES one,
        // mirroring the frontend loop (#777). Escalation is meant to measure how
        // long the node has been failing, not how many times the user asked:
        // without the exemption three Retry taps against a down node walked the
        // user's own wallet from 30s to 240s of enforced silence, and Retry is the
        // only affordance that probes through an open window.
        if (!force) breakerTripCount++;
        const backoffMs = computeSyncBackoffMs(Math.max(1, breakerTripCount));
        syncBackoffUntilMs = monotonicNowMs() + backoffMs;
        // Zeroed only for an automatic trip. This path is what lets the SW probe a
        // full streak again between windows (deliberate, and unlike the frontend
        // loop — see `sync-backoff.ts`), and letting a forced failure spend the
        // streak turned the exemption into a way to STOP escalating: alternating
        // two automatic failures with one Retry re-armed at trip 1 forever, so the
        // curve never left 30s while the popup kept probing every 3s.
        if (!force) consecutiveSyncFailures = 0;
        console.warn(
          `[SyncManager] circuit breaker open (trip ${breakerTripCount}) — skipping syncs for ${backoffMs}ms`
        );
      }
      // Continue to the downstream read path: the client may still have
      // cached state from a prior successful sync worth surfacing.
    }

    // Private-note delivery sweep. Hosted here rather than in the transaction
    // loop because that loop only runs while there is a transaction to process,
    // and the whole point of the sweep is to act minutes to hours after a send
    // has finished — when, for an otherwise idle wallet, nothing else would ever
    // run it. Placed after the sync attempt so the on-chain consumption receipt
    // it reads is as fresh as this cycle allows, and OUTSIDE the sync's WASM lock
    // because its own proxy calls take that lock themselves.
    //
    // Never allowed to affect the sync: delivery is maintenance behind
    // transactions that have already landed, so a transport problem here must not
    // fail a sync or trip its circuit breaker.
    try {
      await sweepNoteDeliveries();
    } catch (err) {
      console.warn('[SyncManager] private-note delivery sweep failed', err);
    }

    const intercom = getIntercom()!;
    const vault2 = await getVault();
    const accountPubKey = await vault2.getCurrentAccountPublicKey();

    if (accountPubKey) {
      // Loaded once per sync and threaded into classify + reconcile below —
      // localSwapOrders is an unindexed full scan of the transactions table.
      const swapOrderRows = await localSwapOrders(accountPubKey);

      // [Lock 2] Read notes + vault assets from warm WASM client
      const { parsedNotes, vaultAssets } = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        if (!client)
          return { parsedNotes: [] as SerializedConsumableNote[], vaultAssets: [] as SerializedVaultAsset[] };

        // Read consumable notes as DTOs (issue #260, slice 4). The reclaim gate
        // + per-note reduction ran inside the client's realm — OFFSCREEN when the
        // flag is on, so the gate uses the sync-running realm's height instead of
        // a stale SW-inline one. Swap-order lineage inside classifySwapOrderNotes
        // now routes through the proxy too (slice 7a), so it no longer needs `client`.
        const rawNotes = await midenClientProxy.getConsumableNotes(accountPubKey);
        // Notes the pre-confirm dry-run imported to simulate a not-yet-approved
        // custom transaction — hidden from the claimable UI until the user
        // confirms (or forever, if they cancel). See note-quarantine.ts.
        const quarantined = await getQuarantinedNoteIds();
        const swapOrders = await classifySwapOrderNotes(rawNotes, accountPubKey, swapOrderRows);
        const notes: SerializedConsumableNote[] = rawNotes
          .map((note): SerializedConsumableNote | null => {
            // Partial (metadata-less) notes have no ID yet and cannot be
            // consumed — skip until sync completes them.
            const noteId = note.noteId;
            if (!noteId) return null;
            if (quarantined.has(noteId)) return null;
            // Only the first fungible asset is surfaced (unchanged); an empty
            // asset set means the note can't be displayed — skip it.
            const firstAsset = note.assets[0];
            if (!firstAsset) return null;
            return {
              id: noteId,
              faucetId: firstAsset.faucetId,
              amountBaseUnits: firstAsset.amount,
              senderAddress: note.senderAccountId ?? '',
              noteType: note.noteType !== undefined ? toNoteTypeString(note.noteType) : 'unknown',
              recallableAtMs: note.recallableAtMs,
              swapOrder: swapOrders.get(noteId)
            };
          })
          .filter((note): note is SerializedConsumableNote => note !== null);

        // Read vault assets
        const account = await midenClientProxy.getAccount(accountPubKey);
        const assets: SerializedVaultAsset[] = [];
        if (account) {
          const fungibleAssets = account.vault().fungibleAssets();
          for (const asset of fungibleAssets) {
            assets.push({
              faucetId: getBech32AddressFromAccountId(asset.faucetId()),
              amountBaseUnits: asset.amount().toString()
            });
          }
        }

        return { parsedNotes: notes, vaultAssets: assets };
      });

      // Fetch metadata for all faucets in parallel (RPC, outside lock — no WASM needed)
      // Collect all unique faucet IDs from both notes and vault assets
      const allFaucetIds = new Set([...parsedNotes.map(n => n.faucetId), ...vaultAssets.map(a => a.faucetId)]);

      const metadataCache: Record<
        string,
        { decimals: number; symbol: string; name: string; thumbnailUri?: string; scaleIsUnknown?: boolean }
      > = {};
      await Promise.all(
        [...allFaucetIds].map(async faucetId => {
          try {
            const { base } = await fetchTokenMetadata(faucetId);
            metadataCache[faucetId] = {
              decimals: base.decimals,
              symbol: base.symbol,
              name: base.name,
              thumbnailUri: base.thumbnailUri,
              scaleIsUnknown: base.scaleIsUnknown
            };
          } catch {}
        })
      );

      // Attach metadata to notes
      for (const note of parsedNotes) {
        if (metadataCache[note.faucetId]) {
          note.metadata = metadataCache[note.faucetId];
        }
      }

      // Attach metadata to vault assets
      for (const asset of vaultAssets) {
        if (metadataCache[asset.faucetId]) {
          asset.metadata = metadataCache[asset.faucetId];
        }
      }

      // Always update seenNoteIds for background dedup consistency. Every
      // note id goes into the seen set — including swap-managed ones —
      // otherwise a transient classification failure (note untagged for one
      // cycle) makes an already-known note look brand new. Swap-managed
      // auto-consume notes are excluded only from the notification below.
      // Native-asset (MIDEN) note auto-consume — the background counterpart to the
      // frontend NativeNoteAutoConsumeManager (mobile/desktop). Resolve eligibility
      // here so the "click to claim" notification below can exclude notes we are about
      // to auto-consume; the actual consume is enqueued after the swap block. The SW has
      // no localStorage, so the toggle is read from the platform KV mirror — and only
      // once the popup has mirrored the user's REAL settings (areBackgroundSettingsMirrored),
      // so we never act on read-miss defaults for a user who opted out of auto-consume or
      // remote proving (the frontend still covers the app-open case in the meantime).
      let nativeAutoConsumeNotes: ConsumableNote[] = [];
      try {
        if ((await areBackgroundSettingsMirrored()) && (await isAutoConsumeEnabledAsync())) {
          const nativeFaucetId = await getFaucetIdSetting();
          if (nativeFaucetId) {
            nativeAutoConsumeNotes = parsedNotes.flatMap(n => {
              if (n.faucetId !== nativeFaucetId || n.swapOrder) return [];
              const type: ConsumableNote['type'] =
                n.noteType === NoteTypeEnum.Public || n.noteType === NoteTypeEnum.Private ? n.noteType : 'unknown';
              return [
                {
                  id: n.id,
                  faucetId: n.faucetId,
                  amount: n.amountBaseUnits,
                  senderAddress: n.senderAddress,
                  isBeingClaimed: false,
                  type,
                  swapOrder: undefined
                }
              ];
            });
          }
        }
      } catch (err) {
        console.warn('[native-auto-consume] eligibility check failed', err);
      }

      const managedAutoConsumeIds = new Set([
        ...parsedNotes.filter(n => n.swapOrder && n.swapOrder.autoConsume !== false).map(n => n.id),
        ...nativeAutoConsumeNotes.map(n => n.id)
      ]);
      const newIds = (await mergeAndPersistSeenNoteIds(parsedNotes.map(n => n.id))).filter(
        id => !managedAutoConsumeIds.has(id)
      );

      // Write sync data to chrome.storage.local — the reliable data channel.
      // Frontends read from here via chrome.storage.onChanged (works across all extension contexts).
      const syncData: SyncData = {
        notes: parsedNotes,
        vaultAssets,
        accountPublicKey: accountPubKey
      };
      try {
        // Use the webextension-polyfill `browser` (already imported for alarms)
        // rather than raw `chrome.*`: on the Firefox/MV2 build `chrome.storage`
        // is callback-based and would resolve the await immediately without ever
        // rejecting, so `await chrome.storage…set` there is effectively still
        // fire-and-forget. `browser` gives promise + error semantics on both.
        await browser.storage.local.set({
          miden_cached_consumable_notes: parsedNotes,
          miden_sync_data: syncData
        });
      } catch (err) {
        // A failed write (quota exceeded, storage unavailable) must not be
        // swallowed silently: frontends read this cache, so on failure they keep
        // the previous data until the next sync retries the write. Log it. The
        // SyncCompleted signal below still fires — it only clears the sync
        // indicator (the data itself is read from storage), so gating it would
        // just hang that indicator without making the data any fresher.
        console.warn('[SyncManager] Failed to persist sync data to local storage:', err);
      }

      // Broadcast bare SyncCompleted as a signal (data is in chrome.storage.local)
      try {
        intercom.broadcast({ type: WalletMessageType.SyncCompleted });
      } catch {
        // No frontends connected — that's fine
      }

      if (!intercom.hasClients() && newIds.length > 0) {
        // No popup open and new notes arrived — show desktop notification
        const title = getMessage('noteReceivedTitle') || 'You have received a note';
        const message =
          newIds.length === 1
            ? getMessage('noteReceivedClickToClaim') || 'Click to view and claim it'
            : getMessage('noteReceivedMultiple', { count: String(newIds.length) }) ||
              `You have ${newIds.length} new notes to claim`;
        showBackgroundNotification(title, message, 'miden-note-received');
      }

      // Reuse the notes classified above under Lock 2 — re-running
      // settleSwapOrders here would repeat the consumable-notes read and all
      // lineage lookups under a fresh WASM lock for no new information.
      const managedNotes: ConsumableNote[] = parsedNotes.flatMap(n => {
        if (!n.swapOrder) return [];
        const type: ConsumableNote['type'] =
          n.noteType === NoteTypeEnum.Public || n.noteType === NoteTypeEnum.Private ? n.noteType : 'unknown';
        return [
          {
            id: n.id,
            faucetId: n.faucetId,
            amount: n.amountBaseUnits,
            senderAddress: n.senderAddress,
            isBeingClaimed: false,
            type,
            swapOrder: { ...n.swapOrder, autoConsume: n.swapOrder.autoConsume ?? true }
          }
        ];
      });
      // Gate on orders, not notes: an order with no consumable notes left may
      // still need its settlement stamp repaired inside reconcile.
      if (swapOrderRows.length > 0) {
        try {
          const settlement = await reconcileSwapOrderNotes(
            accountPubKey,
            managedNotes,
            undefined,
            undefined,
            swapOrderRows
          );
          if (settlement.queuedTransactionIds.length > 0) {
            const { startTransactionProcessing } = await import('./transaction-processor');
            startTransactionProcessing().catch(err => console.warn('[swap-settlement] processing failed', err));
          }
        } catch (err) {
          console.warn('[swap-settlement] reconcile failed', err);
        }
      }

      // Enqueue the native-note auto-consume computed above (after swap so swap-managed
      // native notes are already excluded by the `!swapOrder` filter). ONE consume tx
      // PER NOTE (mirroring the Home-page consumer), NOT a batch: a Miden tx is atomic,
      // so batching lets a single un-consumable note fail the whole tx and — because the
      // #215 backoff gate keys on the shared row's noteIds — throttle its healthy
      // batch-mates (and the frontend consumer) too. Per-note isolates failures. Dedup +
      // backoff live inside initiateConsumeTransaction, so a repeated ~30s tick never
      // spawns duplicate rows. Proving follows the user's delegated/local setting via the
      // SW-readable mirror — like every other proving path in the wallet.
      if (nativeAutoConsumeNotes.length > 0) {
        try {
          const delegate = await isDelegateProofEnabledAsync();
          for (const note of nativeAutoConsumeNotes) {
            // Per-note try/catch so one note's enqueue failure can't skip its mates or the
            // processing kick below — matching the per-note isolation intent above.
            try {
              await initiateConsumeTransaction(accountPubKey, note, delegate);
            } catch (noteErr) {
              console.warn('[native-auto-consume] enqueue failed for note', note.id, noteErr);
            }
          }
          const { startTransactionProcessing } = await import('./transaction-processor');
          startTransactionProcessing().catch(err => console.warn('[native-auto-consume] processing failed', err));
        } catch (err) {
          console.warn('[native-auto-consume] native pass failed', err);
        }
      }
    } else {
      // No account — broadcast bare SyncCompleted (just sync status)
      try {
        intercom.broadcast({ type: WalletMessageType.SyncCompleted });
      } catch {
        // No frontends connected — that's fine
      }
    }
  } catch (err) {
    console.warn('[SyncManager] Sync error:', err);
    // Always broadcast SyncCompleted so frontends don't get stuck waiting.
    try {
      getIntercom()!.broadcast({ type: WalletMessageType.SyncCompleted });
    } catch {
      // No frontends connected
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sync timeout')), ms);
    promise.then(
      val => {
        clearTimeout(timer);
        resolve(val);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function setupSyncManager(): void {
  // Background sync alarm. Requests 30s but Chrome clamps to 1min in production.
  // Primary sync (3s) is driven by frontend SyncRequest when popup is open.
  browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });

  // NOTE: The alarm listener is registered at the top level of background.ts
  // (Chrome MV3 requires synchronous registration to catch events that wake the SW).

  // Run an initial sync immediately
  doSync().catch(err => console.warn('[SyncManager] Initial sync error:', err));
}
