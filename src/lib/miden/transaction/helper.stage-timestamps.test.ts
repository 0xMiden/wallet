/**
 * `updateTransactionStatus` must not let a forwarded row wipe the stage stamps
 * accumulated during the run (PR #524).
 *
 * `completeCustomTransaction` calls
 * `updateTransactionStatus(id, Completed, interpretTransactionResult(tx, result))`,
 * and `interpretTransactionResult` ends in `Object.assign(transaction, updates)` —
 * i.e. it hands back the whole row as picked at loop time. That snapshot predates
 * every `setTransactionStage` write of the run, so the blanket
 * `Object.assign(t, otherValues)` inside `updateTransactionStatus` can hand back a
 * STALER `stageTimestamps` than the one already on the row. The screen then renders
 * every step without a duration.
 *
 * It bites specifically once the row has been through a requeue: both
 * `requeueTransactionForRetry` and `requeueFailedTransaction` write
 * `stageTimestamps = undefined`, which makes the key PRESENT (structured clone
 * preserves an explicit `undefined` property), so a later `Object.assign` copies it
 * over live stamps. On a never-requeued row the key is simply absent and the assign
 * is a no-op — which is why this went unnoticed.
 *
 * The Queued direction must keep working the other way round: a requeue deliberately
 * passes `stageTimestamps: undefined` and that MUST win, or a retried attempt
 * inherits the previous attempt's boundaries (`setTransactionStage` is
 * first-entry-wins).
 */
import { updateTransactionStatus } from './helper';
import { ITransactionStatus } from '../db/types';

type Row = Record<string, unknown>;

const rows: Row[] = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((query: { id: string }) => ({
      first: jest.fn(async () => rows.find(r => r.id === query.id)),
      modify: jest.fn(async (fn: (row: Row) => void) => {
        const row = rows.find(r => r.id === query.id);
        if (row) fn(row);
      })
    }))
  }
}));

jest.mock('../sdk/miden-client', () => ({ getMidenClient: jest.fn() }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ TransactionResult: class {} }));
jest.mock('dexie', () => ({ liveQuery: jest.fn() }));

const seed = (row: Row) => {
  rows.length = 0;
  rows.push(row);
  return row;
};

describe('updateTransactionStatus — stage stamps survive a forwarded row', () => {
  it('keeps the run’s stamps when a Completed caller forwards a stale pick-time row', async () => {
    const row = seed({
      id: 'tx-1',
      status: ITransactionStatus.GeneratingTransaction,
      type: 'send',
      // Written by setTransactionStage DURING the run.
      stageTimestamps: { executing: 1_000, proving: 2_000, submitting: 3_000 }
    });

    // What completeCustomTransaction forwards: the row as picked at loop time,
    // whose stageTimestamps key exists but is stale (undefined after a requeue).
    await updateTransactionStatus('tx-1', ITransactionStatus.Completed, {
      stageTimestamps: undefined,
      transactionId: '0xabc'
    } as never);

    const stamps = row.stageTimestamps as Record<string, number>;
    expect(stamps.executing).toBe(1_000);
    expect(stamps.proving).toBe(2_000);
    expect(stamps.submitting).toBe(3_000);
    // ...plus the synthetic terminal boundary that closes the last step's span.
    expect(typeof stamps.complete).toBe('number');
  });

  it('still stamps a terminal boundary when the row carried no stamps at all', async () => {
    const row = seed({ id: 'tx-2', status: ITransactionStatus.GeneratingTransaction, type: 'send' });

    await updateTransactionStatus('tx-2', ITransactionStatus.Completed, { transactionId: '0xdef' } as never);

    expect(typeof (row.stageTimestamps as Record<string, number>).complete).toBe('number');
    expect(row.stage).toBe('complete');
  });

  it('lets a requeue clear the stamps — Queued is the one caller that means it', async () => {
    const row = seed({
      id: 'tx-3',
      status: ITransactionStatus.GeneratingTransaction,
      type: 'send',
      stageTimestamps: { executing: 1_000, proving: 2_000 }
    });

    await updateTransactionStatus('tx-3', ITransactionStatus.Queued, {
      stage: 'creating-proposal',
      stageTimestamps: undefined
    } as never);

    expect(row.stageTimestamps).toBeUndefined();
    expect(row.stage).toBe('creating-proposal');
  });
});
