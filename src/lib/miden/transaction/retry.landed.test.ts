/**
 * Retry's "already landed" reconcile, against the REAL Dexie row store and the
 * REAL `updateTransactionStatus`.
 *
 * The sibling `retry.test.ts` `jest.mock`s `./helper`, which is precisely why the
 * defect this file pins was invisible: `updateTransactionStatus` refuses to touch
 * a row that is already Failed or Completed, and `requeueFailedTransaction` only
 * ever runs on a Failed row — so routing the reconcile through it threw
 * `Transaction already in a finalized state` on every execution, the Retry button
 * surfaced "Something went wrong", and a send that HAD left the account stayed
 * Failed forever. Only `./cancel` is mocked here (to control the node verdict).
 */
/* eslint-disable import/first */
import * as Repo from 'lib/miden/repo';

const mockVerifySendLanded = jest.fn();
jest.mock('./cancel', () => ({
  verifySendLanded: (...args: unknown[]) => mockVerifySendLanded(...args)
}));

// Imported after the mock declaration; `jest.mock` is hoisted, so the real module
// graph below (`./helper`, `lib/miden/repo`) is untouched.
import { TRANSACTION_RETRY_UNSAFE_ERROR } from './constants';
import { updateTransactionStatus } from './helper';
import { requeueFailedTransaction } from './retry';
import { ITransaction, ITransactionStatus } from '../db/types';

const failedSend = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-landed',
  type: 'send',
  accountId: 'acct-1',
  status: ITransactionStatus.Failed,
  initiatedAt: 1000,
  processingStartedAt: 1100,
  transactionId: '0xlanded',
  error: 'extractFullNote returned undefined',
  rawError: 'Error: extractFullNote returned undefined',
  displayMessage: 'Failed',
  displayIcon: 'FAILED',
  ...overrides
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

afterAll(async () => {
  await Repo.transactions.clear();
});

describe('requeueFailedTransaction — landed reconcile against the real row store', () => {
  it('completes a Failed row whose send provably landed, without throwing', async () => {
    await Repo.transactions.put(failedSend());
    mockVerifySendLanded.mockResolvedValue('landed');

    await expect(requeueFailedTransaction('tx-landed')).resolves.toBeUndefined();

    const row = await Repo.transactions.where({ id: 'tx-landed' }).first();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.displayMessage).toBe('Completed');
    expect(row?.completedAt).toEqual(expect.any(Number));
    // The stale failure text must not survive onto a Completed row.
    expect(row?.error).toBeUndefined();
    expect(row?.rawError).toBeUndefined();
  });

  it('refuses, and leaves the real row Failed, when the node cannot confirm the send landed', async () => {
    // 'unknown' is "we could not confirm", not "it did not land": the node may
    // simply not have this id yet. Replaying a rebuilt send request on that would
    // broadcast a second transfer.
    await Repo.transactions.put(failedSend({ id: 'tx-unknown' }));
    mockVerifySendLanded.mockResolvedValue('unknown');

    await expect(requeueFailedTransaction('tx-unknown')).rejects.toThrow(TRANSACTION_RETRY_UNSAFE_ERROR);

    const row = await Repo.transactions.where({ id: 'tx-unknown' }).first();
    expect(row?.status).toBe(ITransactionStatus.Failed);
  });

  it('requeues a send that never left the queue', async () => {
    // No `processingStartedAt` → the row never executed, so nothing could have
    // been submitted and the rebuilt request is safe to replay.
    await Repo.transactions.put(failedSend({ id: 'tx-queued', processingStartedAt: undefined }));
    mockVerifySendLanded.mockResolvedValue('unknown');

    await requeueFailedTransaction('tx-queued');

    const row = await Repo.transactions.where({ id: 'tx-queued' }).first();
    expect(row?.status).toBe(ITransactionStatus.Queued);
  });

  it('documents WHY the reconcile cannot go through updateTransactionStatus', async () => {
    await Repo.transactions.put(failedSend({ id: 'tx-guarded' }));

    await expect(
      updateTransactionStatus('tx-guarded', ITransactionStatus.Completed, { displayMessage: 'Completed' })
    ).rejects.toThrow('Transaction already in a finalized state');
  });
});
