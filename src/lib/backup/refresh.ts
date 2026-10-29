/**
 * Event-driven backup refresh (architecture doc 7.3). There is no timer poll.
 * The client reads only on these events, and only the feature the event is about:
 *
 * | Event                         | Read                                         | Raised by                                   |
 * |-------------------------------|----------------------------------------------|---------------------------------------------|
 * | Unlock and foreground         | `GET /v1/storage`, then each changed feature | the store's Ready transition,               |
 * |                               |                                              | `useBackupForegroundRefresh`                |
 * | Address book opens            | `contacts`                                   | `AddressBook` on mount                      |
 * | A contact is written          | `contacts`, then upload the merged list      | `Actions.updateSettings` with `contacts`    |
 * | Activity opens                | `history`, with `since`                      | `AllHistory` when its page turns active     |
 * | Guardian sync adopts a state  | `history`, with `since`; on a 304 again      | `signalGuardianStateAdopted`                |
 * |                               | after 10, 30 and 60 s, then stop             |                                             |
 * | A row reaches Completed       | upload the history                           | `signalTransactionCompleted`                |
 * | A recovered wallet's Guardian | `history`, with `since`; a peer's history    | `restoreHistoryFromBackup` from the         |
 * | pass reaches its history step | found ends the pass, no Guardian history read| Guardian recovery (`guardian-recovery.ts`)  |
 *
 * Each refresh also uploads the local changes of its features. A completed
 * transaction flushes history at once ({@link flushHistoryNow}).
 *
 * Every function runs in the backend realm, never throws, and is a no-op off
 * mainnet, without a configured base URL, while locked, or without a sync key.
 * A refresh that outlives its session (a lock, a wipe, a profile the server
 * made again) stops where the entry layer refuses it and reports `locked`.
 *
 * Do not await a refresh inside a task of the accounts write queue (unlock,
 * rename, import): an account rename from a peer waits for that same queue.
 * Start it after the task, as the UI does through `BackupRefreshRequest`.
 */
import type { BackupRefreshOutcome, BackupRefreshReason } from 'lib/shared/types';

import { deleteProfile, getStorageIndex } from './api-client';
import { syncAccounts } from './features/accounts';
import { syncContacts } from './features/contacts';
import { flushHistory, peerHistoryChunkCount, readHistory } from './features/history';
import {
  type BackupSession,
  BackupSessionClosedError,
  clearBackupSession,
  getBackupSession,
  persistMergeRecords,
  withSessionToken
} from './session';
import { persistBackupState, removeBackupState } from './state';

/** Why the history is read. */
export type HistoryRefreshReason = Extract<BackupRefreshReason, 'activity-open' | 'guardian-adopt'>;

/** Run the refresh of one event. Never throws. */
export function runBackupRefresh(reason: BackupRefreshReason): Promise<BackupRefreshOutcome> {
  switch (reason) {
    case 'unlock':
    case 'foreground':
      return refreshOnUnlock();
    case 'address-book':
    case 'contacts-changed':
      return refreshContacts();
    case 'activity-open':
    case 'guardian-adopt':
      return refreshHistory(reason);
    case 'transaction-completed':
      return flushHistoryNow();
  }
}

/** The re-read delays after a Guardian adoption whose first read found nothing new. */
export const GUARDIAN_REREAD_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000];

async function withSession(
  label: string,
  run: (session: BackupSession) => Promise<boolean>
): Promise<BackupRefreshOutcome> {
  const opened = await getBackupSession();
  if ('unavailable' in opened) return opened.unavailable;
  try {
    return (await run(opened.session)) ? 'updated' : 'unchanged';
  } catch (error) {
    if (error instanceof BackupSessionClosedError) {
      // Not a failure: the wallet locked, or the next event opens a session for the new profile.
      console.info(`[backup] ${label} stopped: ${error.message}`);
      return 'locked';
    }
    console.warn(`[backup] ${label} failed`, error);
    return 'failed';
  }
}

/**
 * Unlock and foreground: one `GET /v1/storage` with the full-profile ETag. A
 * 304 reads nothing more. Otherwise each feature whose ETag changed is read.
 * Then the local changes of every feature are uploaded.
 */
