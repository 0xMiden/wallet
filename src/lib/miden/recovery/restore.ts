import { StorageContinuityError } from './continuity';
import { toSerializable } from './serialization';
import type { RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';
import { ITransaction, ITransactionStatus } from '../db/types';
import * as Repo from '../repo';
import { sameWalletAccountId } from '../sdk/helpers';
import { canonicalSpendingLimitIdentity } from '../spending-limits/identity';
import { MAX_WINDOW_SECONDS } from '../spending-limits/window';
import { assertStorageRecoveryAllowed, type StorageRecoveryCapability } from '../storage-health';

export async function restoreWalletRecoveryRows(
  source: RecoveryJournalSnapshot,
  capability: StorageRecoveryCapability
): Promise<void> {
  const snapshot = validateJournal(source);
  assertStorageRecoveryAllowed(capability);
  const target = await Repo.openWalletRecoveryStore(capability);
  try {
    assertStorageRecoveryAllowed(capability);
    await target.transaction('rw', target.tables, async () => {
      assertStorageRecoveryAllowed(capability);
      for (const entry of snapshot.entries) {
        if (entry.kind === 'policy') {
          const accountId = canonicalSpendingLimitIdentity(entry.accountId);
          const current: unknown = await target.table('spendingLimits').get(accountId);
          if (current !== undefined && JSON.stringify(current) !== JSON.stringify(entry.configuration))
            throw new StorageContinuityError();
          if (entry.configuration !== null) await target.table('spendingLimits').put(entry.configuration);
        } else if (entry.kind === 'debit' && entry.initiatedAt >= Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS) {
          const current: unknown = await target.table('recoveryDebits').get(entry.id);
          if (
            current !== undefined &&
            JSON.stringify(toSerializable(current)) !== JSON.stringify(toSerializable(entry))
          )
            throw new StorageContinuityError();
          await target.table('recoveryDebits').put(entry);
        } else if (entry.kind === 'transaction') {
          if (!entry.row) throw new Error('Recovery transaction details unavailable');
          const current: ITransaction | undefined = await target.table<ITransaction>('transactions').get(entry.id);
          if (current && !sameWalletAccountId(current.accountId, entry.accountId)) throw new StorageContinuityError();
          await target.table('transactions').put({
            ...(current ?? entry.row),
            requestBytes: current?.requestBytes ?? entry.requestBytes,
            mayHaveSubmitted: entry.mayHaveSubmitted,
            status: ITransactionStatus.Unconfirmed,
            restoredFromBackup: true,
            restoredFromJournal: true
          });
        }
      }
      assertStorageRecoveryAllowed(capability);
    });
    assertStorageRecoveryAllowed(capability);
  } finally {
    target.close();
  }
}
