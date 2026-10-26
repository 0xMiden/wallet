import type { RecoveryCapture } from './types';
import { assertStorageHealthy, getStorageHealth } from '../storage-health';

export async function checkpointTransactionRecovery(
  id: string,
  capture: RecoveryCapture,
  evidence?: import('../db/types').SubmitEvidenceFields,
  attemptId?: string
): Promise<void> {
  assertStorageHealthy();
  const epoch = getStorageHealth().epoch;
  const { withUnlocked } = await import('../back/store');
  assertStorageHealthy(epoch);
  await withUnlocked(({ vault }) => vault.retainTransactionRecovery(id, capture, evidence, attemptId));
  assertStorageHealthy(epoch);
}
