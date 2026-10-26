import type Dexie from 'dexie';

import type { RecoveryJournalSnapshot, RecoveryEntry } from './types';
import type { NodeReads } from '../transaction/reconcile-reads';

export interface RecoveryReconcileContext {
  snapshot: RecoveryJournalSnapshot;
  database: Dexie;
  node: NodeReads;
  deadline: number;
  assertCurrent: () => void;
  retain: (entries: RecoveryEntry[]) => Promise<void>;
}

export async function reconcileRecoveryTransactions(_context: RecoveryReconcileContext): Promise<number> {
  return 0;
}
