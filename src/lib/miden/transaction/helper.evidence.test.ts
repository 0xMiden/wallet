import * as Repo from 'lib/miden/repo';

import {
  markAttemptPreSubmitEnd,
  pinGuardianCrossing,
  recordKeptCandidate,
  recordLeafEnd,
  recordSubmitCrossing,
  retractSubmitCrossing,
  setTransactionStage,
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
        raisedFlag: true,
        transactionId: hex(1),
        refBlock: 10,
        guardianProposalNonce: 3
      })
    ]);
    expect(row?.submitEvidence?.[0]?.fromExecute).toBeUndefined();
  });

  it('does not claim ownership of a crossing raised by an earlier attempt', async () => {
    await Repo.transactions.put(generating({ mayHaveSubmitted: true }));
    await recordSubmitCrossing('tx-1', undefined, attempt);
    expect((await read())?.submitEvidence?.[0]?.raisedFlag).toBeUndefined();
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

describe('retractSubmitCrossing (#2325)', () => {
  it('removes a stage entry, clears raised mayHaveSubmitted, reverts stage, and drops submitting timestamp', async () => {
    await Repo.transactions.put(generating({ stage: 'proving', stageTimestamps: { proving: 100 } }));
    await recordSubmitCrossing('tx-1', { transactionId: hex(1), refBlock: 10, expirationBlock: 30 }, attempt);
    await setTransactionStage('tx-1', 'submitting');

    await retractSubmitCrossing('tx-1', 'a1', 'proving');

    const row = await read();
    expect(row?.mayHaveSubmitted).toBeUndefined();
    expect(row?.submitEvidence).toBeUndefined();
    expect(row?.stage).toBe('proving');
    expect(row?.stageTimestamps).toEqual({ proving: 100 });
  });

  it('strips proof fields from a pin entry while preserving pin metadata and preSubmitEnd', async () => {
    await Repo.transactions.put(generating({ stage: 'sending' }));
    await pinGuardianCrossing('tx-1', { attemptId: 'a1', fromExecute: false, guardianProposalNonce: 4 });
    await recordSubmitCrossing('tx-1', { transactionId: hex(1), refBlock: 10, expirationBlock: 30 }, attempt);
    await setTransactionStage('tx-1', 'submitting');
    await markAttemptPreSubmitEnd('tx-1', 'a1');

    await retractSubmitCrossing('tx-1', 'a1', 'sending');

    const row = await read();
    expect(row?.mayHaveSubmitted).toBeUndefined();
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({
        attemptId: 'a1',
        source: 'pin',
        raisedFlag: true,
        guardianProposalNonce: 4,
        preSubmitEnd: true
      })
    ]);
    expect(row?.submitEvidence?.[0]?.transactionId).toBeUndefined();
    expect(row?.stage).toBe('sending');
  });

  it('does not revert stage or timestamps belonging to a newer attemptId', async () => {
    await Repo.transactions.put(
      generating({
        attemptId: 'a2',
        stage: 'submitting',
        stageTimestamps: { submitting: 200 },
        submitEvidence: [{ attemptId: 'a1', capturedAt: 100, source: 'stage', transactionId: hex(1) }]
      })
    );

    await retractSubmitCrossing('tx-1', 'a1', 'proving');

    const row = await read();
    expect(row?.stage).toBe('submitting');
    expect(row?.stageTimestamps).toEqual({ submitting: 200 });
    expect(row?.submitEvidence).toBeUndefined();
  });

  it('preserves preSubmitEnd on a stage entry while stripping proof fields and reverting stage (#2325)', async () => {
    await Repo.transactions.put(generating({ stage: 'proving', stageTimestamps: { proving: 100 } }));
    await recordSubmitCrossing('tx-1', { transactionId: hex(1), refBlock: 10, expirationBlock: 30 }, attempt);
    await setTransactionStage('tx-1', 'submitting');
    await markAttemptPreSubmitEnd('tx-1', 'a1');

    await retractSubmitCrossing('tx-1', 'a1', 'proving');

    const row = await read();
    expect(row?.mayHaveSubmitted).toBeUndefined();
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({
        attemptId: 'a1',
        source: 'stage',
        raisedFlag: true,
        preSubmitEnd: true
      })
    ]);
    expect(row?.submitEvidence?.[0]?.transactionId).toBeUndefined();
    expect(row?.submitEvidence?.[0]?.refBlock).toBeUndefined();
    expect(row?.stage).toBe('proving');
    expect(row?.stageTimestamps).toEqual({ proving: 100 });

    await Repo.transactions.put(
      generating({
        stage: 'submitting',
        mayHaveSubmitted: true,
        submitEvidence: [
          {
            attemptId: 'a1',
            capturedAt: 100,
            source: 'stage',
            raisedFlag: true,
            preSubmitEnd: true,
            transactionId: hex(1)
          }
        ]
      })
    );
    await retractSubmitCrossing('tx-1', 'a1', 'proving');
    const cleared = await read();
    expect(cleared?.mayHaveSubmitted).toBeUndefined();
    expect(cleared?.stage).toBe('proving');
    expect(cleared?.submitEvidence).toEqual([
      expect.objectContaining({ attemptId: 'a1', source: 'stage', raisedFlag: true, preSubmitEnd: true })
    ]);
  });

  it('does not clear mayHaveSubmitted or revert stage when attemptId mismatches or is undefined at runtime (#2325)', async () => {
    await Repo.transactions.put(
      generating({
        attemptId: 'a2',
        stage: 'submitting',
        mayHaveSubmitted: true,
        stageTimestamps: { submitting: 200 },
        submitEvidence: [{ attemptId: 'a2', capturedAt: 100, source: 'stage', raisedFlag: true, transactionId: hex(2) }]
      })
    );

    await retractSubmitCrossing('tx-1', 'a1', 'proving');
    expect((await read())?.mayHaveSubmitted).toBe(true);
    expect((await read())?.stage).toBe('submitting');

    await retractSubmitCrossing('tx-1', undefined as unknown as string, 'proving');

    const requireAttemptId: (attempt: Parameters<typeof retractSubmitCrossing>[1]) => string = attempt => attempt;
    expect(requireAttemptId('a1')).toBe('a1');

    const row = await read();
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.stage).toBe('submitting');
    expect(row?.stageTimestamps).toEqual({ submitting: 200 });
    expect(row?.submitEvidence).toHaveLength(1);
  });

  it('preserves mayHaveSubmitted when markAttemptPreSubmitEnd or retractSubmitCrossing runs for a stale or non-sole attemptId (#2325)', async () => {
    for (const staleAttemptId of [undefined, 'a2'] as const) {
      await Repo.transactions.clear();
      await Repo.transactions.put(
        generating({
          attemptId: staleAttemptId,
          stage: 'proving',
          mayHaveSubmitted: true,
          submitEvidence: [
            { attemptId: 'a1', capturedAt: 100, source: 'stage', raisedFlag: true, transactionId: hex(1) }
          ]
        })
      );
      await markAttemptPreSubmitEnd('tx-1', 'a1');
      let row = await read();
      expect(row?.mayHaveSubmitted).toBe(true);
      expect(row?.submitEvidence?.[0]?.preSubmitEnd).toBe(true);

      await retractSubmitCrossing('tx-1', 'a1', 'proving');
      row = await read();
      expect(row?.mayHaveSubmitted).toBe(true);
      expect(row?.submitEvidence?.[0]?.preSubmitEnd).toBe(true);

      await Repo.transactions.clear();
      await Repo.transactions.put(
        generating({
          attemptId: staleAttemptId,
          stage: 'proving',
          mayHaveSubmitted: true,
          submitEvidence: [
            { attemptId: 'a1', capturedAt: 100, source: 'stage', raisedFlag: true, transactionId: hex(2) }
          ]
        })
      );
      await retractSubmitCrossing('tx-1', 'a1', 'proving');
      row = await read();
      expect(row?.mayHaveSubmitted).toBe(true);
      expect(row?.submitEvidence).toBeUndefined();
    }

    await Repo.transactions.clear();
    await Repo.transactions.put(
      generating({
        attemptId: 'a1',
        stage: 'submitting',
        mayHaveSubmitted: true,
        submitEvidence: [
          { attemptId: 'a0', capturedAt: 90, source: 'stage', raisedFlag: true, transactionId: hex(3) },
          { attemptId: 'a1', capturedAt: 100, source: 'stage', raisedFlag: true, transactionId: hex(4) }
        ]
      })
    );
    await markAttemptPreSubmitEnd('tx-1', 'a1');
    expect((await read())?.mayHaveSubmitted).toBe(true);

    await retractSubmitCrossing('tx-1', 'a1', 'proving');
    expect((await read())?.mayHaveSubmitted).toBe(true);

    await markAttemptPreSubmitEnd('tx-1', 'a0');
    expect((await read())?.mayHaveSubmitted).toBe(true);

    await Repo.transactions.clear();
    await Repo.transactions.put(
      generating({
        attemptId: 'a1',
        stage: 'proving',
        mayHaveSubmitted: true,
        submitEvidence: [
          {
            attemptId: 'a0',
            capturedAt: 90,
            source: 'stage',
            raisedFlag: true,
            preSubmitEnd: true,
            transactionId: hex(5)
          },
          { attemptId: 'a1', capturedAt: 100, source: 'stage', raisedFlag: true, transactionId: hex(6) }
        ]
      })
    );
    await markAttemptPreSubmitEnd('tx-1', 'a1');
    expect((await read())?.mayHaveSubmitted).toBeUndefined();

    // Another entry without raisedFlag (e.g., an evidence-less 'end' row) does not block clearing.
    await Repo.transactions.clear();
    await Repo.transactions.put(
      generating({
        attemptId: 'a1',
        stage: 'proving',
        mayHaveSubmitted: true,
        submitEvidence: [
          { attemptId: 'a0', capturedAt: 90, source: 'end' },
          { attemptId: 'a1', capturedAt: 100, source: 'stage', raisedFlag: true, transactionId: hex(8) }
        ]
      })
    );
    await markAttemptPreSubmitEnd('tx-1', 'a1');
    expect((await read())?.mayHaveSubmitted).toBeUndefined();
  });

  it('keeps mayHaveSubmitted true when retractSubmitCrossing runs on an unretired pin entry (#2325)', async () => {
    await Repo.transactions.put(generating({ attemptId: 'a1', stage: 'proving' }));
    await pinGuardianCrossing('tx-1', attempt);
    await recordSubmitCrossing('tx-1', { refBlock: 3 }, attempt);
    await setTransactionStage('tx-1', 'submitting');

    await retractSubmitCrossing('tx-1', 'a1', 'proving');
    const row = await read();
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.stage).toBe('proving');
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({ attemptId: 'a1', source: 'pin', raisedFlag: true })
    ]);
    expect(row?.submitEvidence?.[0]?.preSubmitEnd).toBeUndefined();
  });
});
