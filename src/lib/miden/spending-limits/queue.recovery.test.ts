import { SendTransaction } from '../db/types';
import { spendingLimits, transactions } from '../repo';
import { NoteTypeEnum } from '../types';
import { saveSpendingLimit } from './config';
import { queueOutgoingTransaction, spendsOf } from './queue';

const mockRetain = jest.fn<Promise<void>, [unknown]>();
jest.mock('../recovery/financial-writer', () => ({
  withFinancialRecoveryLock: (operation: () => Promise<unknown>) => operation(),
  checkpointFinancialChange: (change: unknown) => mockRetain(change),
  verifyFinancialRecovery: async () => {}
}));
jest.mock('./valuation', () => ({ resolveSpendsUsd: async () => 2n }));

it('persists a new charge independently before making the row runnable', async () => {
  let release: (() => void) | undefined;
  let began: (() => void) | undefined;
  const entered = new Promise<void>(resolve => {
    began = resolve;
  });
  mockRetain.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
        began?.();
      })
  );
  await spendingLimits.put({ accountId: 'account-a', limit: '10', revision: 'v1', createdAt: 1, updatedAt: 1 });
  const row = new SendTransaction('account-a', 1n, 'account-b', 'asset', NoteTypeEnum.Public);
  const queued = queueOutgoingTransaction(row, spendsOf(row));
  await Promise.race([queued, entered]);
  expect(await transactions.get(row.id)).toBeUndefined();
  expect(release).toBeDefined();
  release?.();
  await queued;
  expect(await transactions.get(row.id)).toMatchObject({ spentUsd: 2n });
});

it('retains the approved cap change before removing its persisted configuration', async () => {
  let release: (() => void) | undefined;
  let began: (() => void) | undefined;
  const entered = new Promise<void>(resolve => {
    began = resolve;
  });
  mockRetain.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
        began?.();
      })
  );
  await spendingLimits.put({ accountId: 'account-a', limit: '10', revision: 'v1', createdAt: 1, updatedAt: 1 });
  const saved = saveSpendingLimit({ accountId: 'account-a' }, { observedRevision: 'v1', strictlyAuthenticated: true });
  await Promise.race([saved, entered]);
  expect(await spendingLimits.get('account-a')).toMatchObject({ limit: '10' });
  expect(release).toBeDefined();
  release?.();
  await saved;
  expect(await spendingLimits.get('account-a')).toBeUndefined();
});
