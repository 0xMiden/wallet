/**
 * Database-level coverage for the reaper itself.
 *
 * These drive `runTrimTick` against fake-indexeddb, because a test of the predicate alone survives
 * deleting the dexie query, the bound and the delete. Each test here names one production edit that
 * makes it fail.
 */
import type { DBCore } from 'dexie';

import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  __resetTrimThrottleForTests,
  RESULT_BYTES_RETENTION_MS,
  TRIM_BATCH_SIZE,
  TRIM_MIN_INTERVAL_MS,
  runTrimTick
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
  return runTrimTick();
};

beforeEach(async () => {
  await Repo.transactions.clear();
  __resetTrimThrottleForTests();
});

// Several tests replace `Repo.transactions.where` or mute the console and restore them only after an
// awaited assertion, so a failing assertion would leave the mock in place for every later test.
afterEach(() => jest.restoreAllMocks());

describe('runTrimTick', () => {
  it('drains every eligible row across successive passes', async () => {
    // Fails without the select's `.filter()`: a bare `.limit()` re-selects the same oldest
    // TRIM_BATCH_SIZE rows, which are already trimmed after pass 1, so the last 50 blobs survive.
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
    // markBridgedSendFailed demotes a Completed Epoch row without clearing them. Both rows carry
    // completedAt, so the index reaches them; a Completed-only predicate would pin them forever.
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
    // No type is exempt: both callers await waitForTransactionCompletion and then re-read
    // outputNoteIds, which this never touches.
    await Repo.transactions.bulkPut([
      row(1, { type: 'earn-deposit' }),
      row(2, { type: 'bridged-send', extraInputs: { provider: 'epoch' } } as Partial<ITransaction>)
    ]);

    expect(await pass()).toBe(2);
    expect(await blobsLeft()).toBe(0);
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
    // Pins the COMPOSED selector's effective cutoff - and only that. Making the query inclusive
    // alone leaves this green (the predicate still declines), and making the predicate inclusive
    // alone leaves it green too (the query never selects the row); only changing both fails. So
    // this cannot claim to protect the agreement between the two, and neither half alone is
    // observable.
    const now = Date.now();
    const cutoff = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);
    await Repo.transactions.bulkPut([
      row(1, { id: 'at-cutoff', completedAt: cutoff } as Partial<ITransaction>),
      row(2, { id: 'one-older', completedAt: cutoff - 1 } as Partial<ITransaction>)
    ]);

    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => now)).toBe(1);
    const atCutoff = await Repo.transactions.get('at-cutoff');
    const oneOlder = await Repo.transactions.get('one-older');
    // Both rows must still EXIST - `?.resultBytes === undefined` is equally true of a deleted row,
    // so without these a regression that removed history rows would read as a correct trim.
    expect(atCutoff).toBeDefined();
    expect(oneOlder).toBeDefined();
    expect(atCutoff?.resultBytes).toBeDefined();
    expect(oneOlder?.resultBytes).toBeUndefined();
  });

  it('clears the blob only once a row ages past the window, leaving the row itself intact', async () => {
    // Storage only, and named for it. Driving the real `waitForTransactionCompletion` here would
    // need TransactionResult.deserialize stubbed (jest maps the SDK to a mock without it),
    // splitExecutedOutputNotes mocked, a transactionId on the fixture and a dexie liveQuery mock -
    // and deleting that helper's missing-bytes arm would STILL degrade via its catch. Its coverage
    // lives in transactions.branches.test.ts. What this pins is the window's effect on the store.
    //
    // The row assertion is load-bearing: `?.resultBytes === undefined` is equally true of a row
    // that was DELETED, so without it a regression that wiped history would pass.
    const now = Date.now();
    const inWindow = Math.floor((now - RESULT_BYTES_RETENTION_MS / 2) / 1000);
    await Repo.transactions.bulkPut([row(1, { id: 'fresh', completedAt: inWindow } as Partial<ITransaction>)]);

    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => now)).toBe(0);
    expect((await Repo.transactions.get('fresh'))?.resultBytes).toBeDefined();

    // ...and once it ages past the window, the blob is gone and the wait can only degrade.
    const later = now + RESULT_BYTES_RETENTION_MS;
    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => later)).toBe(1);
    const trimmedRow = await Repo.transactions.get('fresh');
    expect(trimmedRow).toBeDefined();
    expect(trimmedRow?.resultBytes).toBeUndefined();
    // `delete`, not an assigned undefined: both release the blob, and this pins the stored shape.
    expect('resultBytes' in trimmedRow!).toBe(false);
    // ...and the release is recorded, which is what lets the waiter answer it as expired.
    expect(trimmedRow?.resultReleasedAt).toBe(Math.floor(later / 1000));
  });

  it('never trims a row that carries no completedAt', async () => {
    // Pins the INDEX behaviour the module relies on - IndexedDB omits records whose index key is
    // undefined, so the query never reaches this row. It does not pin the predicate's lack of an
    // `?? initiatedAt` fallback: adding one leaves this green, because the row never reaches the
    // predicate either way.
    await Repo.transactions.bulkPut([
      row(1, { id: 'no-ts', completedAt: undefined, initiatedAt: AGED } as Partial<ITransaction>)
    ]);

    __resetTrimThrottleForTests();
    expect(await runTrimTick()).toBe(0);
    expect((await Repo.transactions.get('no-ts'))?.resultBytes).toBeDefined();
  });

  it('throttles only after the range is exhausted', async () => {
    // A SHORT pass means nothing is left, so the floor applies. Asserted under a load the ungated
    // path has not already drained - without the throttle the second call would take the other 50.
    const n = TRIM_BATCH_SIZE + 50;
    await Repo.transactions.bulkPut(Array.from({ length: n }, (_, i) => row(i)));
    const t0 = Date.now();

    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => t0)).toBe(TRIM_BATCH_SIZE); // full batch: no stamp
    expect(await runTrimTick(() => t0)).toBe(50); // continues at the SAME now
    expect(await blobsLeft()).toBe(0);

    // A fresh eligible row, so a third call returning 0 means THROTTLED rather than "nothing left".
    await Repo.transactions.bulkPut([row(1, { id: 'late-arrival', completedAt: AGED } as Partial<ITransaction>)]);
    expect(await runTrimTick(() => t0)).toBe(0);
    expect(await blobsLeft()).toBe(1);

    // ...and the floor lifts exactly at the interval.
    expect(await runTrimTick(() => t0 + TRIM_MIN_INTERVAL_MS)).toBe(1);
  });

  it('does not park a backlog behind the interval after a full batch', async () => {
    // The drain rate is the point: stamping after a full batch would make a 456-row backlog take
    // one batch per five minutes.
    await Repo.transactions.bulkPut(Array.from({ length: TRIM_BATCH_SIZE + 10 }, (_, i) => row(i)));
    const t0 = Date.now();

    __resetTrimThrottleForTests();
    await runTrimTick(() => t0);

    expect(await runTrimTick(() => t0)).toBe(10);
  });

  it('reports progress when a pass releases blobs', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    await Repo.transactions.bulkPut(Array.from({ length: 3 }, (_, i) => row(i)));
    __resetTrimThrottleForTests();

    await runTrimTick();

    expect(info).toHaveBeenCalledWith(expect.stringContaining('released 3'));
    info.mockRestore();
  });

  it('re-checks inside the write, and still reports the range as unexhausted', async () => {
    // The select and the write run in DIFFERENT transactions, so a row chosen by the select can
    // stop being eligible before the write sees it. The in-write re-check is the whole safety
    // argument for that split - and no other test makes the two disagree, so deleting the re-check
    // outright passes the rest of the suite.
    //
    // The fixture size is load-bearing: with fewer than TRIM_BATCH_SIZE eligible rows the select
    // returns a short batch and `exhausted` is true whatever the writer does, so the second
    // assertion would fail against CORRECT code.
    const n = TRIM_BATCH_SIZE + 20;
    await Repo.transactions.bulkPut(Array.from({ length: n }, (_, i) => row(i)));
    __resetTrimThrottleForTests();

    // Make one selected row ineligible between primaryKeys() and modify, then count only the
    // reaper's own writes: dexie re-puts a row for any callback result but `false`, so a declined row
    // must not appear here.
    const written: string[] = [];
    const recordWrite = (_mods: unknown, primKey: string) => {
      written.push(primKey);
    };
    let demoted: string | undefined;
    // Dexie's query builders are overloaded, so the wrapper is typed through one alias rather
    // than casting at each link. Test-side only: every call delegates to the real collection.
    type Chain = {
      below: (v: number) => Chain;
      filter: (f: never) => Chain;
      limit: (k: number) => Chain;
      primaryKeys: () => Promise<string[]>;
    };
    const realWhere = Repo.transactions.where.bind(Repo.transactions);
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementationOnce(index => {
      const collection = realWhere(index as never) as unknown as Chain;
      const below = collection.below.bind(collection);
      collection.below = (v: number) => {
        const c = below(v);
        const filter = c.filter.bind(c);
        c.filter = (fn: never) => {
          const lc = filter(fn);
          const limit = lc.limit.bind(lc);
          lc.limit = (k: number) => {
            const kc = limit(k);
            const pk = kc.primaryKeys.bind(kc);
            kc.primaryKeys = async () => {
              const ids = await pk();
              demoted = ids[0];
              if (demoted) await Repo.transactions.update(demoted, { status: ITransactionStatus.Queued });
              Repo.transactions.hook('updating', recordWrite);
              return ids;
            };
            return kc;
          };
          return lc;
        };
        return c;
      };
      return collection as unknown as ReturnType<typeof realWhere>;
    });

    const trimmed = await runTrimTick();
    spy.mockRestore();
    Repo.transactions.hook('updating').unsubscribe(recordWrite);

    // The wrapper hooks one exact builder order, so first prove it intercepted at all: otherwise a
    // harmless reordering of filter and limit would fail below exactly like a deleted re-check.
    expect(demoted).toBeDefined();
    // One selected row was declined inside the write, and left unwritten...
    expect(trimmed).toBe(TRIM_BATCH_SIZE - 1);
    expect(written).toHaveLength(TRIM_BATCH_SIZE - 1);
    expect(written).not.toContain(demoted);
    // ...but the range was NOT exhausted, so the floor must not have been stamped. Inferring
    // exhaustion from `trimmed < TRIM_BATCH_SIZE` would park the remaining rows for the interval.
    expect(await runTrimTick()).toBeGreaterThan(0);
  });

  it('does not select a row until the first whole second after its window', async () => {
    // The exact half of the TTL. `completedAt` floors the completion to whole seconds and the
    // cutoff floors too, so eligibility begins at the first whole second after the window. This
    // fixture completes on an exact second, the one case where that slack is a full second; for a
    // completion at .999 it is a single millisecond.
    const completedAtMs = 1_700_000_000_000;
    const completedAt = Math.floor(completedAtMs / 1000);
    await Repo.transactions.bulkPut([
      row(1, { id: 'edge', completedAt, initiatedAt: completedAt } as Partial<ITransaction>)
    ]);

    // exactly at the nominal window: not yet selectable
    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => completedAtMs + RESULT_BYTES_RETENTION_MS)).toBe(0);
    // one millisecond short of the real boundary: still not selectable
    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => completedAtMs + RESULT_BYTES_RETENTION_MS + 999)).toBe(0);
    // and at the boundary itself
    __resetTrimThrottleForTests();
    expect(await runTrimTick(() => completedAtMs + RESULT_BYTES_RETENTION_MS + 1000)).toBe(1);
  });

  it('reports a failed pass once when two callers overlap', async () => {
    // Both drivers call bare, so the module is the only reporter; the caller that skips the running
    // pass must not report its failure a second time.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Repo.transactions.bulkPut([row(1)]);
    __resetTrimThrottleForTests();
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('indexeddb unavailable');
    });

    await Promise.all([runTrimTick(), runTrimTick()]);

    spy.mockRestore();
    expect(warn.mock.calls.filter(c => String(c[0]).includes('pass failed')).length).toBe(1);
    warn.mockRestore();
  });

  it('runTrimTick never rejects, which is what lets the drivers call it bare', async () => {
    // Both drivers are `void runTrimTick();` with no handler. That is only safe because this
    // resolves on failure; if it ever rethrew, each driver would leak an unhandled rejection.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Repo.transactions.bulkPut([row(1)]);
    __resetTrimThrottleForTests();
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('indexeddb unavailable');
    });

    await expect(runTrimTick()).resolves.toBe(0);

    spy.mockRestore();
    warn.mockRestore();
  });

  it('runs one pass for two overlapping callers', async () => {
    // Both drivers fire and forget, so on the extension the miden-sync alarm and the popup's 3s
    // SyncRequest can overlap. Counting selects is what discriminates: without the guard the second
    // pass's in-write re-check declines every row, so the store and the returned counts are the same.
    await Repo.transactions.bulkPut(Array.from({ length: 10 }, (_, i) => row(i)));
    __resetTrimThrottleForTests();
    const where = jest.spyOn(Repo.transactions, 'where');

    const counts = await Promise.all([runTrimTick(), runTrimTick()]);

    const selects = where.mock.calls.filter(c => String(c[0]) === 'completedAt').length;
    where.mockRestore();
    expect(counts).toEqual([10, 0]);
    expect(selects).toBe(1);
  });

  it('backs a failed pass off for the interval', async () => {
    // A failed pass and a throttled call both resolve to 0, so the store-query count is what
    // discriminates.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Repo.transactions.bulkPut(Array.from({ length: 5 }, (_, i) => row(i)));
    const t0 = Date.now();
    __resetTrimThrottleForTests();
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('indexeddb unavailable');
    });

    expect(await runTrimTick(() => t0)).toBe(0);
    // still failing, still inside the floor: must not reach the store again
    expect(await runTrimTick(() => t0 + TRIM_MIN_INTERVAL_MS - 1)).toBe(0);
    const queries = spy.mock.calls.length;

    spy.mockRestore();
    warn.mockRestore();
    expect(queries).toBe(1);
    // at the floor it runs again
    expect(await runTrimTick(() => t0 + TRIM_MIN_INTERVAL_MS)).toBe(5);
  });

  it('measures the floor from when an exhausted pass settles', async () => {
    // A pass that outlasts the interval must still leave the floor in place: stamped from the clock
    // reading taken when the pass started, it would already be lifted for the next caller.
    await Repo.transactions.bulkPut([row(1)]);
    __resetTrimThrottleForTests();
    let t = Date.now();
    const clock = () => t;
    const realWhere = Repo.transactions.where.bind(Repo.transactions);
    const slowSelect = jest.spyOn(Repo.transactions, 'where').mockImplementationOnce(index => {
      t += TRIM_MIN_INTERVAL_MS;
      return realWhere(index as never) as unknown as ReturnType<typeof realWhere>;
    });

    expect(await runTrimTick(clock)).toBe(1);
    slowSelect.mockRestore();

    const where = jest.spyOn(Repo.transactions, 'where');
    expect(await runTrimTick(clock)).toBe(0);
    const queries = where.mock.calls.length;
    where.mockRestore();
    expect(queries).toBe(0);
  });

  it('measures the floor from when a failed pass settles', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    __resetTrimThrottleForTests();
    let t = Date.now();
    const clock = () => t;
    const spy = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      t += TRIM_MIN_INTERVAL_MS;
      throw new Error('indexeddb unavailable');
    });

    expect(await runTrimTick(clock)).toBe(0);
    expect(await runTrimTick(clock)).toBe(0);
    const queries = spy.mock.calls.length;

    spy.mockRestore();
    warn.mockRestore();
    expect(queries).toBe(1);
  });

  it('writes a full batch in modify chunks of at most 25 rows', async () => {
    // `modifyChunkSize` in repo.ts is all that bounds how many ~237 KB rows one modify holds at
    // once; dexie falls back to 200, the whole batch, if the option is dropped or stops being read.
    // A dbcore middleware only joins the stack when the database opens, hence the reopen.
    await Repo.transactions.bulkPut(Array.from({ length: TRIM_BATCH_SIZE }, (_, i) => row(i)));
    const chunks: number[] = [];
    const probe = {
      stack: 'dbcore' as const,
      name: 'modify-chunk-probe',
      create: (down: DBCore): DBCore => ({
        ...down,
        table: name => {
          const table = down.table(name);
          return {
            ...table,
            getMany: req => {
              chunks.push(req.keys.length);
              return table.getMany(req);
            }
          };
        }
      })
    };
    Repo.db.close();
    Repo.db.use(probe);
    await Repo.db.open();
    try {
      expect(await runTrimTick()).toBe(TRIM_BATCH_SIZE);
    } finally {
      Repo.db.close();
      Repo.db.unuse(probe);
      await Repo.db.open();
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(25);
  });
});
