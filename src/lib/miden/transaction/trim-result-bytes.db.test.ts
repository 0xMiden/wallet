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
  TRIM_FAILURE_RETRY_MS,
  TRIM_MIN_INTERVAL_MS,
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

  it("keeps the retention window longer than the awaiting caller's own timeout", () => {
    // A design margin, not a correctness condition: the timeout bounds how long one wait may LAST,
    // never when the blob is read (the waiter reads on its first Completed emission). Pinned
    // against the real exported constants so shrinking either one has to be deliberate.
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
    // Pins the COMPOSED selector's effective cutoff — and only that. Making the query inclusive
    // alone leaves this green (the predicate still declines), and making the predicate inclusive
    // alone leaves it green too (the query never selects the row); only changing both fails. So
    // this cannot claim to protect the agreement between the two, and neither half alone is
    // observable — which is also why the drift it was written for was harmless.
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

  it('clears the blob only once a row ages past the window, leaving the row itself intact', async () => {
    // Storage only, and named for it. Driving the real `waitForTransactionCompletion` here would
    // need TransactionResult.deserialize stubbed (jest maps the SDK to a mock without it),
    // splitExecutedOutputNotes mocked, a transactionId on the fixture and a dexie liveQuery mock —
    // and deleting that helper's missing-bytes arm would STILL degrade via its catch. Its coverage
    // lives in transactions.branches.test.ts. What this pins is the window's effect on the store.
    //
    // The row assertion is load-bearing: `?.resultBytes === undefined` is equally true of a row
    // that was DELETED, so without it a regression that wiped history would pass.
    const now = Date.now();
    const inWindow = Math.floor((now - RESULT_BYTES_RETENTION_MS / 2) / 1000);
    await Repo.transactions.bulkPut([row(1, { id: 'fresh', completedAt: inWindow } as Partial<ITransaction>)]);

    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes(now)).toBe(0);
    expect((await Repo.transactions.get('fresh'))?.resultBytes).toBeDefined();

    // ...and once it ages past the window, the blob is gone and the wait can only degrade.
    const later = now + RESULT_BYTES_RETENTION_MS;
    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes(later)).toBe(1);
    const trimmedRow = await Repo.transactions.get('fresh');
    expect(trimmedRow).toBeDefined();
    expect(trimmedRow?.resultBytes).toBeUndefined();
    // `delete`, not an assigned undefined: both release the blob, and this pins the stored shape.
    expect('resultBytes' in trimmedRow!).toBe(false);
  });

  it('never trims a row that carries no completedAt', async () => {
    // Pins the INDEX behaviour the module relies on — IndexedDB omits records whose index key is
    // undefined, so the query never reaches this row. It does not pin the predicate's lack of an
    // `?? initiatedAt` fallback: restoring that fallback leaves this green, because the row never
    // reaches the predicate either way. That is why deleting the fallback was safe, and it is the
    // most this test can honestly claim.
    await Repo.transactions.bulkPut([
      row(1, { id: 'no-ts', completedAt: undefined, initiatedAt: AGED } as Partial<ITransaction>)
    ]);

    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes()).toBe(0);
    expect((await Repo.transactions.get('no-ts'))?.resultBytes).toBeDefined();
  });

  it('throttles only after the range is exhausted', async () => {
    // A SHORT pass means nothing is left, so the floor applies. Asserted under a load the ungated
    // path has not already drained — without the throttle the second call would take the other 50.
    const n = TRIM_BATCH_SIZE + 50;
    await Repo.transactions.bulkPut(Array.from({ length: n }, (_, i) => row(i)));
    const t0 = Date.now();

    __resetTrimThrottleForTests();
    expect(await trimCompletedResultBytes(t0)).toBe(TRIM_BATCH_SIZE); // full batch: no stamp
    expect(await trimCompletedResultBytes(t0)).toBe(50); // continues at the SAME now
    expect(await blobsLeft()).toBe(0);

    // A fresh eligible row, so a third call returning 0 means THROTTLED rather than "nothing left"
    // — the distinction the previous version of this test could not make.
    await Repo.transactions.bulkPut([row(1, { id: 'late-arrival', completedAt: AGED } as Partial<ITransaction>)]);
    expect(await trimCompletedResultBytes(t0)).toBe(0);
    expect(await blobsLeft()).toBe(1);

    // ...and the floor lifts exactly at the interval.
    expect(await trimCompletedResultBytes(t0 + TRIM_MIN_INTERVAL_MS)).toBe(1);
  });

  it('does not park a backlog behind the interval after a full batch', async () => {
    // The drain rate is the point: stamping after a full batch made a 456-row backlog take one
    // batch per five minutes.
    await Repo.transactions.bulkPut(Array.from({ length: TRIM_BATCH_SIZE + 10 }, (_, i) => row(i)));
    const t0 = Date.now();

    __resetTrimThrottleForTests();
    await trimCompletedResultBytes(t0);

    expect(await trimCompletedResultBytes(t0)).toBe(10);
  });

  it('coalesces two overlapping callers onto one pass', async () => {
    // Both drivers fire and forget, so on the extension the miden-sync alarm and the popup's 3s
    // SyncRequest can overlap. Asserting the SECOND CALL'S COUNT is what discriminates: blobsLeft
    // reaches 0 with or without coalescing, so a store assertion cannot see the mutant.
    await Repo.transactions.bulkPut(Array.from({ length: 10 }, (_, i) => row(i)));
    __resetTrimThrottleForTests();

    const [a, b] = await Promise.all([trimCompletedResultBytes(), trimCompletedResultBytes()]);

    expect([a, b]).toEqual([10, 10]);
  });

  it('hands the failure to a caller that adopted the in-flight pass', async () => {
    // The adopting caller must see the rejection, not a silently resolved 0 — otherwise a failing
    // store looks healthy to whichever driver arrived second, which is the population this module
    // targets.
    await Repo.transactions.bulkPut(Array.from({ length: 5 }, (_, i) => row(i)));
    __resetTrimThrottleForTests();
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('indexeddb unavailable');
    });

    const first = trimCompletedResultBytes();
    const second = trimCompletedResultBytes();

    await expect(first).rejects.toThrow('indexeddb unavailable');
    await expect(second).rejects.toThrow('indexeddb unavailable');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('backs a failed pass off for the retry floor, not for the full interval', async () => {
    // The failure must be PERSISTENT: with a single throw the retry succeeds on a short pass, and
    // that success stamps the ordinary floor — which passes even with no failure throttle at all.
    await Repo.transactions.bulkPut(Array.from({ length: 5 }, (_, i) => row(i)));
    const t0 = Date.now();
    __resetTrimThrottleForTests();
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('indexeddb unavailable');
    });

    await expect(trimCompletedResultBytes(t0)).rejects.toThrow('indexeddb unavailable');
    // still failing, still inside the retry floor: must not reach the store again
    await expect(trimCompletedResultBytes(t0 + TRIM_FAILURE_RETRY_MS - 1)).resolves.toBe(0);

    spy.mockRestore();
    // at the retry boundary it runs again
    expect(await trimCompletedResultBytes(t0 + TRIM_FAILURE_RETRY_MS)).toBe(5);
  });
});
