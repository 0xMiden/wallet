import type { RecoveryTransactionRow } from './transaction-record';
import type { SubmitEvidenceFields } from '../db/types';
import type { PersistedSpendingLimit } from '../spending-limits/types';

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

export interface RecoveryNoteCandidate {
  id: string;
  accountId?: string;
  detailsId?: string;
  noteFile: Uint8Array;
  provenance: 'input' | 'output';
  format?: 'full' | 'details';
}

export interface RecoveryNoteEntry extends RecoveryNoteCandidate {
  kind: 'note';
  candidates?: RecoveryNoteCandidate[];
  scan?: { nextBlock: number; anchorBlock: number; anchor: string };
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
  resolved?: { outcome: 'landed' | 'never-committed'; at: number; transactionId?: string };
  scans?: RecoveryNullifierScan[];
}

export interface RecoveryReceiptEntry {
  kind: 'receipt';
  id: string;
  accountId: string;
  row: RecoveryTransactionRow;
}

export interface RecoveryNullifierScan {
  nullifier: string;
  nextBlock: number;
  anchorBlock: number;
  anchor: string;
  height?: number;
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
  retry?: {
    previous: { initiatedAt: number; spentUsd?: bigint; authorizationId?: string };
    queuedSeq: number;
  };
}

export type RecoveryEntry =
  | RecoveryNoteEntry
  | RecoveryTransactionEntry
  | RecoveryReceiptEntry
  | RecoveryPolicyEntry
  | RecoveryDebitEntry;

export interface RecoveryJournalData {
  scope: RecoveryScope;
  accounts: RecoveryAccountExpectation[];
  entries: RecoveryEntry[];
}

export interface RecoveryJournalSnapshot extends RecoveryJournalData {
  version: 1;
  sequence: number;
}

export interface StorageRecoveryProgress {
  phase: 'accounts' | 'notes' | 'validation' | 'complete';
  verifiedAccounts: number;
  expectedAccounts: number;
  verifiedInputs: number;
  expectedInputs: number;
}

export interface StorageRecoveryResult {
  recovered: boolean;
  progress?: StorageRecoveryProgress;
  reconciled?: number;
  retired?: number;
}
