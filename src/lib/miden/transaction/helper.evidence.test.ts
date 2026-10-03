import * as Repo from 'lib/miden/repo';

import { recordSubmitCrossing, updateTransactionStatus } from './helper';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const attempt = { attemptId: 'a1', fromExecute: false };

const generating = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'acct',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 1000,
  processingStartedAt: 1100,
  attemptId: 'a1',
  displayIcon: 'SEND',
  ...overrides
});

const read = () => Repo.transactions.where({ id: 'tx-1' }).first();

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('recordSubmitCrossing (#1081)', () => {
  it('sets mayHaveSubmitted and records the attempt with its evidence', async () => {
    await Repo.transactions.put(generating());
    await recordSubmitCrossing(
      'tx-1',
      { transactionId: hex(1), refBlock: 10 },
      { ...attempt, guardianProposalNonce: 3 }
    );
    const row = await read();
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({
        attemptId: 'a1',
        source: 'stage',
        transactionId: hex(1),
        refBlock: 10,
        guardianProposalNonce: 3
      })
    ]);
    expect(row?.submitEvidence?.[0]?.fromExecute).toBeUndefined();
  });

  it('records through a terminal row, because a cancel does not stop the pipeline', async () => {
    await Repo.transactions.put(generating({ status: ITransactionStatus.Failed }));
    await recordSubmitCrossing('tx-1', undefined, attempt);
    const row = await read();
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.submitEvidence).toHaveLength(1);
  });

  it('marks the execute origin the stamp was created with, whatever the row says now', async () => {
    await Repo.transactions.put(generating({ type: 'send', status: ITransactionStatus.Completed }));
    await recordSubmitCrossing('tx-1', undefined, { attemptId: 'a1', fromExecute: true });
    expect((await read())?.submitEvidence?.[0]?.fromExecute).toBe(true);
  });
});

describe('updateTransactionStatus keeps the live evidence (#1081)', () => {
  it('a completion that hands over the pick-time row does not replace newer evidence or the safe marker', async () => {
    // The pick-time row carries both keys, so the completion's assign really does write over them.
    const olderAttempt: ISubmitEvidence = { attemptId: 'a0', capturedAt: 900, source: 'stage' };
    const picked = generating({ submitEvidence: [olderAttempt], neverCommittedAt: undefined });
    await Repo.transactions.put({ ...picked, neverCommittedAt: 5 });
    await recordSubmitCrossing('tx-1', { transactionId: hex(1) }, attempt);
    await updateTransactionStatus('tx-1', ITransactionStatus.Completed, { ...picked, displayMessage: 'Sent' });
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.submitEvidence).toEqual([
      olderAttempt,
      expect.objectContaining({ attemptId: 'a1', transactionId: hex(1) })
    ]);
    expect(row?.neverCommittedAt).toBe(5);
  });
});
