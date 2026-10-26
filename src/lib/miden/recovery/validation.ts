import type { SubmitEvidenceFields } from '../db/types';
import type { RecoveryAccountExpectation, RecoveryEntry, RecoveryJournalSnapshot, RecoveryScope } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}
function nonce(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value);
}
export function isRecoveryScope(value: unknown): value is RecoveryScope {
  return record(value) && keys(value, ['network', 'walletGeneration', 'sdkGeneration']) &&
    text(value.network) && text(value.walletGeneration) && text(value.sdkGeneration);
}
export function isRecoveryAccount(value: unknown): value is RecoveryAccountExpectation {
  return record(value) && keys(value, ['accountId', 'nonce', 'commitment']) &&
    text(value.accountId) && nonce(value.nonce) && text(value.commitment);
}
function evidence(value: unknown): value is SubmitEvidenceFields {
  if (!record(value)) return false;
  const strings = ['transactionId', 'initialCommitment', 'finalCommitment', 'refBlockCommitment'];
  const numbers = ['refBlock', 'expirationBlock'];
  const arrays = ['outputNoteIds', 'nullifiers'];
  if (!keys(value, [...strings, ...numbers, ...arrays, 'initialNonce'])) return false;
  return Object.entries(value).every(([key, item]) => {
    if (strings.includes(key)) return text(item);
    if (numbers.includes(key)) return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
    if (arrays.includes(key)) return Array.isArray(item) && item.length <= 256 && item.every(text);
    return nonce(item);
  });
}
function entry(value: unknown): value is RecoveryEntry {
  if (!record(value) || !text(value.id)) return false;
  if (value.kind === 'note') return keys(value, ['kind', 'id', 'accountId', 'noteFile', 'provenance']) &&
    (value.accountId === undefined || text(value.accountId)) && value.noteFile instanceof Uint8Array && value.noteFile.length > 0 &&
    (value.provenance === 'input' || value.provenance === 'output');
  return value.kind === 'transaction' && text(value.accountId) && keys(value, ['kind', 'id', 'accountId', 'requestBytes', 'mayHaveSubmitted', 'evidence']) &&
    value.requestBytes instanceof Uint8Array && value.requestBytes.length > 0 &&
    typeof value.mayHaveSubmitted === 'boolean' && evidence(value.evidence);
}
export function validateJournal(value: unknown): RecoveryJournalSnapshot {
  if (!record(value) || !keys(value, ['version', 'sequence', 'scope', 'accounts', 'entries']) || value.version !== 1 ||
      typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !isRecoveryScope(value.scope) || !Array.isArray(value.accounts) || value.accounts.length === 0 || value.accounts.length > 256 ||
      !value.accounts.every(isRecoveryAccount) || !Array.isArray(value.entries) || value.entries.length > 256 || !value.entries.every(entry)) {
    throw new Error('Invalid recovery journal');
  }
  const accounts = value.accounts;
  const entries = value.entries;
  if (new Set(accounts.map(account => account.accountId)).size !== accounts.length ||
      new Set(entries.map(item => `${item.kind}:${item.id}`)).size !== entries.length ||
      entries.some(item => item.accountId !== undefined && !accounts.some(account => account.accountId === item.accountId))) {
    throw new Error('Invalid recovery journal identity');
  }
  return { version: 1, sequence: value.sequence, scope: value.scope, accounts, entries };
}
