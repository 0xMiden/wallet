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

export interface RecoveryTransactionEntry {
  kind: 'transaction';
  id: string;
  accountId: string;
  requestBytes: Uint8Array;
  mayHaveSubmitted: boolean;
  evidence: SubmitEvidenceFields;
}

export type RecoveryEntry = RecoveryNoteEntry | RecoveryTransactionEntry;

export interface RecoveryJournalData {
  scope: RecoveryScope;
  accounts: RecoveryAccountExpectation[];
  entries: RecoveryEntry[];
}

export interface RecoveryJournalSnapshot extends RecoveryJournalData {
  version: 1;
  sequence: number;
}