export function refreshOnUnlock(): Promise<BackupRefreshOutcome> {
  return withSession('unlock refresh', async session => {
    const state = session.state;
    const index = await withSessionToken(session, token => getStorageIndex(token, state.profileEtag));
    const changedFeature = (feature: 'accounts' | 'contacts' | 'history') =>
      index !== null && index.features[feature]?.etag !== state.features[feature].etag;

    let changed = false;
    changed = (await syncAccounts(session, changedFeature('accounts'))) || changed;
    changed = (await syncContacts(session, changedFeature('contacts'))) || changed;
    if (changedFeature('history')) changed = (await readHistory(session, true)) || changed;
    if (index !== null) {
      // Every changed feature is applied: the profile ETag may move now.
      state.profileEtag = index.etag;
      await persistBackupState(state);
    }
    await flushHistory(session);
    return changed;
  });
}

/** Address book opens: read and merge the contacts, then upload the merged list. */
export function refreshContacts(): Promise<BackupRefreshOutcome> {
  return withSession('contacts refresh', session => syncContacts(session, true));
}

let guardianReread: { timer: ReturnType<typeof setTimeout>; step: number } | null = null;

function cancelGuardianReread(): void {
  if (guardianReread !== null) {
    clearTimeout(guardianReread.timer);
    guardianReread = null;
  }
}

/** Schedule re-read `step` of a Guardian adoption, or stop after the last one. */
function scheduleGuardianReread(step: number): void {
  cancelGuardianReread();
  const delay = GUARDIAN_REREAD_DELAYS_MS[step];
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    guardianReread = null;
    readHistoryOnce('guardian adoption re-read').then(outcome => {
      if (outcome === 'unchanged') scheduleGuardianReread(step + 1);
    });
  }, delay);
  guardianReread = { timer, step };
}

function readHistoryOnce(label: string): Promise<BackupRefreshOutcome> {
  return withSession(label, async session => {
    const changed = await readHistory(session, true);
    await flushHistory(session);
    return changed;
  });
}

/**
 * Read the history with `since`. After a Guardian adoption a read that finds
 * nothing new (the peer's upload has not landed yet) is repeated after 10, 30
 * and 60 seconds, then the wallet waits for the next event.
 */
export async function refreshHistory(reason: HistoryRefreshReason): Promise<BackupRefreshOutcome> {
  switch (reason) {
    case 'activity-open':
      return readHistoryOnce('history refresh');
    case 'guardian-adopt': {
      // A new adoption restarts the re-read schedule; it never stacks a second one.
      cancelGuardianReread();
      const outcome = await readHistoryOnce('history refresh after a Guardian adoption');
      if (outcome === 'unchanged') scheduleGuardianReread(0);
      return outcome;
    }
  }
}

/**
 * Restore the history of a recovered wallet from the backup. True when the
 * backup holds the history of another device, applied now: the backup is then
 * the record of history, and the Guardian history pass does not run. False
 * when the backup is off, cannot be read, or holds no peer history (a profile
 * this device just made, or peers that never uploaded), so the Guardian pass
 * runs instead. Never throws.
 */
export async function restoreHistoryFromBackup(): Promise<boolean> {
  const opened = await getBackupSession();
  if ('unavailable' in opened) return false;
  try {
    await readHistory(opened.session, true);
    return (await peerHistoryChunkCount(opened.session)) > 0;
  } catch (error) {
    if (!(error instanceof BackupSessionClosedError)) console.warn('[backup] the history restore failed', error);
    return false;
  }
}

/** A row reached Completed: append it and upload its chunk now, with no quiet period. */
export function flushHistoryNow(): Promise<BackupRefreshOutcome> {
  return withSession('history flush', async session => (await flushHistory(session)) > 0);
}

/**
 * Delete the profile and every entry on the server (`DELETE /v1/profile`),
 * then the local records. A later refresh makes a new, empty profile.
 */
export async function deleteBackupProfile(): Promise<BackupRefreshOutcome> {
  const opened = await getBackupSession();
  if ('unavailable' in opened) return opened.unavailable;
  try {
    await withSessionToken(opened.session, token => deleteProfile(token));
    cancelGuardianReread();
    clearBackupSession();
    // The contacts base described the deleted profile's list; the name marks are local facts and stay.
    opened.session.merge.contactsBase = null;
    await persistMergeRecords(opened.session);
    await removeBackupState();
    return 'updated';
  } catch (error) {
    if (error instanceof BackupSessionClosedError) return 'locked';
    console.warn('[backup] the profile delete failed', error);
    return 'failed';
  }
}

/** Drop the session keys and stop the pending Guardian re-reads, on lock. */
export function onBackupLock(): void {
  cancelGuardianReread();
  clearBackupSession();
}
