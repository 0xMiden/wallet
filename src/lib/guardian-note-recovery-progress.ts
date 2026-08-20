// Live progress record for the post-seed-recovery pending-note scan.
//
// The SW-side orchestrator (lib/miden/back/guardian-recovery.ts) writes this
// record as it advances through the recovery sources; the home view renders it
// as a non-dismissible prompt card (HomePrompts). Kept in its own
// dependency-light module (only the storage facade) so the service worker can
// import the writers without pulling the react-flavored wallet-prompts module.

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

export const GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY = 'guardian_note_recovery_progress_v1';

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
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeGuardianNoteRecoveryProgress(value: unknown): GuardianNoteRecoveryProgress | null {
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
    updatedAt: numberOrUndefined(Reflect.get(value, 'updatedAt'))
  };
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

export async function fetchGuardianNoteRecoveryProgress(): Promise<GuardianNoteRecoveryProgress | null> {
  return normalizeGuardianNoteRecoveryProgress(await fetchFromStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY));
}

/** Best-effort: a progress write must never fail the recovery it narrates. */
export async function reportGuardianNoteRecoveryProgress(progress: GuardianNoteRecoveryProgress): Promise<void> {
  try {
    await putToStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, { ...progress, updatedAt: Date.now() });
  } catch (error) {
    console.warn('[GuardianRecovery] Failed to persist recovery progress:', error);
  }
}

/**
 * Drop the progress record, but only when it still belongs to `accountId` —
 * recoveries are serialized, yet a run that outlives its own realm could
 * otherwise erase the card of the run that succeeded it.
 */
export async function clearGuardianNoteRecoveryProgress(accountId: string): Promise<void> {
  try {
    const current = await fetchGuardianNoteRecoveryProgress();
    if (current && current.accountId !== accountId) return;
    await putToStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, null);
  } catch (error) {
    console.warn('[GuardianRecovery] Failed to clear recovery progress:', error);
  }
}
