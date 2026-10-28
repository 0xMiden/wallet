import * as Passworder from '../passworder';
import type { EncryptedPayload } from '../passworder';
import { JOURNAL_MAX_BYTES } from './journal';
import { fromSerializable, toSerializable } from './serialization';
import type { RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';

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

const PASSWORD_CHECK = 'miden-recovery-data-password-check-v1';
const encoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encryptedPayload(value: unknown): value is EncryptedPayload {
  return (
    record(value) &&
    Object.keys(value).every(key => key === 'dt' || key === 'iv') &&
    typeof value.dt === 'string' &&
    value.dt.length >= 24 &&
    value.dt.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value.dt) &&
    typeof value.iv === 'string' &&
    /^[A-Za-z0-9+/]{22}==$/.test(value.iv)
  );
}

function envelope(value: unknown): EncryptedRecoveryDataFile {
  if (
    record(value) &&
    value.format === RECOVERY_DATA_FORMAT &&
    value.formatVersion !== undefined &&
    value.formatVersion !== RECOVERY_DATA_VERSION
  )
    throw new RecoveryDataFileError('version');
  if (
    !record(value) ||
    Object.keys(value).some(key => !['format', 'formatVersion', 'salt', 'payload', 'passwordCheck'].includes(key)) ||
    value.format !== RECOVERY_DATA_FORMAT ||
    value.formatVersion !== RECOVERY_DATA_VERSION ||
    !Array.isArray(value.salt) ||
    value.salt.length !== 32 ||
    !value.salt.every(
      (byte: unknown) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255
    ) ||
    !encryptedPayload(value.payload) ||
    !encryptedPayload(value.passwordCheck)
  )
    throw new RecoveryDataFileError('malformed');
  const salt: number[] = [];
  for (const byte of value.salt) {
    if (typeof byte !== 'number') throw new RecoveryDataFileError('malformed');
    salt.push(byte);
  }
  return {
    format: RECOVERY_DATA_FORMAT,
    formatVersion: RECOVERY_DATA_VERSION,
    salt,
    payload: value.payload,
    passwordCheck: value.passwordCheck
  };
}

export async function encryptRecoveryDataFile(
  snapshot: RecoveryJournalSnapshot,
  filePassword: string,
  assertCurrent: () => void = () => {}
): Promise<string> {
  assertCurrent();
  const serialized = toSerializable(validateJournal(snapshot));
  if (encoder.encode(JSON.stringify(serialized)).byteLength > JOURNAL_MAX_BYTES)
    throw new RecoveryDataFileError('size');
  const salt = Passworder.generateSalt();
  const passwordKey = await Passworder.generateKey(filePassword);
  assertCurrent();
  const cipher = await Passworder.deriveKey(passwordKey, salt);
  assertCurrent();
  const payload = await Passworder.encryptJson(
    { format: RECOVERY_DATA_FORMAT, formatVersion: RECOVERY_DATA_VERSION, snapshot: serialized },
    cipher
  );
  assertCurrent();
  const passwordCheck = await Passworder.encryptJson(PASSWORD_CHECK, cipher);
  assertCurrent();
  const file: EncryptedRecoveryDataFile = {
    format: RECOVERY_DATA_FORMAT,
    formatVersion: RECOVERY_DATA_VERSION,
    salt: Array.from(salt),
    payload,
    passwordCheck
  };
  const content = JSON.stringify(file);
  if (encoder.encode(content).byteLength > RECOVERY_DATA_FILE_MAX_BYTES) throw new RecoveryDataFileError('size');
  return content;
}

export async function decryptRecoveryDataFile(
  content: string,
  filePassword: string,
  assertCurrent: () => void = () => {}
): Promise<RecoveryJournalSnapshot> {
  assertCurrent();
  if (
    content.length > RECOVERY_DATA_FILE_MAX_BYTES ||
    encoder.encode(content).byteLength > RECOVERY_DATA_FILE_MAX_BYTES
  )
    throw new RecoveryDataFileError('size');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RecoveryDataFileError('malformed');
  }
  const file = envelope(parsed);
  const passwordKey = await Passworder.generateKey(filePassword);
  assertCurrent();
  const cipher = await Passworder.deriveKey(passwordKey, Uint8Array.from(file.salt));
  assertCurrent();
  let checked: unknown;
  try {
    checked = await Passworder.decryptJson(file.passwordCheck, cipher);
  } catch {
    throw new RecoveryDataFileError('password');
  }
  assertCurrent();
  if (checked !== PASSWORD_CHECK) throw new RecoveryDataFileError('password');
  let payload: unknown;
  try {
    payload = await Passworder.decryptJson(file.payload, cipher);
  } catch {
    throw new RecoveryDataFileError('password');
  }
  assertCurrent();
  try {
    if (!record(payload) || payload.format !== RECOVERY_DATA_FORMAT || payload.formatVersion !== RECOVERY_DATA_VERSION)
      throw new RecoveryDataFileError('malformed');
    if (Object.keys(payload).some(key => !['format', 'formatVersion', 'snapshot'].includes(key)))
      throw new RecoveryDataFileError('malformed');
    if (encoder.encode(JSON.stringify(payload.snapshot)).byteLength > JOURNAL_MAX_BYTES)
      throw new RecoveryDataFileError('size');
    return validateJournal(fromSerializable(payload.snapshot));
  } catch (error) {
    if (error instanceof RecoveryDataFileError) throw error;
    throw new RecoveryDataFileError('malformed');
  }
}

export interface RecoveryDataImportResult {
  imported: boolean;
  retainedEntries: number;
}
