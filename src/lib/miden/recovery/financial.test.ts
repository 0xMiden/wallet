import {
  readFinancialRecoveryBaseline,
  historyWithRecoveryDebits,
  recoveryDebit,
  readRetainedFinancialEntries,
  verifyFinancialRecoveryEntries
} from './financial';
import { verifyRetainedTransactionRows } from './transaction-continuity';
import { projectRecoveryTransaction } from './transaction-record';
import type { RecoveryEntry } from './types';
import { ITransaction, ITransactionStatus } from '../db/types';
import * as Repo from '../repo';

const now = 100000;
function row(id: string, extra: Partial<ITransaction> = {}): ITransaction {
  return {
    id,
    accountId: 'account-a',
    type: 'send',
    status: ITransactionStatus.Failed,
    initiatedAt: now,
    displayIcon: 'FAILED',
    ...extra
  };
}

it('retains the small financial baseline amid a large unrelated public history', async () => {
  await Repo.transactions.bulkAdd(Array.from({ length: 1000 }, (_, i) => row(`public-${i}`)));
  await Repo.transactions.add(row('charged', { spentUsd: 7n, neverCommittedAt: now }));
  expect(await readFinancialRecoveryBaseline(['account-a'], now)).toEqual([
    { kind: 'policy', id: 'account-a', accountId: 'account-a', configuration: null },
    { kind: 'debit', id: 'charged', accountId: 'account-a', initiatedAt: now, spentUsd: 7n }
  ]);
});

it('indexes a grant-only failed row and retains future timestamps unchanged', async () => {
  await Repo.transactions.add(row('grant', { spendingLimitAuthorizationId: 'used-grant', initiatedAt: now + 100000 }));
  expect(await readFinancialRecoveryBaseline(['account-a'], now)).toContainEqual({
    kind: 'debit',
    id: 'grant',
    accountId: 'account-a',
    initiatedAt: now + 100000,
    authorizationId: 'used-grant'
  });
});

it('refuses a financial set beyond the retained-entry bound', async () => {
  await Repo.transactions.bulkAdd(Array.from({ length: 256 }, (_, i) => row(`charge-${i}`, { spentUsd: 1n })));
  await expect(readFinancialRecoveryBaseline(['account-a'], now)).rejects.toThrow('Storage continuity unavailable');
});

it('keeps restored debits charged once while their transaction stays an inert archive', async () => {
  await Repo.recoveryDebits.put({
    kind: 'debit',
    id: 'restored',
    accountId: 'account-a',
    initiatedAt: now,
    spentUsd: 9n,
    authorizationId: 'consumed'
  });
  const history = await historyWithRecoveryDebits([row('restored', { restoredFromBackup: true, spentUsd: 9n })], now);
  expect(history).toHaveLength(1);
  expect(recoveryDebit(history[0]!, 'account-a', now)).toMatchObject({ spentUsd: 9n, authorizationId: 'consumed' });
});

it('removes the derived debit index when a row becomes an external archive', async () => {
  await Repo.transactions.add(row('changed', { spentUsd: 9n }));
  await Repo.transactions.update('changed', { restoredFromBackup: true });
  expect(await readFinancialRecoveryBaseline(['account-a'], now)).toHaveLength(1);
});

it('keeps the debit at the exact rolling-window boundary', async () => {
  await Repo.transactions.add(row('boundary', { initiatedAt: now - 86400, spentUsd: 3n }));
  expect(await readFinancialRecoveryBaseline(['account-a'], now)).toContainEqual({
    kind: 'debit',
    id: 'boundary',
    accountId: 'account-a',
    initiatedAt: now - 86400,
    spentUsd: 3n
  });
});

it('Task4C1 financial and critical continuity accept the exact old and acknowledged retry rows', async () => {
  const old = row('transition', {
    initiatedAt: now - 90000,
    spentUsd: 7n,
    spendingLimitAuthorizationId: 'used',
    mayHaveSubmitted: true,
    attemptId: 'old',
    requestBytes: new Uint8Array([1]),
    submitEvidence: [
      { attemptId: 'old', capturedAt: 1, source: 'stage', transactionId: 'transaction', preSubmitEnd: true }
    ]
  });
  await Repo.transactions.add(old);
  const entries: RecoveryEntry[] = [
    {
      kind: 'debit',
      id: old.id,
      accountId: old.accountId,
      initiatedAt: now,
      spentUsd: 7n,
      authorizationId: 'used',
      retry: { previous: { initiatedAt: old.initiatedAt, spentUsd: 7n, authorizationId: 'used' }, queuedSeq: 9 }
    },
    {
      kind: 'transaction',
      id: old.id,
      accountId: old.accountId,
      requestBytes: new Uint8Array([1]),
      mayHaveSubmitted: true,
      evidence: {},
      row: projectRecoveryTransaction(old)
    }
  ];
  const verify = async () => {
    verifyFinancialRecoveryEntries(entries, await readRetainedFinancialEntries(entries, now), now);
    await verifyRetainedTransactionRows(entries);
  };
  await expect(verify()).resolves.toBeUndefined();
  await Repo.transactions.update(old.id, {
    initiatedAt: now,
    queuedSeq: 9,
    status: ITransactionStatus.Queued,
    attemptId: undefined,
    mayHaveSubmitted: undefined
  });
  await expect(verify()).resolves.toBeUndefined();
  await Repo.transactions.update(old.id, { spentUsd: 8n });
  await expect(verify()).rejects.toThrow();
});

it('Task4C1 retained financial reads reject a same-id row belonging to a different account', async () => {
  await Repo.transactions.add(row('foreign-row', { accountId: 'another-account', spentUsd: 7n }));
  const entries: RecoveryEntry[] = [
    {
      kind: 'debit',
      id: 'foreign-row',
      accountId: 'account-a',
      initiatedAt: now,
      spentUsd: 7n
    }
  ];
  await expect(readRetainedFinancialEntries(entries, now)).rejects.toMatchObject({ name: 'StorageContinuityError' });
});
