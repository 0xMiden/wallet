/**
 * Event-driven backup refresh (architecture doc 7.3). There is no timer poll.
 * The client reads only on these events, and only the feature the event is about
 * (the one timer that is not an event is the retry of a failed refresh, below):
 *
 * | Event                         | Read                                         | Raised by                                   |
 * |-------------------------------|----------------------------------------------|---------------------------------------------|
 * | Unlock and foreground         | `GET /v1/storage`, then each changed feature | the store's Ready transition,               |
 * |                               |                                              | `useBackupForegroundRefresh`                |
 * | Address book opens            | `contacts`                                   | `AddressBook` on mount                      |
 * | A contact is written          | `contacts`, then upload the merged list      | `Actions.updateSettings` with `contacts`    |
 * | An account is renamed         | `accounts`, then upload the changed entries  | `Actions.editAccount`                       |
 * | Activity opens                | `history`, with `since`                      | `AllHistory` when its page turns active     |
 * | Guardian sync adopts a state  | `history`, with `since`; on a 304 again      | `signalGuardianStateAdopted`                |
 * |                               | after 10, 30 and 60 s, then stop             |                                             |
 * | A row reaches a final status  | upload the history                           | `signalTransactionCompleted`                |
 * | A recovered wallet's Guardian | `history`, with `since`                      | `restoreHistoryFromBackup` from the         |
 * | pass reaches its history step | before the Guardian history read             | Guardian recovery (`guardian-recovery.ts`)  |
 *
 * Each refresh also uploads the local changes of its features. A completed
 * transaction flushes history at once ({@link flushHistoryNow}).
 *
 * A refresh that fails schedules one retry of the unlock refresh: 30 s, then
 * twice as long after each failed retry, up to 30 min, and never sooner than
 * the server's `Retry-After`. One retry waits or runs at a time. A lock, a
 * profile delete and a storage wipe drop it (see `scheduleBackupRetry`).
 *
 * Every function runs in the backend realm, never throws, and is a no-op
 * without a base URL (the network's wallet-config document names none, or
 * turns the backup off), while locked, or without a sync key. An entry point
 * can run before startup hydrated the bridge config, so it waits for that
 * hydration before it reads the base URL ({@link checkWalletApiEnabled}).
 * A refresh that outlives its session (a lock, a wipe, a profile the server
 * made again) stops where the entry layer refuses it and reports `locked`.
 *
 * Do not await a refresh inside a task of the accounts write queue (unlock,
 * rename, import): an account rename from a peer waits for that same queue.
 * Start it after the task, as the UI does through `BackupRefreshRequest`.
 */
import type { BackupRefreshOutcome, BackupRefreshReason } from 'lib/shared/types';

import { checkWalletApiEnabled, deleteProfile, getStorageIndex, retryAfterOf } from './api-client';
import { syncAccounts } from './features/accounts';
import { syncContacts } from './features/contacts';
import { flushHistory, peerHistoryChunkCount, readHistory, recordFinalAccountCommitments } from './features/history';
import {
  type BackupSession,
  BackupSessionClosedError,
  assertSessionLive,
  clearBackupSession,
  getBackupSession,
  isSessionLive,
  persistMergeRecords,
  withSessionToken
} from './session';
import { backupStorageEpoch, persistBackupState, removeBackupState } from './state';

/** Why the history is read. */
export type HistoryRefreshReason = Extract<BackupRefreshReason, 'activity-open' | 'guardian-adopt'>;

/**
 * Run the refresh of one event. Never throws. A signal that a realm raised
 * before its bridge config hydrated arrives here, so this check waits for the
 * backend's hydration and does not trust the sender's early exit.
 */
export async function runBackupRefresh(reason: BackupRefreshReason): Promise<BackupRefreshOutcome> {
  if (!(await checkWalletApiEnabled())) return 'disabled';
  switch (reason) {
    case 'unlock':
    case 'foreground':
      return refreshOnUnlock();
    case 'address-book':
    case 'contacts-changed':
      return refreshContacts();
    case 'account-renamed':
      return refreshAccounts();
    case 'activity-open':
    case 'guardian-adopt':
      return refreshHistory(reason);
    case 'transaction-completed':
      return flushHistoryNow();
  }
}

/** The re-read delays after a Guardian adoption whose first read found nothing new. */
export const GUARDIAN_REREAD_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000];

/** The wait before the retry of a failed refresh. Each failed retry doubles it, up to {@link BACKUP_RETRY_CAP_MS}. */
export const BACKUP_RETRY_FLOOR_MS = 30_000;
/** The longest wait between two retries. */
export const BACKUP_RETRY_CAP_MS = 30 * 60 * 1000;

/** What one refresh did, and the `Retry-After` wait of its failure. */
interface RefreshResult {
  outcome: BackupRefreshOutcome;
  retryAfterMs: number | null;
}

/**
 * How a refresh result changes the retry. `event`: the refresh of one event. `full`: the unlock refresh, which does
 * the work of every event. `retry`: the retry itself.
 */
