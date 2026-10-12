import * as Repo from 'lib/miden/repo';

import {
  markAttemptPreSubmitEnd,
  pinGuardianCrossing,
  recordKeptCandidate,
  recordLeafEnd,
  recordSubmitCrossing,
  updateTransactionStatus
} from './helper';
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

describe('the Guardian pin and its retirement (#1081)', () => {
  it('pins the crossing per attempt and records that it raised the flag', async () => {
    await Repo.transactions.put(generating());
    await pinGuardianCrossing('tx-1', { attemptId: 'a1', fromExecute: true, guardianProposalNonce: 4 });
    const row = await read();
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.submitEvidence?.[0]).toMatchObject({
      source: 'pin',
      raisedFlag: true,
      guardianProposalNonce: 4,
      fromExecute: true
    });
  });

  it('retires the pin and clears only the flag the pin raised', async () => {
    await Repo.transactions.put(generating());
    await pinGuardianCrossing('tx-1', attempt);
    await markAttemptPreSubmitEnd('tx-1', 'a1');
    const row = await read();
    expect(row?.submitEvidence?.[0]?.preSubmitEnd).toBe(true);
    expect(row?.mayHaveSubmitted).toBeUndefined();
  });

  it('never clears a flag an earlier crossing raised', async () => {
    await Repo.transactions.put(generating({ mayHaveSubmitted: true }));
    await pinGuardianCrossing('tx-1', attempt);
    await markAttemptPreSubmitEnd('tx-1', 'a1');
    expect((await read())?.mayHaveSubmitted).toBe(true);
  });

  it('a late stamp may fill the retired entry but never clears its mark', async () => {
    await Repo.transactions.put(generating());
    await pinGuardianCrossing('tx-1', attempt);
    await markAttemptPreSubmitEnd('tx-1', 'a1');
    await recordSubmitCrossing('tx-1', { refBlock: 3 }, attempt);
    expect((await read())?.submitEvidence?.[0]).toMatchObject({ preSubmitEnd: true, refBlock: 3 });
  });

  it('records an evidence-less end for an offscreen failure that cannot prove it came first', async () => {
    await Repo.transactions.put(generating({ type: 'execute' }));
    await recordLeafEnd('tx-1', { attemptId: 'a1', fromExecute: true });
    expect((await read())?.submitEvidence).toEqual([
      { attemptId: 'a1', capturedAt: expect.any(Number), source: 'end', fromExecute: true }
    ]);
  });
});

describe('recordKeptCandidate (#1081)', () => {
  it('marks the entry of the attempt kept with its proposal nonce, creating it when the leaf left none', async () => {
    await Repo.transactions.put(generating());
    await recordKeptCandidate('tx-1', { attemptId: 'a1', fromExecute: false, guardianProposalNonce: 7 }, 'error-text');
    expect((await read())?.submitEvidence).toEqual([
      expect.objectContaining({ attemptId: 'a1', source: 'error-text', candidateKept: true, guardianProposalNonce: 7 })
    ]);
  });

  it('keeps the source and evidence of an existing pin entry', async () => {
    await Repo.transactions.put(generating());
    await pinGuardianCrossing('tx-1', { attemptId: 'a1', fromExecute: false, guardianProposalNonce: 7 });
    await recordKeptCandidate('tx-1', { attemptId: 'a1', fromExecute: false, guardianProposalNonce: 7 }, 'kill');
    expect((await read())?.submitEvidence).toEqual([
      expect.objectContaining({ source: 'pin', raisedFlag: true, candidateKept: true, guardianProposalNonce: 7 })
    ]);
  });

  it('never throws, since it runs in the catch of the leaf', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const where = jest.spyOn(Repo.transactions, 'where').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    await expect(
      recordKeptCandidate('tx-1', { attemptId: 'a1', fromExecute: false, guardianProposalNonce: 7 }, 'kill')
    ).resolves.toBeUndefined();
    where.mockRestore();
    warn.mockRestore();
  });
});
