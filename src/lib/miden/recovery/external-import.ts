import { RecoveryDataFileError } from './external-file';
import type { RecoveryJournalData, RecoveryJournalSnapshot, RecoveryScope } from './types';

export interface RecoveryDataImportBinding {
  scope: RecoveryScope;
  accountIds: string[];
}

export function mergeExternalRecoveryData(
  _incoming: RecoveryJournalSnapshot,
  _binding: RecoveryDataImportBinding,
  _retained?: RecoveryJournalSnapshot
): RecoveryJournalData {
  throw new RecoveryDataFileError('unavailable');
}
