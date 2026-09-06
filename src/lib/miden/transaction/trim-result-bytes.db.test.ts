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
  trimCompletedResultBytes,
  WAIT_FOR_TX_TIMEOUT
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

  it('reclaims aged earn-deposit and epoch bridged-send rows too', async () => {
    // These were exempt on the theory that their callers consume the result after completion.
    // Both await waitForTransactionCompletion (which gives up after WAIT_FOR_TX_TIMEOUT, half the
    // retention window) and then re-read outputNoteIds, which this never touches — so the
    // exemption bought nothing and pinned ~237 KB per row forever.
    await Repo.transactions.bulkPut([
      row(1, { type: 'earn-deposit' }),
      row(2, { type: 'bridged-send', extraInputs: { provider: 'epoch' } } as Partial<ITransaction>)
    ]);

    expect(await pass()).toBe(2);
    expect(await blobsLeft()).toBe(0);
  });

  it('keeps the retention window longer than the awaiting caller\'s own timeout', () => {
    // The inequality is what lets the reaper delete resultBytes without racing that read. Against
    // the real exported constants, so shortening either one fails here.
    expect(RESULT_BYTES_RETENTION_MS).toBeGreaterThan(WAIT_FOR_TX_TIMEOUT);
  });

  it('drains rows that share one completedAt second', async () => {
    // Every other fixture here gives each row a distinct second (AGED + i), which production does
    // not guarantee: completion writers stamp whole seconds, so ties are normal. A selection that
    // resumed by timestamp would either skip the rest of an oversized equal-second bucket or
    // re-read it forever; this pins that the pass drains a tie group.
    const tied = Array.from({ length: TRIM_BATCH_SIZE + 20 }, (_, i) => ({
      ...(row(i) as unknown as Record<string, unknown>),
      completedAt: AGED
    })) as unknown as ITransaction[];
    await Repo.transactions.bulkPut(tied);

    await pass();
    await pass();

    expect(await blobsLeft()).toBe(0);
  });

  it('spares a row still inside the retention window', async () => {
    const recent = Math.floor(Date.now() / 1000) - 30;
    await Repo.transactions.bulkPut([row(1, { completedAt: recent, initiatedAt: recent })]);

    expect(await pass()).toBe(0);
    expect(await blobsLeft()).toBe(1);
  });

  it('ignores rows that are not terminal, and rows already trimmed', async () => {
    await Repo.transactions.bulkPut([
      row(1, { status: ITransactionStatus.Queued }),
      row(2, { status: ITransactionStatus.GeneratingTransaction }),
      row(3, { resultBytes: undefined })
    ]);

    expect(await pass()).toBe(0);
  });

  it('treats the cutoff second as outside the window, matching the query exactly', async () => {
    // The predicate and the dexie range are one rule. `.below()` is upper-open, so a row stamped
    // at precisely the cutoff second must NOT be trimmed; one second older must be.
    const now = Date.now();
    const cutoff = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);
    await Repo.transactions.bulkPut([
      row(1, { id: 'at-cutoff', completedAt: cutoff } as Partial<ITransaction>),
      row(2, { id: 'one-older', completedAt: cutoff - 1 } as Partial<ITransaction>)
    ]);

    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes(now)).toBe(1);
    expect((await Repo.transactions.get('at-cutoff'))?.resultBytes).toBeDefined();
    expect((await Repo.transactions.get('one-older'))?.resultBytes).toBeUndefined();
  });

  it('is throttled between passes', async () => {
    // Asserted under a load the UNGATED path has NOT already exhausted: with TRIM_BATCH_SIZE+50
    // rows the first pass leaves 50 behind, so an un-throttled second pass would take them and
    // both assertions would fail. The previous shape seeded 10 rows, which the first pass drained
    // completely — after which a second pass returns 0 whether or not the throttle exists.
    // Asserting store state as well as the return value matters for the same reason: 0 is also
    // what "nothing left to do" looks like.
    const n = TRIM_BATCH_SIZE + 50;
    await Repo.transactions.bulkPut(Array.from({ length: n }, (_, i) => row(i)));

    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes()).toBe(TRIM_BATCH_SIZE);

    // no reset: the immediate second call must not run a pass
    expect(await trimCompletedResultBytes()).toBe(0);
    expect(await blobsLeft()).toBe(50);
  });
});

describe('trimCompletedResultBytes throttle and single-flight', () => {
  it('coalesces two overlapping callers onto one pass', async () => {
    // Not merely "the second returns 0": that is what a serialising throttle does. Both callers
    // must see the SAME pass, so both observe its count.
    await Repo.transactions.bulkPut(Array.from({ length: 10 }, (_, i) => row(i)));
    __resetTrimThrottleForTests();

    const [a, b] = await Promise.all([trimCompletedResultBytes(), trimCompletedResultBytes()]);

    expect([a, b]).toEqual([10, 10]);
    expect(await blobsLeft()).toBe(0);
  });

  it('does not burn the window when a pass fails', async () => {
    await Repo.transactions.bulkPut(Array.from({ length: 5 }, (_, i) => row(i)));
    __resetTrimThrottleForTests();
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementationOnce(() => {
      throw new Error('indexeddb unavailable');
    });

    await expect(trimCompletedResultBytes()).rejects.toThrow('indexeddb unavailable');
    spy.mockRestore();

    // No reset: a pre-stamped throttle would swallow this retry and return 0.
    expect(await trimCompletedResultBytes()).toBe(5);
  });
});
