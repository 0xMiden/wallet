// Live progress record for the post-seed-recovery pending-note scan.
//
// The SW-side orchestrator (lib/miden/back/guardian-recovery.ts) writes this
// record as it advances through the recovery sources; the home view renders it
// as a non-dismissible prompt card (HomePrompts). Kept in its own
// dependency-light module (only the storage facade) so the service worker can
// import the writers without pulling the react-flavored wallet-prompts module.

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

// v2 is keyed BY ACCOUNT. v1 held a single record, which made the checkpoint
// unusable in the case it matters most: seed recovery flags every adopted
// account, so a second account's first progress write erased the first
// account's checkpoint, and that account then restarted from scratch —
// re-draining, re-importing and re-searching — only to be clobbered again on
// the next round. The v1 key is deliberately not migrated: it holds at most one
// in-flight run's position, and starting that one run over is exactly what
// happened on every service-worker restart anyway.
export const GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY = 'guardian_note_recovery_progress_v2';

/**
 * Accounts tracked at once. Entries are removed when their run ends, so the
 * live set is bounded by the number of flagged accounts; this only stops an
 * account deleted mid-deferral from leaving its entry behind forever.
 */
const MAX_TRACKED_ACCOUNTS = 20;

/**
 * A record not refreshed within this window is treated as abandoned. The
 * orchestrator rewrites it on every step and after every backfill chunk (each
 * bounded by a 60s op deadline), so a longer gap means the run died with the
 * realm — and without this bound the card, being non-dismissible, would stay
 * on screen forever.
 */
export const GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS = 180_000;

export type GuardianNoteRecoveryStep = 'transport' | 'proposals' | 'public';

export type GuardianNoteRecoveryProgress = {
  accountId: string;
  step: GuardianNoteRecoveryStep;
  /** Public-backfill bounds; present only during the `public` step. */
  startBlock?: number;
  syncedToBlock?: number;
  latestBlock?: number;
  /** `Date.now()` of the write, used to age out a record whose run died. */
  updatedAt?: number;
  /**
   * Whether the writing pass had seen zero source failures at the time of the
   * write. Only a clean pass's watermark may be resumed from — see
   * `resumePointFor`. Absent means "unknown", which is treated as not clean.
   */
  sourcesClean?: boolean;
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeEntry(value: unknown): GuardianNoteRecoveryProgress | null {
  if (!value || typeof value !== 'object') return null;
  const accountId = Reflect.get(value, 'accountId');
  const step = Reflect.get(value, 'step');
  if (typeof accountId !== 'string' || accountId.length === 0) return null;
  if (step !== 'transport' && step !== 'proposals' && step !== 'public') return null;
  return {
    accountId,
    step,
    startBlock: numberOrUndefined(Reflect.get(value, 'startBlock')),
    syncedToBlock: numberOrUndefined(Reflect.get(value, 'syncedToBlock')),
    latestBlock: numberOrUndefined(Reflect.get(value, 'latestBlock')),
    updatedAt: numberOrUndefined(Reflect.get(value, 'updatedAt')),
    sourcesClean: Reflect.get(value, 'sourcesClean') === true ? true : undefined
  };
}

/**
 * The whole stored map, dropping anything malformed. Entries filed under a key
 * that disagrees with their own `accountId` are dropped too: the two are the
 * same fact, and a mismatch means the write was not made by this code.
 */
export function normalizeGuardianNoteRecoveryProgressMap(value: unknown): Record<string, GuardianNoteRecoveryProgress> {
  if (!value || typeof value !== 'object') return {};
  const entries: Record<string, GuardianNoteRecoveryProgress> = {};
  for (const [accountId, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const entry = normalizeEntry(rawEntry);
    if (entry && entry.accountId === accountId) entries[accountId] = entry;
  }
  return entries;
}

/** One account's entry out of a raw stored map. */
export function normalizeGuardianNoteRecoveryProgress(
  value: unknown,
  accountId: string
): GuardianNoteRecoveryProgress | null {
  return normalizeGuardianNoteRecoveryProgressMap(value)[accountId] ?? null;
}

/**
 * True when the record is old enough that its writer must be gone. Every
 * writer stamps `updatedAt`, so a record without one cannot be from a live run
 * and is stale by definition — treating it as fresh instead would leave a
 * permanent non-dismissible card with nothing able to clear it.
 */
export function isGuardianNoteRecoveryProgressStale(
  progress: GuardianNoteRecoveryProgress,
  now: number = Date.now()
): boolean {
  if (progress.updatedAt === undefined) return true;
  return now - progress.updatedAt > GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS;
}

async function fetchMap(): Promise<Record<string, GuardianNoteRecoveryProgress>> {
  return normalizeGuardianNoteRecoveryProgressMap(await fetchFromStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY));
}

export async function fetchGuardianNoteRecoveryProgress(
  accountId: string
): Promise<GuardianNoteRecoveryProgress | null> {
  return (await fetchMap())[accountId] ?? null;
}

/**
 * Best-effort: a progress write must never fail the recovery it narrates.
 *
 * A read-modify-write of the map, which is safe because recoveries are
 * serialized (`recoveryQueue`) and this is the only writer.
 */
export async function reportGuardianNoteRecoveryProgress(progress: GuardianNoteRecoveryProgress): Promise<void> {
  try {
    const entries = await fetchMap();
    entries[progress.accountId] = { ...progress, updatedAt: Date.now() };
    await putToStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, evictOldest(entries, progress.accountId));
  } catch (error) {
    console.warn('[GuardianRecovery] Failed to persist recovery progress:', error);
  }
}

/**
 * Trims to `MAX_TRACKED_ACCOUNTS`, oldest first and never the account being
 * written. Not staleness-based: an entry is a checkpoint as well as a card, and
 * a checkpoint is still valid long after the card should have stopped showing.
 */
function evictOldest(
  entries: Record<string, GuardianNoteRecoveryProgress>,
  keep: string
): Record<string, GuardianNoteRecoveryProgress> {
  const accountIds = Object.keys(entries);
  if (accountIds.length <= MAX_TRACKED_ACCOUNTS) return entries;
  const evictable = accountIds
    .filter(accountId => accountId !== keep)
    .sort((a, b) => (entries[a]!.updatedAt ?? 0) - (entries[b]!.updatedAt ?? 0));
  for (const accountId of evictable.slice(0, accountIds.length - MAX_TRACKED_ACCOUNTS)) {
    delete entries[accountId];
  }
  return entries;
}

/** Drop one account's record, leaving every other account's untouched. */
export async function clearGuardianNoteRecoveryProgress(accountId: string): Promise<void> {
  try {
    const entries = await fetchMap();
    if (!(accountId in entries)) return;
    delete entries[accountId];
    await putToStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, Object.keys(entries).length === 0 ? null : entries);
  } catch (error) {
    console.warn('[GuardianRecovery] Failed to clear recovery progress:', error);
  }
}
