import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryNoteEntry } from './types';

export interface RecoveryRetirementReads {
  identity: (note: RecoveryNoteEntry) => Promise<{ nullifier: string; fromBlock: number } | undefined>;
  header: (block: number) => Promise<string | undefined>;
  scan: (nullifier: string, block: number) => Promise<readonly { nullifier: string; block: number }[]>;
}
export interface RecoveryRetirementContext {
  snapshot: RecoveryJournalSnapshot;
  reads: RecoveryRetirementReads;
  deadline: number;
  assertCurrent: () => void;
  retain: (entries: RecoveryEntry[]) => Promise<void>;
}
export async function retireRecoveryNotes(_context: RecoveryRetirementContext): Promise<number> { return 0; }
