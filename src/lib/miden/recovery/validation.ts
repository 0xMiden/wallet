import { recoveryNoteMaterials } from './note-candidates';
import { validateRecoveryReceipt, validateRecoveryTransaction } from './transaction-record';
import type {
  RecoveryAccountExpectation,
  RecoveryNoteEntry,
  RecoveryEntry,
  RecoveryJournalSnapshot,
  RecoveryScope
} from './types';
import type { SubmitEvidenceFields } from '../db/types';
import { parsePersistedSpendingLimit } from '../spending-limits/types';

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
function debitFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.initiatedAt === 'number' &&
    Number.isSafeInteger(value.initiatedAt) &&
    value.initiatedAt >= 0 &&
    (value.spentUsd === undefined || (typeof value.spentUsd === 'bigint' && value.spentUsd >= 0n)) &&
    (value.authorizationId === undefined || text(value.authorizationId)) &&
    (value.spentUsd !== undefined || value.authorizationId !== undefined)
  );
}
function retry(value: Record<string, unknown>): boolean {
  if (value.retry === undefined) return true;
  const transition = value.retry;
  return (
    record(transition) &&
    keys(transition, ['previous', 'queuedSeq']) &&
    typeof transition.queuedSeq === 'number' &&
    Number.isSafeInteger(transition.queuedSeq) &&
    transition.queuedSeq >= 0 &&
    record(transition.previous) &&
    keys(transition.previous, ['initiatedAt', 'spentUsd', 'authorizationId']) &&
    debitFields(transition.previous) &&
    transition.previous.spentUsd === value.spentUsd &&
    transition.previous.authorizationId === value.authorizationId
  );
}
function scans(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 256 &&
      value.every(
        item =>
          record(item) &&
          keys(item, ['nullifier', 'nextBlock', 'anchorBlock', 'anchor', 'height']) &&
          text(item.nullifier) &&
          text(item.anchor) &&
          [item.nextBlock, item.anchorBlock].every(
            block => typeof block === 'number' && Number.isSafeInteger(block) && block >= 0
          ) &&
          item.nextBlock === Number(item.anchorBlock) + 1 &&
          (item.height === undefined || item.height === item.anchorBlock)
      ) &&
      new Set(value.map(item => item.nullifier)).size === value.length)
  );
}
export function isRecoveryScope(value: unknown): value is RecoveryScope {
  return (
    record(value) &&
    keys(value, ['network', 'walletGeneration', 'sdkGeneration']) &&
    text(value.network) &&
    text(value.walletGeneration) &&
    text(value.sdkGeneration)
  );
}
export function isRecoveryAccount(value: unknown): value is RecoveryAccountExpectation {
  return (
    record(value) &&
    keys(value, ['accountId', 'nonce', 'commitment']) &&
    text(value.accountId) &&
    nonce(value.nonce) &&
    text(value.commitment)
  );
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
function noteMaterial(value: Record<string, unknown>): boolean {
  return (
    text(value.id) &&
    (value.accountId === undefined || text(value.accountId)) &&
    (value.detailsId === undefined ||
      (typeof value.detailsId === 'string' && /^[0-9a-f]{64}$/.test(value.detailsId))) &&
    value.noteFile instanceof Uint8Array &&
    value.noteFile.length > 0 &&
    (value.provenance === 'input' || value.provenance === 'output') &&
    (value.format === undefined || value.format === 'full' || value.format === 'details')
  );
}
export function isRecoveryNote(value: unknown): value is RecoveryNoteEntry {
  if (!record(value) || value.kind !== 'note') return false;
  return (
    keys(value, ['kind', 'id', 'accountId', 'detailsId', 'noteFile', 'provenance', 'format', 'scan', 'candidates']) &&
    noteMaterial(value) &&
    (value.candidates === undefined ||
      (Array.isArray(value.candidates) &&
        value.candidates.length > 0 &&
        value.candidates.length < 256 &&
        value.candidates.every(
          candidate =>
            record(candidate) &&
            keys(candidate, ['id', 'accountId', 'detailsId', 'noteFile', 'provenance', 'format']) &&
            noteMaterial(candidate)
        ))) &&
    (value.scan === undefined ||
      (record(value.scan) &&
        keys(value.scan, ['nextBlock', 'anchorBlock', 'anchor']) &&
        text(value.scan.anchor) &&
        [value.scan.nextBlock, value.scan.anchorBlock].every(
          item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
        ) &&
        value.scan.nextBlock === Number(value.scan.anchorBlock) + 1))
  );
}
function entry(value: unknown): value is RecoveryEntry {
  if (!record(value) || !text(value.id)) return false;
  if (value.kind === 'note') return isRecoveryNote(value);
  if (value.kind === 'receipt') {
    if (!text(value.accountId) || !keys(value, ['kind', 'id', 'accountId', 'row'])) return false;
    try {
      const row = validateRecoveryReceipt(value.row);
      return row.id === value.id && row.accountId === value.accountId;
    } catch {
      return false;
    }
  }
  if (value.kind === 'policy') {
    if (!text(value.accountId) || !keys(value, ['kind', 'id', 'accountId', 'configuration'])) return false;
    if (value.configuration === null) return true;
    if (
      !record(value.configuration) ||
      !keys(value.configuration, ['accountId', 'limit', 'revision', 'createdAt', 'updatedAt'])
    )
      return false;
    try {
      parsePersistedSpendingLimit(value.configuration);
      return true;
    } catch {
      return false;
    }
  }
  if (value.kind === 'debit')
    return (
      text(value.accountId) &&
      keys(value, ['kind', 'id', 'accountId', 'initiatedAt', 'spentUsd', 'authorizationId', 'retry']) &&
      debitFields(value) &&
      retry(value)
    );

  if (value.kind === 'transaction' && value.row !== undefined) {
    try {
      const row = validateRecoveryTransaction(value.row);
      if (row.id !== value.id || row.accountId !== value.accountId) return false;
    } catch {
      return false;
    }
  }
  return (
    value.kind === 'transaction' &&
    text(value.accountId) &&
    keys(value, [
      'kind',
      'id',
      'accountId',
      'requestBytes',
      'mayHaveSubmitted',
      'evidence',
      'row',
      'resolved',
      'scans'
    ]) &&
    value.requestBytes instanceof Uint8Array &&
    value.requestBytes.length > 0 &&
    typeof value.mayHaveSubmitted === 'boolean' &&
    evidence(value.evidence) &&
    scans(value.scans) &&
    (value.resolved === undefined ||
      (record(value.resolved) &&
        keys(value.resolved, ['outcome', 'at', 'transactionId']) &&
        (value.resolved.outcome === 'landed' || value.resolved.outcome === 'never-committed') &&
        typeof value.resolved.at === 'number' &&
        Number.isSafeInteger(value.resolved.at) &&
        value.resolved.at >= 0 &&
        (value.resolved.transactionId === undefined || text(value.resolved.transactionId))))
  );
}
export function validateJournal(value: unknown): RecoveryJournalSnapshot {
  if (
    !record(value) ||
    !keys(value, ['version', 'sequence', 'scope', 'accounts', 'entries']) ||
    value.version !== 1 ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isRecoveryScope(value.scope) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length === 0 ||
    value.accounts.length > 256 ||
    !value.accounts.every(isRecoveryAccount) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 256 ||
    !value.entries.every(entry)
  ) {
    throw new Error('Invalid recovery journal');
  }
  const accounts = value.accounts;
  const entries = value.entries;
  if (
    entries.reduce((count, item) => count + (item.kind === 'note' ? recoveryNoteMaterials(item).length : 1), 0) > 256 ||
    new Set(accounts.map(account => account.accountId)).size !== accounts.length ||
    new Set(entries.map(item => `${item.kind}:${item.id}`)).size !== entries.length ||
    entries.some(item =>
      (item.kind === 'note' ? recoveryNoteMaterials(item) : [item]).some(
        material =>
          material.accountId !== undefined && !accounts.some(account => account.accountId === material.accountId)
      )
    )
  ) {
    throw new Error('Invalid recovery journal identity');
  }
  return { version: 1, sequence: value.sequence, scope: value.scope, accounts, entries };
}
