import browser from 'webextension-polyfill';

import { getMessage } from 'lib/i18n';
import { SerializedConsumableNote, SerializedVaultAsset, SyncData, WalletMessageType } from 'lib/shared/types';

import { toNoteTypeString } from '../helpers';
import { fetchTokenMetadata } from '../metadata';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { getIntercom } from './defaults';
import { mergeAndPersistSeenNoteIds } from './note-checker-storage';
import { Vault } from './vault';

const ALARM_NAME = 'miden-sync';
const SYNC_TIMEOUT_MS = 25_000;

let isSyncing = false;

export async function doSync(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    // Skip if wallet not set up
    const exists = await Vault.isExist();
    if (!exists) return;

    // [Lock 1] THE sync for the whole app
    await withTimeout(
      withWasmClientLock(async () => {
        const client = await getMidenClient();
        if (!client) return;
        await client.syncState();
      }),
      SYNC_TIMEOUT_MS
    );

    const intercom = getIntercom()!;
    const accountPubKey = await Vault.getCurrentAccountPublicKey();

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
          } catch {
          }
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
    // Always broadcast SyncCompleted so frontends don't get stuck with isSyncing=true
    try {
      getIntercom()!.broadcast({ type: WalletMessageType.SyncCompleted });
    } catch {
      // No frontends connected
    }
  } finally {
    isSyncing = false;
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
