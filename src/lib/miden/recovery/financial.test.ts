import { readFinancialRecoveryBaseline, historyWithRecoveryDebits, recoveryDebit } from './financial';
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
