// Live progress record for the post-seed-recovery pending-note scan.
//
// The SW-side orchestrator (lib/miden/back/guardian-recovery.ts) writes this
// record as it advances through the recovery sources; the home view renders it
// as a non-dismissible prompt card (HomePrompts). Kept in its own
// dependency-light module (only the storage facade) so the service worker can
// import the writers without pulling the react-flavored wallet-prompts module.

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

export const GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY = 'guardian_note_recovery_progress_v1';

export type GuardianNoteRecoveryStep = 'transport' | 'proposals' | 'public';

export type GuardianNoteRecoveryProgress = {
  accountId: string;
  step: GuardianNoteRecoveryStep;
  /** Public-backfill bounds; present only during the `public` step. */
  startBlock?: number;
  syncedToBlock?: number;
  latestBlock?: number;
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
    latestBlock: numberOrUndefined(Reflect.get(value, 'latestBlock'))
  };
}

export async function fetchGuardianNoteRecoveryProgress(): Promise<GuardianNoteRecoveryProgress | null> {
  return normalizeGuardianNoteRecoveryProgress(await fetchFromStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY));
}

/** Best-effort: a progress write must never fail the recovery it narrates. */
export async function reportGuardianNoteRecoveryProgress(progress: GuardianNoteRecoveryProgress): Promise<void> {
  try {
    await putToStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, progress);
  } catch (error) {
    console.warn('[GuardianRecovery] Failed to persist recovery progress:', error);
  }
}

export async function clearGuardianNoteRecoveryProgress(): Promise<void> {
  try {
    await putToStorage(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, null);
  } catch (error) {
    console.warn('[GuardianRecovery] Failed to clear recovery progress:', error);
  }
}
