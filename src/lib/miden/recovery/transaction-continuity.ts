import type Dexie from 'dexie';

import { StorageContinuityError } from './continuity';
import type { RecoveryEntry } from './types';
import * as Repo from '../repo';
import type { ITransaction } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

export async function verifyRetainedTransactionRows(
  entries: RecoveryEntry[],
  database: Dexie = Repo.db
): Promise<void> {
  const transactions = database.table<ITransaction>('transactions');
  await database.transaction('r', transactions, async () => {
    for (const entry of entries) {
      if (entry.kind !== 'transaction') continue;
      const row = await transactions.get(entry.id);
      if (!row || !sameWalletAccountId(row.accountId, entry.accountId)) throw new StorageContinuityError();
      const expected = entry.row?.submitEvidence ?? [];
      for (const attempt of expected) {
        const current = row.submitEvidence?.find(item => item.attemptId === attempt.attemptId);
        if (
          !current ||
          ['transactionId', 'initialCommitment', 'finalCommitment', 'initialNonce', 'refBlockCommitment'].some(
            key => Reflect.get(attempt, key) !== undefined && Reflect.get(attempt, key) !== Reflect.get(current, key)
          )
        )
          throw new StorageContinuityError();
      }
    }
  });
}
