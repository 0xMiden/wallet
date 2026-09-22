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
  failure: z
    .enum(['fee-metadata', 'account-not-found', 'authentication', 'unsupported', 'network', 'invalid-data'])
    .optional()
});

const stateSchema = z.object({
  generation: z.string(),
  checkpoints: z.record(checkpointSchema)
});

export async function readGuardianHistoryState(): Promise<z.infer<typeof stateSchema>> {
  const current = z.string().safeParse(await fetchFromStorage(GUARDIAN_HISTORY_GENERATION_KEY));
  const generation = current.success ? current.data : 'initial';
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
