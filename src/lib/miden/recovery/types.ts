import type { RecoveryTransactionRow } from './transaction-record';
import type { PersistedSpendingLimit } from '../spending-limits/types';
import type { SubmitEvidenceFields } from '../db/types';

export interface RecoveryAccountExpectation {
  accountId: string;
  nonce: string;
  commitment: string;
}

export interface RecoveryScope {
  network: string;
  walletGeneration: string;
  sdkGeneration: string;
}

export interface RecoveryNoteEntry {
  kind: 'note';
  id: string;
  accountId?: string;
  noteFile: Uint8Array;
  provenance: 'input' | 'output';
  format?: 'full' | 'details';
}

export interface RecoveryCapture {
  requestBytes: Uint8Array;
  notes: RecoveryNoteEntry[];
}

export interface RecoveryTransactionEntry {
  kind: 'transaction';
  row?: RecoveryTransactionRow;
  id: string;
  accountId: string;
  requestBytes: Uint8Array;
  mayHaveSubmitted: boolean;
  evidence: SubmitEvidenceFields;
}

export interface RecoveryPolicyEntry {
  kind: 'policy';
  id: string;
  accountId: string;
  configuration: PersistedSpendingLimit | null;
}

export interface RecoveryDebitEntry {
  kind: 'debit';
  id: string;
  accountId: string;
  initiatedAt: number;
  spentUsd?: bigint;
  authorizationId?: string;
}

export type RecoveryEntry = RecoveryNoteEntry | RecoveryTransactionEntry | RecoveryPolicyEntry | RecoveryDebitEntry;

export interface RecoveryJournalData {
  scope: RecoveryScope;
  accounts: RecoveryAccountExpectation[];
  entries: RecoveryEntry[];
}

export interface RecoveryJournalSnapshot extends RecoveryJournalData {
  version: 1;
  sequence: number;
}
