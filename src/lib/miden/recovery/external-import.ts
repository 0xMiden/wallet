import { RecoveryDataFileError } from './external-file';
import { JOURNAL_MAX_BYTES } from './journal';
import { sameAcquiredNote } from './note-acquisition';
import { retainNoteCandidates } from './note-candidates';
import { toSerializable } from './serialization';
import { validateRecoveryReceipt, validateRecoveryTransaction } from './transaction-record';
import type { RecoveryEntry, RecoveryJournalData, RecoveryJournalSnapshot, RecoveryScope } from './types';
import { validateJournal } from './validation';
import { ITransactionStatus } from '../db/types';

export interface RecoveryDataImportBinding {
  scope: RecoveryScope;
  accountIds: string[];
}

function externalEntry(entry: RecoveryEntry): RecoveryEntry {
  if (entry.kind === 'transaction') {
    const { resolved: _resolved, scans: _scans, ...uncertain } = entry;
    return {
      ...uncertain,
      mayHaveSubmitted: true,
      row: entry.row && {
        ...validateRecoveryTransaction(entry.row),
        status: ITransactionStatus.Unconfirmed,
        mayHaveSubmitted: true,
        restoredFromBackup: false,
        restoredFromJournal: true
      }
    };
  }
  if (entry.kind === 'receipt')
    return {
      ...entry,
      row: {
        ...validateRecoveryReceipt(entry.row),
        status: ITransactionStatus.Unconfirmed,
        mayHaveSubmitted: true,
        restoredFromBackup: false,
        restoredFromJournal: true
      }
    };
  return entry;
}

export function mergeExternalRecoveryData(
  source: RecoveryJournalSnapshot,
  binding: RecoveryDataImportBinding,
  local?: RecoveryJournalSnapshot
): RecoveryJournalData {
  const incoming = validateJournal(source);
  const retained = local && validateJournal(local);
  if (
    incoming.scope.network !== binding.scope.network ||
    (retained && retained.scope.network !== binding.scope.network)
  )
    throw new RecoveryDataFileError('network');
  if (
    retained &&
    (retained.scope.walletGeneration !== binding.scope.walletGeneration ||
      retained.scope.sdkGeneration !== binding.scope.sdkGeneration)
  )
    throw new RecoveryDataFileError('account');
  const owners = new Set(binding.accountIds);
  if (
    owners.size === 0 ||
    owners.size > 256 ||
    owners.size !== binding.accountIds.length ||
    [...incoming.accounts, ...(retained?.accounts ?? [])].some(account => !owners.has(account.accountId))
  )
    throw new RecoveryDataFileError('account');
  const floors = new Map(retained?.accounts.map(account => [account.accountId, account]));
  for (const account of incoming.accounts) {
    const previous = floors.get(account.accountId);
    if (previous && previous.nonce === account.nonce && previous.commitment !== account.commitment)
      throw new RecoveryDataFileError('account');
    if (!previous || BigInt(account.nonce) > BigInt(previous.nonce)) floors.set(account.accountId, account);
  }
  if (binding.accountIds.some(id => !floors.has(id))) throw new RecoveryDataFileError('account');
  const entries = [...(retained?.entries ?? [])];
  for (const entry of incoming.entries.map(externalEntry)) {
    if (entry.kind === 'note') {
      const previous = entries.find(
        value =>
          value.kind === 'note' &&
          value.provenance === entry.provenance &&
          (value.accountId === undefined || entry.accountId === undefined || value.accountId === entry.accountId) &&
          sameAcquiredNote(value, entry)
      );
      if (previous?.kind === 'note') {
        entries[entries.indexOf(previous)] = retainNoteCandidates(previous, entry);
        continue;
      }
    }
    if (!entries.some(value => value.kind === entry.kind && value.id === entry.id)) entries.push(entry);
  }
  const result = validateJournal({
    version: 1,
    sequence: Math.max(incoming.sequence, retained?.sequence ?? 1),
    scope: binding.scope,
    accounts: [...floors.values()],
    entries
  });
  if (new TextEncoder().encode(JSON.stringify(toSerializable(result))).byteLength > JOURNAL_MAX_BYTES)
    throw new RecoveryDataFileError('size');
  return { scope: result.scope, accounts: result.accounts, entries: result.entries };
}
