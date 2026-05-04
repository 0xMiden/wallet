import browser from 'webextension-polyfill';

import { getMessage } from 'lib/i18n';
import { classifySyncError, isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearReachabilityIssues, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { SerializedConsumableNote, SerializedVaultAsset, SyncData, WalletMessageType } from 'lib/shared/types';

import { toNoteTypeString } from '../helpers';
import { fetchTokenMetadata } from '../metadata';
import { getIntercom } from './defaults';
import { mergeAndPersistSeenNoteIds } from './note-checker-storage';
import { Vault } from './vault';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

// `init_vault` is the ESM module factory for `./vault`, injected by Vite's
// SW bundle transform. We must NOT add a source-level binding (e.g.
// `declare const init_vault`) because Rolldown would rename the factory to
// `init_vault$1` to avoid the collision, breaking the lazy accessor at
// runtime. The @ts-expect-error below is the intended escape hatch.

const ALARM_NAME = 'miden-sync';

// syncState is capped aggressively. On testnet with slow RPC a single
// syncState can legitimately take 5-25s; the previous 25s ceiling plus the
// wasm-client mutex meant fetchBalances (triggered by the SelectToken TST
// tile) could queue behind a sync long enough to exceed Playwright's 10s
// click budget and cause UI timeouts under stress. 5s keeps the sync path
// well below any UI click budget; if testnet RPC is genuinely slow, the
// circuit breaker (below) trips and we back off rather than hammering.
const SYNC_TIMEOUT_MS = 5_000;

// Circuit breaker: after MAX_CONSECUTIVE_SYNC_FAILURES timeouts/errors in
// a row we skip sync attempts for BACKOFF_MS, then allow one probe. A
// successful sync resets the counter. Protects both the wasm client and the
// RPC backend from being hammered when the network (or the node) is flapping.
const MAX_CONSECUTIVE_SYNC_FAILURES = 3;
const BACKOFF_MS = 30_000;

// Concurrent doSync() callers join the in-flight sync instead of being dropped.
// The previous boolean-guard silently no-op'd concurrent calls, so a single stuck
// sync made every triggerSync() during that window return without having synced.
let inFlight: Promise<void> | null = null;

// Circuit-breaker state. Module-level is fine — the SW process is the only
// doSync caller in the extension path; mobile/desktop runs have one sync loop.
let consecutiveSyncFailures = 0;
let syncBackoffUntilMs = 0;

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

export function doSync(): Promise<void> {
  if (inFlight) return inFlight;
  // Circuit-breaker: short-circuit if recent syncs failed and we're waiting out
  // the backoff window. Returning resolved-void here keeps the existing contract
  // for callers (triggerSync, alarm) that don't distinguish success from skip.
  if (Date.now() < syncBackoffUntilMs) {
    return Promise.resolve();
  }
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<void> {
  try {
    // Skip if wallet not set up
    const vault = await getVault();
    const exists = await vault.isExist();
    if (!exists) return;

    // [Lock 1] THE sync for the whole app. Bounded by SYNC_TIMEOUT_MS so it
    // can't stall downstream consumers; a breach bumps the circuit-breaker
    // counter and we continue (downstream read paths should still run so the
    // UI gets whatever state is locally cached).
    try {
      await withTimeout(
        withWasmClientLock(async () => {
          const client = await getMidenClient();
          if (!client) return;
          await client.syncState();
        }),
        SYNC_TIMEOUT_MS
      );
      consecutiveSyncFailures = 0;
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
      // Categorize the sync failure as network (browser is offline) or
      // node (we can reach the open net but the Miden RPC didn't answer).
      // Skip semantic / non-transport errors so a malformed-response bug
      // in the SDK doesn't masquerade as connectivity. Suppressing the
      // synthetic `Sync timeout` from withTimeout is intentional —
      // timeouts are themselves transport-shaped.
      if (isLikelyNetworkError(err) || /sync timeout/i.test(String((err as any)?.message ?? err))) {
        markConnectivityIssue(classifySyncError(err));
      }
      if (consecutiveSyncFailures >= MAX_CONSECUTIVE_SYNC_FAILURES) {
        syncBackoffUntilMs = Date.now() + BACKOFF_MS;
        consecutiveSyncFailures = 0;
        console.warn(`[SyncManager] circuit breaker open — skipping syncs for ${BACKOFF_MS}ms`);
      }
      // Continue to the downstream read path: the client may still have
      // cached state from a prior successful sync worth surfacing.
    }

    const intercom = getIntercom()!;
    const vault2 = await getVault();
    const accountPubKey = await vault2.getCurrentAccountPublicKey();

    if (accountPubKey) {
      // [Lock 2] Read notes + vault assets from warm WASM client
      const { parsedNotes, vaultAssets } = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        if (!client)
          return { parsedNotes: [] as SerializedConsumableNote[], vaultAssets: [] as SerializedVaultAsset[] };

        // Read consumable notes
        const rawNotes = await client.getConsumableNotes(accountPubKey);
        const notes: SerializedConsumableNote[] = (rawNotes || [])
          .map((note: any) => {
            try {
              const noteId = note.id().toString();
              const noteMeta = note.metadata();
              const details = note.details();
              const fungibleAssets = details.assets().fungibleAssets();
              if (!fungibleAssets || fungibleAssets.length === 0) return null;
              const firstAsset = fungibleAssets[0];
              if (!firstAsset) return null;
              return {
                id: noteId,
                faucetId: getBech32AddressFromAccountId(firstAsset.faucetId()),
                amountBaseUnits: firstAsset.amount().toString(),
                senderAddress: noteMeta ? getBech32AddressFromAccountId(noteMeta.sender()) : '',
                noteType: noteMeta ? toNoteTypeString(noteMeta.noteType()) : 'unknown'
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean) as SerializedConsumableNote[];

        // Read vault assets
        const account = await client.getAccount(accountPubKey);
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

      const metadataCache: Record<string, { decimals: number; symbol: string; name: string; thumbnailUri?: string }> =
        {};
      await Promise.all(
        [...allFaucetIds].map(async faucetId => {
          try {
            const { base } = await fetchTokenMetadata(faucetId);
            metadataCache[faucetId] = {
              decimals: base.decimals,
              symbol: base.symbol,
              name: base.name,
              thumbnailUri: base.thumbnailUri
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

      // Always update seenNoteIds for background dedup consistency
      const noteIds = parsedNotes.map(n => n.id);
      const newIds = await mergeAndPersistSeenNoteIds(noteIds);

      // Write sync data to chrome.storage.local — the reliable data channel.
      // Frontends read from here via chrome.storage.onChanged (works across all extension contexts).
      const syncData: SyncData = {
        notes: parsedNotes,
        vaultAssets,
        accountPublicKey: accountPubKey
      };
      chrome.storage.local.set({
        miden_cached_consumable_notes: parsedNotes,
        miden_sync_data: syncData
      });

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
        showBackgroundNotification(title, message);
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

function showBackgroundNotification(title: string, message: string): void {
  // Primary: ServiceWorkerRegistration.showNotification — same underlying system as
  // Web Notifications API (new Notification()) which works reliably in Brave.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sw = globalThis as any;
  if (sw.registration?.showNotification) {
    sw.registration.showNotification(title, {
      body: message,
      icon: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
      requireInteraction: true
    });
    return;
  }

  // Fallback: chrome.notifications API
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chromeNotifications = (globalThis as any).chrome?.notifications;
  if (chromeNotifications) {
    chromeNotifications.create(
      'miden-note-received',
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('misc/logo-white-bg-128.png'),
        title,
        message,
        requireInteraction: true
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[SyncManager] chrome.notifications error:', chrome.runtime.lastError.message);
        }
      }
    );
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
