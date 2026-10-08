import { v4 as uuid } from 'uuid';
import { z } from 'zod';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import type { GuardianHistoryCheckpoint } from './history';

export const GUARDIAN_HISTORY_STORAGE_KEY = 'guardian_history_recovery_v1';
const GUARDIAN_HISTORY_GENERATION_KEY = 'guardian_history_generation_v1';

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
  // zod 4: a record names its key schema; checkpoint ids are strings.
  checkpoints: z.record(z.string(), checkpointSchema)
});

export async function readGuardianHistoryGeneration(): Promise<string> {
  const current = z.string().safeParse(await fetchFromStorage(GUARDIAN_HISTORY_GENERATION_KEY));
  if (current.success) return current.data;
  // A missing marker is a wipe, not a constant: a pass that began before it must see a new generation.
  const generation = uuid();
  await putToStorage(GUARDIAN_HISTORY_GENERATION_KEY, generation);
  return generation;
}

export async function readGuardianHistoryState(): Promise<z.infer<typeof stateSchema>> {
  const generation = await readGuardianHistoryGeneration();
  const parsed = stateSchema.safeParse(await fetchFromStorage(GUARDIAN_HISTORY_STORAGE_KEY));
  if (parsed.success && parsed.data.generation === generation) return parsed.data;
  return { generation, checkpoints: {} };
}

// Save the records first. A missed cursor write causes an idempotent page replay.
export async function saveGuardianHistoryCheckpoint(
  generation: string,
  checkpoint: GuardianHistoryCheckpoint
): Promise<boolean> {
  const state = await readGuardianHistoryState();
  if (state.generation !== generation) return false;
  await putToStorage(GUARDIAN_HISTORY_STORAGE_KEY, {
    generation,
    checkpoints: { ...state.checkpoints, [checkpoint.id]: checkpoint }
  });
  return true;
}

export async function clearGuardianHistoryCheckpoints(): Promise<void> {
  const generation = uuid();
  // A late cursor write cannot change this separate import marker.
  await putToStorage(GUARDIAN_HISTORY_GENERATION_KEY, generation);
  await putToStorage(GUARDIAN_HISTORY_STORAGE_KEY, { generation, checkpoints: {} });
}
