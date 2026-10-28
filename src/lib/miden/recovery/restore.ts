import { StorageContinuityError } from './continuity';
import { recoveryDebit } from './financial';
import { matchesRecoveryDebit, resolveRecoveryDebit } from './retry-transition';
import { toSerializable } from './serialization';
import { sameRecoveryFields } from './transaction-record';
import type { RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';
import { validateWalletGeneration } from './wallet-generation';
import { ITransaction, ITransactionStatus } from '../db/types';
import * as Repo from '../repo';
import { sameWalletAccountId } from '../sdk/helpers';
import { canonicalSpendingLimitIdentity } from '../spending-limits/identity';
import { MAX_WINDOW_SECONDS } from '../spending-limits/window';
import { assertStorageRecoveryAllowed, type StorageRecoveryCapability } from '../storage-health';

export async function restoreWalletRecoveryGeneration(
  source: RecoveryJournalSnapshot,
  capability: StorageRecoveryCapability
): Promise<void> {
  const snapshot = validateJournal(source);
  assertStorageRecoveryAllowed(capability);
  const target = await Repo.openWalletRecoveryStore(capability);
  try {
    assertStorageRecoveryAllowed(capability);
    await target.transaction('rw', target.table('metadata'), async () => {
      const value: unknown = await target.table('metadata').get('generation');
      assertStorageRecoveryAllowed(capability);
      const current = value === undefined ? undefined : validateWalletGeneration(value);
      if (current && current.generation !== snapshot.scope.walletGeneration && current.origin !== 'fresh')
        throw new StorageContinuityError();
      await target
        .table('metadata')
        .put({ id: 'generation', generation: snapshot.scope.walletGeneration, origin: 'authorized' });
      assertStorageRecoveryAllowed(capability);
    });
    const readback = validateWalletGeneration(await target.table('metadata').get('generation'));
    assertStorageRecoveryAllowed(capability);
    if (readback.generation !== snapshot.scope.walletGeneration || readback.origin !== 'authorized')
      throw new StorageContinuityError();
  } finally {
    target.close();
  }
}

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
      const ordered = [
        ...snapshot.entries.filter(entry => entry.kind !== 'receipt'),
        ...snapshot.entries.filter(entry => entry.kind === 'receipt')
      ];
      for (const entry of ordered) {
        if (entry.kind === 'policy') {
          const accountId = canonicalSpendingLimitIdentity(entry.accountId);
          const current: unknown = await target.table('spendingLimits').get(accountId);
          if (current !== undefined && JSON.stringify(current) !== JSON.stringify(entry.configuration))
            throw new StorageContinuityError();
          if (entry.configuration !== null) await target.table('spendingLimits').put(entry.configuration);
        } else if (
          entry.kind === 'debit' &&
          resolveRecoveryDebit(entry).initiatedAt >= Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS
        ) {
          const transaction = await target.table<ITransaction>('transactions').get(entry.id);
          if (transaction && (!transaction.restoredFromBackup || transaction.restoredFromJournal)) {
            const charge = recoveryDebit({ ...transaction, restoredFromBackup: false }, entry.accountId, 0);
            if (!charge || !matchesRecoveryDebit(entry, charge)) throw new StorageContinuityError();
          }
          const current: unknown = await target.table('recoveryDebits').get(entry.id);
          if (
            current !== undefined &&
            JSON.stringify(toSerializable(current)) !== JSON.stringify(toSerializable(resolveRecoveryDebit(entry)))
          )
            throw new StorageContinuityError();
          await target.table('recoveryDebits').put(resolveRecoveryDebit(entry));
        } else if (entry.kind === 'receipt') {
          const current = await target.table<ITransaction>('transactions').get(entry.id);
          if (current && !sameWalletAccountId(current.accountId, entry.accountId)) throw new StorageContinuityError();
          const critical = snapshot.entries.find(value => value.kind === 'transaction' && value.id === entry.id);
          if (
            current &&
            !sameRecoveryFields(current.extraInputs, entry.row.extraInputs) &&
            !(
              critical?.kind === 'transaction' &&
              critical.row &&
              sameRecoveryFields(current.extraInputs, critical.row.extraInputs)
            )
          )
            throw new StorageContinuityError();
          await target.table('transactions').put({
            ...(current ?? entry.row),
            extraInputs: current?.extraInputs ?? entry.row.extraInputs,
            amount: entry.row.amount,
            faucetId: entry.row.faucetId,
            restoredFromBackup: true,
            restoredFromJournal:
              (current?.restoredFromBackup && !current.restoredFromJournal) ||
              (entry.row.restoredFromBackup && !entry.row.restoredFromJournal)
                ? undefined
                : true
          });
        } else if (entry.kind === 'transaction') {
          if (!entry.row) throw new Error('Recovery transaction details unavailable');
          const current: ITransaction | undefined = await target.table<ITransaction>('transactions').get(entry.id);
          if (current && !sameWalletAccountId(current.accountId, entry.accountId)) throw new StorageContinuityError();
          if (current && (!current.restoredFromBackup || current.restoredFromJournal)) {
            const charge = recoveryDebit(
              { ...current, restoredFromBackup: false },
              entry.accountId,
              Math.floor(Date.now() / 1000)
            );
            const retained = snapshot.entries.find(item => item.kind === 'debit' && item.id === entry.id);
            if (charge && (retained?.kind !== 'debit' || !matchesRecoveryDebit(retained, charge)))
              throw new StorageContinuityError();
          }
          await target.table('transactions').put({
            ...(current ?? entry.row),
            requestBytes: current?.requestBytes ?? entry.requestBytes,
            mayHaveSubmitted: entry.mayHaveSubmitted,
            status: ITransactionStatus.Unconfirmed,
            restoredFromBackup: true,
            restoredFromJournal:
              (current?.restoredFromBackup && !current.restoredFromJournal) ||
              (entry.row.restoredFromBackup && !entry.row.restoredFromJournal)
                ? undefined
                : true
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
