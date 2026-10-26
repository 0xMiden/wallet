import Dexie from 'dexie';

import type { RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';
import { ITransaction, ITransactionStatus } from '../db/types';
import * as Repo from '../repo';
import { MAX_WINDOW_SECONDS } from '../spending-limits/policy';
import { assertStorageRecoveryAllowed, type StorageRecoveryCapability } from '../storage-health';

export async function restoreWalletRecoveryRows(source: RecoveryJournalSnapshot, capability: StorageRecoveryCapability): Promise<void> {
  const snapshot = validateJournal(source);
  assertStorageRecoveryAllowed(capability);
  const target = new Dexie(Repo.db.name, { chromeTransactionDurability: 'strict' });
  target.version(3.3).stores({
    transactions: `${Repo.TRANSACTIONS_V2_STORE}, [badgeNetwork+status+type]`,
    spendingLimits: Repo.SPENDING_LIMITS_V19_STORE,
    metadata: 'id', recoveryDebits: 'id, accountId, initiatedAt, authorizationId'
  });
  try {
    await target.open();
    assertStorageRecoveryAllowed(capability);
    await target.transaction('rw', target.tables, async () => {
      assertStorageRecoveryAllowed(capability);
      for (const entry of snapshot.entries) {
        if (entry.kind === 'policy') {
          if (entry.configuration === null) await target.table('spendingLimits').delete(entry.id);
          else await target.table('spendingLimits').put(entry.configuration);
        } else if (entry.kind === 'debit' && entry.initiatedAt > Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS) {
          await target.table('recoveryDebits').put(entry);
        } else if (entry.kind === 'transaction') {
          if (!entry.row) throw new Error('Recovery transaction details unavailable');
          const current: ITransaction | undefined = await target.table<ITransaction>('transactions').get(entry.id);
          if (!current) {
            await target.table('transactions').put({
              ...entry.row, requestBytes: entry.requestBytes, mayHaveSubmitted: entry.mayHaveSubmitted,
              status: ITransactionStatus.Unconfirmed, restoredFromBackup: true, restoredFromJournal: true
            });
          }
        }
      }
      assertStorageRecoveryAllowed(capability);
      await target.table('metadata').put({ id: 'generation', generation: snapshot.scope.walletGeneration, origin: 'authorized' });
    });
    assertStorageRecoveryAllowed(capability);
  } finally {
    target.close();
  }
}