type RefreshKind = 'event' | 'full' | 'retry';

/**
 * The retry of failed refreshes. One timer serves every reason: the retry runs the unlock refresh, which reads
 * every changed feature and uploads every local change. At most one retry waits or runs at a time. The wait starts
 * at {@link BACKUP_RETRY_FLOOR_MS} and doubles after each failed retry, up to {@link BACKUP_RETRY_CAP_MS}, and it is
 * never shorter than the `Retry-After` of the failure. An unlock refresh or a retry that goes through ends it. A
 * lock, a profile delete and a storage wipe drop it. The timer lives in the backend realm only, as the Guardian
 * re-reads do: a service worker that stops takes it, and the next event refreshes again.
 */
let retry: { timer: ReturnType<typeof setTimeout>; dueAt: number } | null = null;
/** True while the retry runs its refresh. */
let retryRunning = false;
/** Failed retries since the last refresh that went through. */
let failedRetries = 0;
/** Bumped when the retry is dropped, so a refresh that started before it schedules nothing. */
let retryGeneration = 0;

async function attemptWithSession(
  label: string,
  run: (session: BackupSession) => Promise<boolean>
): Promise<RefreshResult> {
  const opened = await getBackupSession();
  if ('unavailable' in opened) return { outcome: opened.unavailable, retryAfterMs: opened.retryAfterMs ?? null };
  try {
    return { outcome: (await run(opened.session)) ? 'updated' : 'unchanged', retryAfterMs: null };
  } catch (error) {
    if (error instanceof BackupSessionClosedError) {
      // Not a failure: the wallet locked, or the next event opens a session for the new profile.
      console.info(`[backup] ${label} stopped: ${error.message}`);
      return { outcome: 'locked', retryAfterMs: null };
    }
    console.warn(`[backup] ${label} failed`, error);
    return { outcome: 'failed', retryAfterMs: retryAfterOf(error) };
  }
}

async function withSession(
  label: string,
  run: (session: BackupSession) => Promise<boolean>,
  kind: Exclude<RefreshKind, 'retry'> = 'event'
): Promise<BackupRefreshOutcome> {
  const generation = retryGeneration;
  const result = await attemptWithSession(label, run);
  settleRetry(result, kind, generation);
  return result.outcome;
}

/** Stop the pending retry, disown the refreshes in flight and start the next wait from the floor. */
function dropBackupRetry(): void {
  retryGeneration += 1;
  failedRetries = 0;
  if (retry !== null) {
    clearTimeout(retry.timer);
    retry = null;
  }
}

/** Apply a refresh result that started in retry generation `generation` to the retry. */
function settleRetry(result: RefreshResult, kind: RefreshKind, generation: number): void {
  if (generation !== retryGeneration) return;
  switch (result.outcome) {
    case 'failed':
      if (kind === 'retry') failedRetries += 1;
      scheduleBackupRetry(result.retryAfterMs);
      return;
    case 'updated':
    case 'unchanged':
      // Only the unlock refresh and the retry do the work of every event; an event refresh that goes through
      // does not do the work of another event that failed.
      if (kind !== 'event') dropBackupRetry();
      return;
    case 'locked':
    case 'disabled':
    case 'no-sync-key':
      // Not a failure: the unlock, the config or the key that ends this state starts a refresh of its own.
      return;
  }
}

function scheduleBackupRetry(retryAfterMs: number | null): void {
  // A retry that runs schedules the next one itself when it fails.
  if (retryRunning) return;
  const now = Date.now();
  // A pending retry stays, unless the server asked for a longer wait than it gives.
  if (retry !== null && retry.dueAt >= now + (retryAfterMs ?? 0)) return;
  if (retry !== null) clearTimeout(retry.timer);
  const delay = Math.max(Math.min(BACKUP_RETRY_FLOOR_MS * 2 ** failedRetries, BACKUP_RETRY_CAP_MS), retryAfterMs ?? 0);
  const generation = retryGeneration;
  const storageEpoch = backupStorageEpoch();
  const timer = setTimeout(() => {
    retry = null;
    if (generation !== retryGeneration) return;
    if (storageEpoch !== backupStorageEpoch()) {
      // The storage was wiped: the failed refresh belonged to the wallet that is gone.
      dropBackupRetry();
      return;
    }
    runBackupRetry(generation).catch(error => console.warn('[backup] the backup retry failed', error));
  }, delay);
  retry = { timer, dueAt: now + delay };
}

async function runBackupRetry(generation: number): Promise<void> {
  retryRunning = true;
  let result: RefreshResult;
  try {
    result = await attemptWithSession('backup retry', refreshEveryFeature);
  } finally {
    retryRunning = false;
  }
  settleRetry(result, 'retry', generation);
}

/**
 * One `GET /v1/storage` with the full-profile ETag. A 304 reads nothing more. Otherwise each feature whose ETag
 * changed is read. Then the local changes of every feature are uploaded.
 */
