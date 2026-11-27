import { v4 as uuid } from 'uuid';
import { z } from 'zod';

import { fetchFromStorage, inStorageTurn, putToStorage } from 'lib/miden/front/storage';

import type { GuardianHistoryCheckpoint } from './history';

export const GUARDIAN_HISTORY_STORAGE_KEY = 'guardian_history_recovery_v1';
export const GUARDIAN_HISTORY_GENERATION_KEY = 'guardian_history_generation_v1';

export function withWalletRecoveryLifetime<T>(operation: () => Promise<T>): Promise<T> {
  return inStorageTurn('miden-wallet-recovery-lifetime', operation);
}

const checkpointSchema = z.object({
  id: z.string(),
  network: z.string(),
  accountId: z.string(),
  operator: z.string(),
  version: z.number().int().positive(),
  cursor: z.string().optional(),
  seenCursors: z.array(z.string()),
  completed: z.boolean(),
  restored: z.number().int().nonnegative(),
  lowestNonce: z.number().int().optional(),
  entryCount: z.number().int().nonnegative().optional(),
  unsupportedPasses: z.number().int().nonnegative().optional(),
  invalidDataPasses: z.number().int().nonnegative().optional(),
  deferredFailurePasses: z.number().int().nonnegative().optional(),
  abortedDecodePasses: z.number().int().nonnegative().optional(),
  failure: z
    .enum(['fee-metadata', 'account-not-found', 'authentication', 'unsupported', 'network', 'invalid-data'])
    .optional(),
  feeScope: z.string().optional(),
  terminal: z.boolean().optional()
});

const stateSchema = z.object({
  generation: z.string(),
  checkpoints: z.record(checkpointSchema)
});

export async function readExistingGuardianHistoryGeneration(): Promise<string | null> {
  const current = z.string().safeParse(await fetchFromStorage(GUARDIAN_HISTORY_GENERATION_KEY));
  return current.success ? current.data : null;
}

async function readGuardianHistoryGenerationInTurn(): Promise<string> {
  const current = await readExistingGuardianHistoryGeneration();
  if (current !== null) return current;
  // A missing marker is a wipe, not a constant: a pass that began before it must see a new generation.
  const generation = uuid();
  await putToStorage(GUARDIAN_HISTORY_GENERATION_KEY, generation);
  return generation;
}

export async function readGuardianHistoryGeneration(): Promise<string> {
  return (
    (await readExistingGuardianHistoryGeneration()) ?? withWalletRecoveryLifetime(readGuardianHistoryGenerationInTurn)
  );
}

async function readCheckpoints(generation: string): Promise<z.infer<typeof stateSchema>> {
  const parsed = stateSchema.safeParse(await fetchFromStorage(GUARDIAN_HISTORY_STORAGE_KEY));
  if (parsed.success && parsed.data.generation === generation) return parsed.data;
  return { generation, checkpoints: {} };
}

export async function readGuardianHistoryState(): Promise<z.infer<typeof stateSchema>> {
  return readCheckpoints(await readGuardianHistoryGeneration());
}

// Save the records first. A missed cursor write causes an idempotent page replay.
export async function saveGuardianHistoryCheckpoint(
  generation: string,
  checkpoint: GuardianHistoryCheckpoint
): Promise<boolean> {
  return withWalletRecoveryLifetime(async () => {
    const state = await readCheckpoints(await readGuardianHistoryGenerationInTurn());
    if (state.generation !== generation) return false;
    await putToStorage(GUARDIAN_HISTORY_STORAGE_KEY, {
      generation,
      checkpoints: { ...state.checkpoints, [checkpoint.id]: checkpoint }
    });
    return true;
  });
}

/** For a restore that already holds the wallet recovery lifetime turn. */
export async function clearGuardianHistoryCheckpointsInTurn(): Promise<void> {
  const generation = uuid();
  // A late cursor write cannot change this separate import marker.
  await putToStorage(GUARDIAN_HISTORY_GENERATION_KEY, generation);
  await putToStorage(GUARDIAN_HISTORY_STORAGE_KEY, { generation, checkpoints: {} });
}

export function clearGuardianHistoryCheckpoints(): Promise<void> {
  return withWalletRecoveryLifetime(clearGuardianHistoryCheckpointsInTurn);
}
