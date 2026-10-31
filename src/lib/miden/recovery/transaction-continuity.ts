import type Dexie from 'dexie';

import { StorageContinuityError } from './continuity';
import { projectRecoveryTransaction, sameRecoveryProviderInputs } from './transaction-record';
import type { RecoveryEntry } from './types';
import type { ITransaction } from '../db/types';
import * as Repo from '../repo';
import { sameWalletAccountId } from '../sdk/helpers';

export async function verifyRetainedTransactionRows(
  entries: RecoveryEntry[],
  database: Dexie = Repo.db
): Promise<void> {
  const transactions = database.table<ITransaction>('transactions');
  await database.transaction('r', transactions, async () => {
    for (const entry of entries) {
      if (entry.kind !== 'transaction' && entry.kind !== 'receipt') continue;
      const row = await transactions.get(entry.id);
      if (!row || !sameWalletAccountId(row.accountId, entry.accountId)) throw new StorageContinuityError();
      if (entry.kind === 'receipt') {
        try {
          const current = projectRecoveryTransaction(row);
          if (
            !sameRecoveryProviderInputs(current.extraInputs, entry.row.extraInputs) ||
            current.type !== entry.row.type ||
            current.amount !== entry.row.amount ||
            current.faucetId !== entry.row.faucetId
          )
            throw new StorageContinuityError();
        } catch {
          throw new StorageContinuityError();
        }
        continue;
      }
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
