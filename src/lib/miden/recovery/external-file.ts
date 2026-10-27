import type { EncryptedPayload } from '../passworder';
import type { RecoveryJournalSnapshot } from './types';

export const RECOVERY_DATA_FORMAT = 'miden-recovery-data';
export const RECOVERY_DATA_VERSION = 1;
export const RECOVERY_DATA_FILE_MAX_BYTES = 3 * 1024 * 1024;

export type RecoveryDataFileErrorCode =
  | 'unavailable'
  | 'malformed'
  | 'version'
  | 'password'
  | 'size'
  | 'network'
  | 'account';

export class RecoveryDataFileError extends Error {
  constructor(readonly code: RecoveryDataFileErrorCode) {
    super(`RecoveryDataFile:${code}`);
    this.name = 'RecoveryDataFileError';
  }
}

export interface EncryptedRecoveryDataFile {
  format: typeof RECOVERY_DATA_FORMAT;
  formatVersion: typeof RECOVERY_DATA_VERSION;
  salt: number[];
  payload: EncryptedPayload;
  passwordCheck: EncryptedPayload;
}

export async function encryptRecoveryDataFile(
  _snapshot: RecoveryJournalSnapshot,
  _filePassword: string,
  _assertCurrent: () => void = () => {}
): Promise<string> {
  throw new RecoveryDataFileError('unavailable');
}

export async function decryptRecoveryDataFile(
  _content: string,
  _filePassword: string,
  _assertCurrent: () => void = () => {}
): Promise<RecoveryJournalSnapshot> {
  throw new RecoveryDataFileError('unavailable');
}

export interface RecoveryDataImportResult {
  imported: boolean;
  retainedEntries: number;
}
