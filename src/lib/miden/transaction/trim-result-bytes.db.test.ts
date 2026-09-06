/**
 * Database-level coverage for the reaper itself.
 *
 * The pure-predicate suite next door cannot see any of this: every assertion in it would still
 * pass with the dexie query, the bound and the delete removed entirely. These tests drive
 * `trimCompletedResultBytes` against fake-indexeddb, which is what the P0 stall needed.
 */
import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  __resetTrimThrottleForTests,
  RESULT_BYTES_RETENTION_MS,
  TRIM_BATCH_SIZE,
  trimCompletedResultBytes
} from './trim-result-bytes';

const AGED = Math.floor((Date.now() - RESULT_BYTES_RETENTION_MS) / 1000) - 3600;

const row = (i: number, over: Partial<ITransaction> = {}): ITransaction =>
  ({
    id: `tx-${String(i).padStart(5, '0')}`,
    type: 'send',
    accountId: 'acc',
    status: ITransactionStatus.Completed,
    // ascending, so row i is the i-th oldest and index order is deterministic
    completedAt: AGED + i,
    initiatedAt: AGED + i,
    resultBytes: new Uint8Array([1, 2, 3]),
    ...over
  }) as unknown as ITransaction;

const blobsLeft = async () => (await Repo.transactions.toArray()).filter(r => r.resultBytes).length;

const pass = async () => {
  __resetTrimThrottleForTests();
  return trimCompletedResultBytes();
};

beforeEach(async () => {
  await Repo.transactions.clear();
  __resetTrimThrottleForTests();
});

describe('trimCompletedResultBytes', () => {
  it('drains every eligible row across successive passes', async () => {
    // Fails before the fix: a bare `.limit()` re-selects the same oldest TRIM_BATCH_SIZE rows,
    // which are already trimmed after pass 1, so the last 50 blobs survive forever.
    const n = TRIM_BATCH_SIZE + 50;
    await Repo.transactions.bulkPut(Array.from({ length: n }, (_, i) => row(i)));
    expect(await blobsLeft()).toBe(n);

    await pass();
    await pass();

    expect(await blobsLeft()).toBe(0);
  });

  it('never trims more than TRIM_BATCH_SIZE rows in one pass', async () => {
    // Fails if the bound is removed rather than corrected: an unbounded sweep clears all of them
    // in one pass, holding a single write transaction across the whole store.
    const n = TRIM_BATCH_SIZE * 3;
    await Repo.transactions.bulkPut(Array.from({ length: n }, (_, i) => row(i)));

    const trimmed = await pass();

    expect(trimmed).toBe(TRIM_BATCH_SIZE);
    expect(await blobsLeft()).toBe(n - TRIM_BATCH_SIZE);
  });

  it('reaches an eligible row sitting behind a full batch of ineligible ones', async () => {
    // The starvation case in miniature: the oldest TRIM_BATCH_SIZE rows can never be trimmed, so
    // a range-counted bound never reaches the one row that can.
    const blockers = Array.from({ length: TRIM_BATCH_SIZE }, (_, i) => row(i, { resultBytes: undefined }));
    await Repo.transactions.bulkPut([...blockers, row(TRIM_BATCH_SIZE + 1)]);

    const trimmed = await pass();

    expect(trimmed).toBe(1);
    expect(await blobsLeft()).toBe(0);
  });

  it('reclaims a Failed row that kept its result bytes', async () => {
    // The replace-hot-key failure branch writes resultBytes while marking the row Failed, and
    // markBridgedSendFailed demotes a Completed Epoch row without clearing them. Both stamp
    // completedAt, so the index reaches them; a Completed-only predicate pinned them forever.
    await Repo.transactions.bulkPut([
      row(1, { status: ITransactionStatus.Failed, type: 'replace-hot-key', error: 'rotate failed' }),
      row(2, {
        status: ITransactionStatus.Failed,
        type: 'bridged-send',
        extraInputs: { provider: 'epoch' }
      } as Partial<ITransaction>)
    ]);

    expect(await pass()).toBe(2);
    expect(await blobsLeft()).toBe(0);
  });

  it('still spares a Completed epoch bridged-send, whose caller reads the result back', async () => {
    await Repo.transactions.bulkPut([
      row(1, { type: 'bridged-send', extraInputs: { provider: 'epoch' } } as Partial<ITransaction>)
    ]);

    expect(await pass()).toBe(0);
    expect(await blobsLeft()).toBe(1);
  });

  it('is throttled between passes', async () => {
    await Repo.transactions.bulkPut(Array.from({ length: 10 }, (_, i) => row(i)));

    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes()).toBe(10);
    // no reset: the immediate second call must not run a pass
    expect(await trimCompletedResultBytes()).toBe(0);
  });
});
