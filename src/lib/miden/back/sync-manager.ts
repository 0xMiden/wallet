import browser from 'webextension-polyfill';

import { getMessage } from 'lib/i18n';
import { SerializedConsumableNote, WalletMessageType } from 'lib/shared/types';

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

    // THE sync for the whole app
    await withTimeout(
      withWasmClientLock(async () => {
        const client = await getMidenClient();
        if (!client) return;
        await client.syncState();
      }),
      SYNC_TIMEOUT_MS
    );

    // Broadcast to connected frontends
    const intercom = getIntercom()!;
    try {
      intercom.broadcast({ type: WalletMessageType.SyncCompleted });
    } catch {
      // No frontends connected — that's fine
    }

    // If no popup open, check for new notes in background
    if (!intercom.hasClients()) {
      await checkForNewNotes();
    }
  } catch (err) {
    console.warn('[SyncManager] Sync error:', err);
  } finally {
    isSyncing = false;
  }
}

async function checkForNewNotes(): Promise<void> {
  try {
    const accountPubKey = await Vault.getCurrentAccountPublicKey();
    if (!accountPubKey) return;

    const rawNotes = await withWasmClientLock(async () => {
      const client = await getMidenClient();
      if (!client) return [];
      return client.getConsumableNotes(accountPubKey);
    });

    // Parse ALL notes into serializable form and cache for instant frontend display
    const parsedNotes: SerializedConsumableNote[] = (rawNotes || [])
      .map((note: any) => {
        try {
          const noteRecord = note.inputNoteRecord();
          const noteId = noteRecord.id().toString();
          const noteMeta = noteRecord.metadata();
          const details = noteRecord.details();
          const fungibleAssets = details.assets().fungibleAssets();
          if (!fungibleAssets || fungibleAssets.length === 0) return null;
          const firstAsset = fungibleAssets[0];
          if (!firstAsset) return null;

          return {
            id: noteId,
            faucetId: getBech32AddressFromAccountId(firstAsset.faucetId()),
            amountBaseUnits: firstAsset.amount().toString(),
            senderAddress: noteMeta ? getBech32AddressFromAccountId(noteMeta.sender()) : ''
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as SerializedConsumableNote[];

    // Fetch metadata for each faucet so the frontend can display instantly (no async lookups)
    for (const note of parsedNotes) {
      try {
        const { base } = await fetchTokenMetadata(note.faucetId);
        note.metadata = {
          decimals: base.decimals,
          symbol: base.symbol,
          name: base.name,
          thumbnailUri: base.thumbnailUri
        };
      } catch {
        // Leave metadata undefined — frontend will handle
      }
    }

    // Cache for instant display when fullpage tab opens from notification click
    chrome.storage.local.set({ miden_cached_consumable_notes: parsedNotes });

    if (parsedNotes.length === 0) return;

    const noteIds = parsedNotes.map(n => n.id);
    const newIds = await mergeAndPersistSeenNoteIds(noteIds);
    if (newIds.length === 0) return;

    // Show desktop notification
    const title = getMessage('noteReceivedTitle') || 'You have received a note';
    const message =
      newIds.length === 1
        ? getMessage('noteReceivedClickToClaim') || 'Click to view and claim it'
        : getMessage('noteReceivedMultiple', { count: String(newIds.length) }) ||
          `You have ${newIds.length} new notes to claim`;

    showBackgroundNotification(title, message);
  } catch (err) {
    console.warn('[SyncManager] Note check error:', err);
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

/**
 * Get consumable notes from the service worker's warm WASM client.
 * Called by the frontend via intercom to avoid waiting for its own WASM client to initialize.
 */
export async function getConsumableNotesFromWarmClient(accountPublicKey: string): Promise<SerializedConsumableNote[]> {
  const rawNotes = await withWasmClientLock(async () => {
    const client = await getMidenClient();
    if (!client) return [];
    return client.getConsumableNotes(accountPublicKey);
  });

  if (!rawNotes || rawNotes.length === 0) return [];

  return rawNotes
    .map((note: any) => {
      try {
        const noteRecord = note.inputNoteRecord();
        const noteId = noteRecord.id().toString();
        const noteMeta = noteRecord.metadata();
        const details = noteRecord.details();
        const assetSet = details.assets();
        const fungibleAssets = assetSet.fungibleAssets();

        if (!fungibleAssets || fungibleAssets.length === 0) return null;
        const firstAsset = fungibleAssets[0];
        if (!firstAsset) return null;

        return {
          id: noteId,
          faucetId: getBech32AddressFromAccountId(firstAsset.faucetId()),
          amountBaseUnits: firstAsset.amount().toString(),
          senderAddress: noteMeta ? getBech32AddressFromAccountId(noteMeta.sender()) : ''
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SerializedConsumableNote[];
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

  // Listen for alarm fires
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) {
      doSync().catch(err => console.warn('[SyncManager] Alarm sync error:', err));
    }
  });

  // Run an initial sync immediately
  doSync().catch(err => console.warn('[SyncManager] Initial sync error:', err));
}
