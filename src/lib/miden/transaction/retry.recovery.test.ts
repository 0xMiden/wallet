import * as Repo from 'lib/miden/repo';

import { requeueFailedTransaction } from './retry';
import { ITransactionStatus, type ITransaction } from '../db/types';
import type { RecoveryDebitEntry } from '../recovery/types';
import { getStorageHealth, markStorageUnavailable, resetStorageHealthForLifecycle } from '../storage-health';

const mockCheckpoint = jest.fn<Promise<void>, [RecoveryDebitEntry]>();
jest.mock('../recovery/financial-writer', () => ({
  withFinancialRecoveryLock: (operation: () => Promise<unknown>) => operation(),
  verifyFinancialRecovery: async () => {},
  checkpointFinancialChange: (entry: RecoveryDebitEntry) => mockCheckpoint(entry)
}));
jest.mock('./cancel', () => ({ ...jest.requireActual('./cancel'), verifySendLanded: async () => 'unknown' }));

const row = (): ITransaction => ({
  id: 'recovery-retry',
  accountId: 'account-a',
  type: 'execute',
  status: ITransactionStatus.Failed,
  initiatedAt: 1,
  queuedSeq: 1,
  stage: 'executing',
  spentUsd: 7n,
  spendingLimitAuthorizationId: 'used',
  displayIcon: 'FAILED',
  requestBytes: new Uint8Array([1, 2])
});
beforeEach(() => {
  mockCheckpoint.mockReset().mockResolvedValue(undefined);
});

it('Task4C1 retry waits for independent candidate retention before the row becomes runnable', async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  mockCheckpoint.mockImplementationOnce(() => gate);
  await Repo.transactions.add(row());
  const retry = requeueFailedTransaction('recovery-retry');
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await Repo.transactions.get('recovery-retry'))?.status).toBe(ITransactionStatus.Failed);
  } finally {
    release();
    await retry;
  }
  expect((await Repo.transactions.get('recovery-retry'))?.status).toBe(ITransactionStatus.Queued);
});

it('Task4C1 retry retention refusal preserves the failed row and original submit evidence', async () => {
  const original = row();
  await Repo.transactions.add(original);
  mockCheckpoint.mockRejectedValueOnce(new Error('retention refused'));
  await expect(requeueFailedTransaction(original.id)).rejects.toThrow('retention refused');
  expect(await Repo.transactions.get(original.id)).toMatchObject(original);
});

it('Task4C1 retry retains the exact renewed timestamp amount grant and queue identity', async () => {
  await Repo.transactions.add(row());
  await requeueFailedTransaction('recovery-retry');
  const current = await Repo.transactions.get('recovery-retry');
  const retained = mockCheckpoint.mock.calls[0]?.[0];
  expect(retained?.initiatedAt).toBe(current?.initiatedAt);
  expect(retained?.spentUsd?.toString()).toBe('7');
  expect(retained?.authorizationId).toBe('used');
  expect(retained?.retry?.previous.initiatedAt).toBe(1);
  expect(retained?.retry?.queuedSeq).toBe(current?.queuedSeq);
});

it('Task4C1 retry refuses a late candidate after the storage epoch changes', async () => {
  await Repo.transactions.add(row());
  mockCheckpoint.mockImplementationOnce(async () => {
    markStorageUnavailable('journal', { backend: 'independent', operation: 'mutate' });
  });
  await expect(requeueFailedTransaction('recovery-retry')).rejects.toThrow();
  expect((await Repo.transactions.get('recovery-retry'))?.status).toBe(ITransactionStatus.Failed);
  await resetStorageHealthForLifecycle(getStorageHealth().epoch);
});

it('Task4C1 retry rejudges changed submit evidence before committing a new candidate', async () => {
  await Repo.transactions.add(row());
  const phases: number[] = [];
  mockCheckpoint
    .mockImplementationOnce(async () => {
      await Repo.transactions.update('recovery-retry', {
        submitEvidence: [{ attemptId: 'changed', capturedAt: 1, source: 'stage', preSubmitEnd: true }]
      });
    })
    .mockImplementationOnce(async () => {
      phases.push((await Repo.transactions.get('recovery-retry'))!.status);
    });
  await requeueFailedTransaction('recovery-retry');
  expect(phases).toEqual([ITransactionStatus.Failed]);
  expect((await Repo.transactions.get('recovery-retry'))?.submitEvidence).toEqual([
    { attemptId: 'changed', capturedAt: 1, source: 'stage', preSubmitEnd: true }
  ]);
});