async function refreshEveryFeature(session: BackupSession): Promise<boolean> {
  const state = session.state;
  const index = await withSessionToken(session, token => getStorageIndex(token, state.profileEtag));
  const changedFeature = (feature: 'accounts' | 'contacts' | 'history') =>
    index !== null && index.features[feature]?.etag !== state.features[feature].etag;

  let changed = false;
  changed = (await syncAccounts(session, changedFeature('accounts'))) || changed;
  changed = (await syncContacts(session, changedFeature('contacts'))) || changed;
  if (changedFeature('history')) changed = (await readHistory(session, true)) || changed;
  if (index !== null) {
    // The syncs awaited: a lock or a profile delete may have closed the session, and its state must stay removed.
    assertSessionLive(session);
    // Every changed feature is applied: the profile ETag may move now.
    state.profileEtag = index.etag;
    await persistBackupState(state);
  }
  await flushHistory(session);
  return changed;
}

/** Unlock and foreground: {@link refreshEveryFeature}. */
export function refreshOnUnlock(): Promise<BackupRefreshOutcome> {
  return withSession('unlock refresh', refreshEveryFeature, 'full');
}

/** Address book opens: read and merge the contacts, then upload the merged list. */
export function refreshContacts(): Promise<BackupRefreshOutcome> {
  return withSession('contacts refresh', session => syncContacts(session, true));
}

/** An account is renamed: read the peer names, merge them by rename time, then upload the changed entries. */
export function refreshAccounts(): Promise<BackupRefreshOutcome> {
  return withSession('accounts refresh', session => syncAccounts(session, true));
}

let guardianReread: { timer: ReturnType<typeof setTimeout>; step: number } | null = null;
/**
 * The adoption that owns the re-read schedule. A new adoption, a lock and a profile delete move it on, so a
 * read of an earlier one that ends late (an older adoption, a held re-read) schedules nothing.
 */
let guardianGeneration = 0;

/** Stop the pending re-read and disown every read still in flight. */
function stopGuardianRereads(): void {
  guardianGeneration += 1;
  cancelGuardianReread();
}

function cancelGuardianReread(): void {
  if (guardianReread !== null) {
    clearTimeout(guardianReread.timer);
    guardianReread = null;
  }
}

/** Schedule re-read `step` of the adoption `generation`, or stop after the last one. */
function scheduleGuardianReread(step: number, generation: number): void {
  if (generation !== guardianGeneration) return;
  cancelGuardianReread();
  const delay = GUARDIAN_REREAD_DELAYS_MS[step];
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    guardianReread = null;
    readHistoryOnce('guardian adoption re-read').then(outcome => {
      if (outcome === 'unchanged') scheduleGuardianReread(step + 1, generation);
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
      stopGuardianRereads();
      const generation = guardianGeneration;
      const outcome = await readHistoryOnce('history refresh after a Guardian adoption');
      if (outcome === 'unchanged') scheduleGuardianReread(0, generation);
      return outcome;
    }
  }
}

/**
 * Apply peer backup receipts before Guardian recovery fills gaps. Returns true if the backup contains peer history.
 */
export async function restoreHistoryFromBackup(): Promise<boolean> {
  if (!(await checkWalletApiEnabled())) return false;
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

/**
 * Upload the terminal receipt and other changed history rows. The final account commitments are read first, without
 * a session: the result bytes they come from go 10 minutes after completion, also when the server cannot be reached.
 */
export async function flushHistoryNow(): Promise<BackupRefreshOutcome> {
  await recordFinalAccountCommitments();
  return withSession('history flush', async session => (await flushHistory(session)) > 0);
}

/**
 * Delete the profile and every entry on the server (`DELETE /v1/profile`),
 * then the local records. A later refresh makes a new, empty profile.
 */
export async function deleteBackupProfile(): Promise<BackupRefreshOutcome> {
  if (!(await checkWalletApiEnabled())) return 'disabled';
  const opened = await getBackupSession();
  if ('unavailable' in opened) return opened.unavailable;
  try {
    await withSessionToken(opened.session, token => deleteProfile(token));
    // A lock or a wipe during the delete: the local records are no longer this session's to clear.
    if (!isSessionLive(opened.session)) return 'locked';
    stopGuardianRereads();
    dropBackupRetry();
    clearBackupSession();
    // Queued before any await: a refresh can open the replacement session while this one yields, and its state
    // writes must land after this removal, not be removed by it.
    const removal = removeBackupState(opened.session.state);
    // The contacts base described the deleted profile's list; the name marks are local facts and stay.
    opened.session.merge.contactsBase = null;
    await persistMergeRecords(opened.session);
    await removal;
    return 'updated';
  } catch (error) {
    if (error instanceof BackupSessionClosedError) return 'locked';
    console.warn('[backup] the profile delete failed', error);
    return 'failed';
  }
}

/** Drop the session keys, stop the pending Guardian re-reads and drop the retry, on lock. */
export function onBackupLock(): void {
  stopGuardianRereads();
  dropBackupRetry();
  clearBackupSession();
}
