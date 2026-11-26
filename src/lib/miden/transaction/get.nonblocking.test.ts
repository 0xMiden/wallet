import Dexie, { type DBCoreCursor, type DBCoreKeyRange } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { localSwapOrders } from 'lib/miden/swap/classification';

import {
  getAllUncompletedTransactions,
  getCompletedTransactions,
  getCompletedTransactionsPage,
  getFailedTransactions,
  getNoteHoldingTransactions,
  getTransactionsInProgress,
  getUncompletedTransactions,
  getUnconfirmedTransactions,
  hasQueuedTransactions,
  hasRestoredTransactionsOf
} from './get';
import {
  compareIdbKeys,
  countIndexEntriesUpTo,
  equalIndexSpec,
  RANGE_ANY,
  RANGE_BOUND,
  readTransactionIndexChunks,
  statusTypeIndexSpecs
} from '../db/index-query';
import { type ISubmitEvidence, type ITransaction, ITransactionStatus } from '../db/types';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const makeCheckableEvidence = (nowSec: number): ISubmitEvidence => ({
  attemptId: 'attempt-1',
  capturedAt: nowSec,
  source: 'stage',
  transactionId: hex(1),
  initialCommitment: hex(2),
  finalCommitment: hex(2),
  initialNonce: '1',
  outputNoteIds: [],
  nullifiers: [hex(3)],
  refBlock: 10,
  refBlockCommitment: hex(4)
});

const makeTx = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id,
  type: 'send',
  accountId: 'mtst1acct',
  status: ITransactionStatus.Completed,
  initiatedAt: 1_700_000_000,
  completedAt: 1_700_000_010,
  displayIcon: 'SEND',
  faucetId: 'faucet-1',
  ...overrides
});

interface TableReadProbe {
  rowsRead: number;
  cursorIndexes: string[];
  restore: () => void;
}

const wrapCursorStep = <T extends (...args: never[]) => unknown>(
  target: DBCoreCursor,
  key: 'continue' | 'continuePrimaryKey' | 'advance',
  beforeStep: () => void
): void => {
  const fn = target[key] as T | undefined;
  if (!fn || Reflect.get(fn, '__probed')) return;
  const wrapped = ((...args: Parameters<T>) => {
    beforeStep();
    return fn.apply(target, args);
  }) as T;
  Reflect.set(wrapped, '__probed', true);
  (target[key] as T) = wrapped;
};

function installCoreReadProbe(
  table: Dexie.Table<ITransaction, string>,
  onReadOp?: (indexName: string, range: DBCoreKeyRange) => void
): TableReadProbe {
  const core = table.core;
  const origQuery = core.query.bind(core);
  const origOpenCursor = core.openCursor.bind(core);
  const origGet = core.get.bind(core);
  const origGetMany = core.getMany.bind(core);

  const probe: TableReadProbe = {
    rowsRead: 0,
    cursorIndexes: [],
    restore: () => {
      core.query = origQuery;
      core.openCursor = origOpenCursor;
      core.get = origGet;
      core.getMany = origGetMany;
    }
  };

  core.get = req =>
    origGet(req).then(val => {
      if (val !== undefined) probe.rowsRead += 1;
      return val;
    });

  core.getMany = req =>
    origGetMany(req).then(vals => {
      probe.rowsRead += vals.filter(v => v !== undefined).length;
      return vals;
    });

  core.query = req => {
    const indexName = req.query.index.name ?? '';
    if (req.values) {
      onReadOp?.(indexName, req.query.range);
    }
    return origQuery(req).then(res => {
      if (req.values) probe.rowsRead += res.result.length;
      return res;
    });
  };

  core.openCursor = req => {
    if (req.values === false) {
      return origOpenCursor(req);
    }
    const indexName = req.query.index.name ?? '';
    probe.cursorIndexes.push(indexName);
    onReadOp?.(indexName, req.query.range);
    return origOpenCursor(req).then((cursor: DBCoreCursor | null) => {
      if (cursor === null) return null;
      probe.rowsRead += 1;
      let currentCounted = true;
      const markNextUnread = () => {
        currentCounted = false;
      };
      const origStart = cursor.start;
      cursor.start = function (callback) {
        return origStart.call(this, () => {
          if (!this.done && !currentCounted) {
            probe.rowsRead += 1;
            currentCounted = true;
          }
          wrapCursorStep(this, 'continue', markNextUnread);
          wrapCursorStep(this, 'continuePrimaryKey', markNextUnread);
          wrapCursorStep(this, 'advance', markNextUnread);
          callback();
        });
      };
      return cursor;
    });
  };

  return probe;
}

const isFailedConsumeRange = (indexName: string, range: DBCoreKeyRange): boolean =>
  indexName === '[status+type]' &&
  Array.isArray(range.lower) &&
  range.lower[0] === ITransactionStatus.Failed &&
  range.lower[1] === 'consume';

async function withConcurrentWriteProbe<T>(
  table: Dexie.Table<ITransaction, string>,
  createConcurrentWrite: () => Promise<unknown>,
  run: () => Promise<T>,
  options: {
    shouldArm?: (indexName: string, range: DBCoreKeyRange) => boolean;
    countPostWrite?: (indexName: string, range: DBCoreKeyRange) => boolean;
  } = {}
): Promise<{
  result: T;
  probe: TableReadProbe;
  armedCount: number;
  unarmedBeforeArmCount: number;
  cursorCallsAfterWriteDone: number;
}> {
  let writePromise: Promise<unknown> | undefined;
  let writeDone = false;
  let armedCount = 0;
  let unarmedBeforeArmCount = 0;
  let cursorCallsAfterWriteDone = 0;

  const probe = installCoreReadProbe(table, (indexName, range) => {
    if (writeDone) {
      if (!options.countPostWrite || options.countPostWrite(indexName, range)) {
        cursorCallsAfterWriteDone += 1;
      }
      return;
    }
    if (!writePromise) {
      if (options.shouldArm && !options.shouldArm(indexName, range)) {
        unarmedBeforeArmCount += 1;
        return;
      }
      armedCount += 1;
      writePromise = Dexie.ignoreTransaction(createConcurrentWrite).then(val => {
        writeDone = true;
        return val;
      });
    }
  });

  try {
    const result = await run();
    expect(writePromise).toBeDefined();
    await writePromise;
    expect(writeDone).toBe(true);
    expect(cursorCallsAfterWriteDone).toBeGreaterThan(0);
    return { result, probe, armedCount, unarmedBeforeArmCount, cursorCallsAfterWriteDone };
  } finally {
    probe.restore();
  }
}

async function withIsolatedTransactionsDb<T>(
  prefix: string,
  run: (isolated: Dexie, table: Dexie.Table<ITransaction, string>) => Promise<T>
): Promise<T> {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const isolated = Repo.createSchemaFor(name);
  try {
    await isolated.open();
    const table = isolated.table<ITransaction, string>(Repo.Table.Transactions);
    return await run(isolated, table);
  } finally {
    isolated.close();
    await Dexie.delete(name);
  }
}

describe('non-blocking transaction store reads (#2327)', () => {
  beforeEach(async () => {
    await Repo.transactions.clear();
  });

  it('getNoteHoldingTransactions avoids scanning historical completed rows (both old and recent)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const bulk: ITransaction[] = [];
    for (let i = 0; i < 150; i++) {
      bulk.push(
        makeTx(`old-send-${i}`, {
          initiatedAt: nowSec - 10_000 - i,
          completedAt: nowSec - 9_000 - i
        }),
        makeTx(`recent-send-${i}`, {
          initiatedAt: nowSec - 20,
          completedAt: nowSec - 10
        })
      );
    }
    bulk.push(
      makeTx('live-consume', {
        type: 'consume',
        accountId: 'mtst1acct_tag',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec - 5,
        completedAt: undefined,
        noteId: 'note-live',
        noteIds: ['note-live']
      }),
      makeTx('unconfirmed-consume', {
        type: 'consume',
        status: ITransactionStatus.Unconfirmed,
        initiatedAt: nowSec - 4,
        completedAt: nowSec - 3,
        noteId: 'note-unconf',
        noteIds: ['note-unconf'],
        submitEvidence: [makeCheckableEvidence(nowSec)]
      }),
      makeTx('recent-dapp-execute', {
        type: 'execute',
        status: ITransactionStatus.Completed,
        initiatedAt: nowSec - 30,
        completedAt: nowSec - 20,
        heldNoteIds: ['note-dapp']
      }),
      makeTx('expired-dapp-execute', {
        type: 'execute',
        status: ITransactionStatus.Completed,
        initiatedAt: nowSec - 1000,
        completedAt: nowSec - 600,
        heldNoteIds: ['note-expired']
      })
    );
    await Repo.transactions.bulkPut(bulk);

    const filterSpy = jest.spyOn(Repo.transactions, 'filter');
    const probe = installCoreReadProbe(Repo.transactions);
    try {
      const held = await getNoteHoldingTransactions('mtst1acct');
      expect(held.map(tx => tx.id)).toEqual(['recent-dapp-execute', 'live-consume', 'unconfirmed-consume']);
      expect(filterSpy).not.toHaveBeenCalled();
      expect(probe.rowsRead).toBeLessThanOrEqual(20);
    } finally {
      probe.restore();
      filterSpy.mockRestore();
    }
  }, 15_000);

  it('getNoteHoldingTransactions chunks large Failed-consume scans so concurrent writes commit mid-scan', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const failedConsumes: ITransaction[] = Array.from({ length: 240 }, (_, i) =>
      makeTx(`failed-consume-${i}`, {
        type: 'consume',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - 1000 - i,
        completedAt: nowSec - 900 - i,
        noteId: `note-fail-${i}`,
        noteIds: [`note-fail-${i}`]
      })
    );
    failedConsumes.push(
      makeTx('live-consume', {
        type: 'consume',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec,
        completedAt: undefined,
        noteId: 'note-live',
        noteIds: ['note-live']
      })
    );
    await Repo.transactions.bulkPut(failedConsumes);

    const {
      result: held,
      armedCount,
      unarmedBeforeArmCount
    } = await withConcurrentWriteProbe(
      Repo.transactions,
      () =>
        Repo.transactions.add(
          makeTx('concurrent-write', {
            type: 'send',
            status: ITransactionStatus.Queued,
            initiatedAt: nowSec + 1,
            completedAt: undefined
          })
        ),
      () => getNoteHoldingTransactions('mtst1acct'),
      {
        shouldArm: isFailedConsumeRange,
        countPostWrite: isFailedConsumeRange
      }
    );
    expect(held.map(tx => tx.id)).toEqual(['live-consume']);
    expect(armedCount).toBe(1);
    expect(unarmedBeforeArmCount).toBe(6);
  });

  it('getCompletedTransactionsPage skips initiatedAt fallback scan when all terminal rows have nonzero completedAt', async () => {
    await withIsolatedTransactionsDb('page-skip-fallback', async (_isolated, table) => {
      const rows: ITransaction[] = Array.from({ length: 500 }, (_, i) =>
        makeTx(`other-${i}`, {
          accountId: 'mtst1other',
          initiatedAt: 1_700_000_000 + i,
          completedAt: 1_700_000_000 + i
        })
      );
      rows.push(
        makeTx('mine-1', { accountId: 'mtst1mine', initiatedAt: 100, completedAt: 100 }),
        makeTx('mine-2', { accountId: 'mtst1mine', initiatedAt: 200, completedAt: 200 }),
        makeTx('mine-3', { accountId: 'mtst1mine', initiatedAt: 300, completedAt: 300 })
      );
      await table.bulkAdd(rows);

      const probe = installCoreReadProbe(table);
      try {
        const page = await getCompletedTransactionsPage(
          { accountId: 'mtst1mine', limit: 20, includeFailed: true, fromEnd: true },
          table
        );
        expect(page.transactions.map(tx => tx.id)).toEqual(['mine-3', 'mine-2', 'mine-1']);
        expect(page.hasMore).toBe(false);
        expect(probe.cursorIndexes).not.toContain('initiatedAt');
      } finally {
        probe.restore();
      }
    });
  });

  it('getCompletedTransactionsPage chunks large tied-timestamp reads so concurrent writes commit mid-page without O(N^2) rescan', async () => {
    await withIsolatedTransactionsDb('page-chunked', async (isolated, table) => {
      const tiedCompletedAt = 1_700_000_000;
      const rows: ITransaction[] = Array.from({ length: 500 }, (_, i) =>
        makeTx(`tx-${String(i).padStart(4, '0')}`, {
          accountId: 'mtst1acct',
          initiatedAt: tiedCompletedAt - 10,
          completedAt: tiedCompletedAt
        })
      );
      await table.bulkAdd(rows);

      let readTxCount = 0;
      const origTx = isolated.transaction.bind(isolated);
      const txSpy = jest.spyOn(isolated, 'transaction').mockImplementation(((...args: unknown[]) => {
        if (args[0] === 'r') readTxCount += 1;
        return (origTx as (...a: unknown[]) => unknown)(...args);
      }) as typeof isolated.transaction);

      try {
        const { result: page, probe } = await withConcurrentWriteProbe(
          table,
          () =>
            table.add(
              makeTx('tx-concurrent-new', {
                accountId: 'mtst1acct',
                initiatedAt: tiedCompletedAt + 5,
                completedAt: tiedCompletedAt + 5
              })
            ),
          () =>
            getCompletedTransactionsPage(
              { accountId: 'mtst1acct', limit: 350, includeFailed: true, fromEnd: true },
              table
            )
        );
        expect(page.transactions).toHaveLength(350);
        expect(page.rawCount).toBe(350);
        expect(page.hasMore).toBe(true);
        expect(new Set(page.transactions.map(tx => tx.id)).size).toBe(350);
        expect(page.transactions[0]?.id).toBe('tx-0499');
        expect(page.transactions[349]?.id).toBe('tx-0150');
        expect(readTxCount).toBeGreaterThan(1);
        // O(log N) primary-key cursor resume avoids quadratic rescanning of tied timestamps.
        expect(probe.rowsRead).toBeLessThan(400);
      } finally {
        txSpy.mockRestore();
      }
    });
  });

  it('sibling status/type transaction queries use indexes instead of scanning completed history', async () => {
    const bulk: ITransaction[] = Array.from({ length: 500 }, (_, i) =>
      makeTx(`completed-${i}`, {
        initiatedAt: 1_700_000_000 + i,
        completedAt: 1_700_000_000 + i
      })
    );
    bulk.push(
      makeTx('q-1', { status: ITransactionStatus.Queued, completedAt: undefined }),
      makeTx('g-1', { status: ITransactionStatus.GeneratingTransaction, completedAt: undefined }),
      makeTx('f-1', { status: ITransactionStatus.Failed, completedAt: 1_700_000_999 }),
      makeTx('u-1', { status: ITransactionStatus.Unconfirmed, completedAt: 1_700_000_998 }),
      makeTx('swap-1', {
        type: 'swap',
        status: ITransactionStatus.Completed,
        extraInputs: { requestedFaucetId: 'f2', requestedAmount: 50n, orderId: 1n }
      })
    );
    await Repo.transactions.bulkPut(bulk);

    const checkBounded = async (fn: () => Promise<unknown>) => {
      const probe = installCoreReadProbe(Repo.transactions);
      try {
        await fn();
        expect(probe.rowsRead).toBeLessThanOrEqual(10);
      } finally {
        probe.restore();
      }
    };

    await checkBounded(async () => {
      expect(await hasQueuedTransactions()).toBe(true);
    });
    await checkBounded(async () => {
      expect((await getUncompletedTransactions('mtst1acct')).map(t => t.id)).toEqual(['q-1', 'g-1']);
    });
    await checkBounded(async () => {
      expect((await getTransactionsInProgress()).map(t => t.id)).toEqual(['g-1']);
    });
    await checkBounded(async () => {
      expect((await getAllUncompletedTransactions()).map(t => t.id)).toEqual(['q-1', 'g-1']);
    });
    await checkBounded(async () => {
      expect((await getFailedTransactions()).map(t => t.id)).toEqual(['f-1']);
    });
    await checkBounded(async () => {
      expect((await getUnconfirmedTransactions()).map(t => t.id)).toEqual(['u-1']);
    });
    await checkBounded(async () => {
      expect((await localSwapOrders('mtst1acct')).map(t => t.id)).toEqual(['swap-1']);
    });
  });

  it('hasRestoredTransactionsOf chunks primary-key scans so concurrent writes commit mid-scan', async () => {
    const bulk: ITransaction[] = Array.from({ length: 240 }, (_, i) =>
      makeTx(`normal-${String(i).padStart(4, '0')}`, {
        accountId: 'mtst1acct',
        restoredFromBackup: false,
        initiatedAt: 1_700_000_000 + i
      })
    );
    await Repo.transactions.bulkPut(bulk);

    const { result } = await withConcurrentWriteProbe(
      Repo.transactions,
      () =>
        Repo.transactions.add(
          makeTx('concurrent-restored-check', {
            accountId: 'mtst1other',
            restoredFromBackup: false
          })
        ),
      () => hasRestoredTransactionsOf('mtst1acct')
    );
    expect(result).toBe(false);
  });

  it('getCompletedTransactionsPage chunks the merge stream when an initiatedAt fallback row exists without drops or duplicates', async () => {
    await withIsolatedTransactionsDb('page-merge-chunked', async (_isolated, table) => {
      const tiedCompletedAt = 1_700_000_000;
      const rows: ITransaction[] = Array.from({ length: 260 }, (_, i) =>
        makeTx(`tx-${String(i).padStart(4, '0')}`, {
          accountId: 'mtst1acct',
          initiatedAt: tiedCompletedAt - 10,
          completedAt: tiedCompletedAt
        })
      );
      rows.push(
        makeTx('fallback-missing-completed', {
          accountId: 'mtst1acct',
          initiatedAt: tiedCompletedAt + 1,
          completedAt: undefined
        })
      );
      await table.bulkAdd(rows);

      const { result: page } = await withConcurrentWriteProbe(
        table,
        () =>
          table.add(
            makeTx('tx-concurrent-merge', {
              accountId: 'mtst1acct',
              initiatedAt: tiedCompletedAt + 10,
              completedAt: tiedCompletedAt + 10
            })
          ),
        () =>
          getCompletedTransactionsPage(
            { accountId: 'mtst1acct', limit: 200, includeFailed: true, fromEnd: true },
            table
          )
      );
      expect(page.transactions).toHaveLength(200);
      expect(page.hasMore).toBe(true);
      expect(new Set(page.transactions.map(tx => tx.id)).size).toBe(200);
      expect(page.transactions[0]?.id).toBe('fallback-missing-completed');
      expect(page.transactions[1]?.id).toBe('tx-0259');
      expect(page.transactions[199]?.id).toBe('tx-0061');
    });
  });

  it('readTransactionIndexChunks handles stripped mocks with undefined completedAt, heldNoteIds arrays, dotted paths, compound ranges, and limit', async () => {
    const rows: ITransaction[] = [
      makeTx('swap-match', {
        type: 'swap',
        status: ITransactionStatus.Completed,
        completedAt: undefined,
        extraInputs: { swapOrderTxId: 'order-1' } as ITransaction['extraInputs']
      }),
      makeTx('held-match-1', {
        type: 'execute',
        status: ITransactionStatus.Completed,
        completedAt: 200,
        heldNoteIds: ['note-a', 'note-b']
      }),
      makeTx('held-match-2', {
        type: 'execute',
        status: ITransactionStatus.Completed,
        completedAt: 250,
        heldNoteIds: ['note-b', 'note-c']
      }),
      makeTx('no-completed-ts', {
        type: 'consume',
        status: ITransactionStatus.Completed,
        completedAt: undefined,
        heldNoteIds: undefined
      })
    ];

    const filterOnlyMock = {
      filter: (pred: (row: ITransaction) => boolean) => ({
        toArray: async () => rows.filter(pred)
      })
    } as unknown as Dexie.Table<ITransaction, string>;

    const toArrayOnlyMock = {
      toArray: async () => rows
    } as unknown as Dexie.Table<ITransaction, string>;

    const swaps = await readTransactionIndexChunks(
      filterOnlyMock,
      statusTypeIndexSpecs([[ITransactionStatus.Completed, 'swap']]),
      () => true
    );
    expect(swaps.map(r => r.id)).toEqual(['swap-match']);

    const byDotted = await readTransactionIndexChunks(
      toArrayOnlyMock,
      [equalIndexSpec('extraInputs.swapOrderTxId', 'order-1')],
      () => true
    );
    expect(byDotted.map(r => r.id)).toEqual(['swap-match']);

    const byHeld = await readTransactionIndexChunks(
      filterOnlyMock,
      [
        {
          indexName: 'heldNoteIds',
          range: { type: RANGE_BOUND, lower: 'note-b', upper: Dexie.maxKey, lowerOpen: false, upperOpen: true }
        }
      ],
      () => true,
      { limit: 1 }
    );
    expect(byHeld).toHaveLength(1);
    expect(byHeld[0]?.id).toBe('held-match-1');

    const byCompletedBound = await readTransactionIndexChunks(
      filterOnlyMock,
      [
        {
          indexName: '[status+completedAt]',
          range: {
            type: RANGE_BOUND,
            lower: [ITransactionStatus.Completed, 150],
            upper: [ITransactionStatus.Completed, Number.POSITIVE_INFINITY],
            lowerOpen: true,
            upperOpen: false
          }
        }
      ],
      () => true
    );
    expect(byCompletedBound.map(r => r.id)).toEqual(['held-match-1', 'held-match-2']);

    const anyById = await readTransactionIndexChunks(
      filterOnlyMock,
      [{ indexName: 'id', range: { type: RANGE_ANY, lower: undefined, upper: undefined } }],
      tx => tx.id === 'no-completed-ts'
    );
    expect(anyById.map(r => r.id)).toEqual(['no-completed-ts']);
  });

  it('hasQueuedTransactions uses a bounded key-only lookup without core.count and works on a stripped mock without .where', async () => {
    await Repo.transactions.bulkPut([
      makeTx('done-1', { status: ITransactionStatus.Completed }),
      makeTx('queued-1', { status: ITransactionStatus.Queued, completedAt: undefined })
    ]);

    const countSpy = jest.spyOn(Repo.transactions.core, 'count');
    try {
      expect(await hasQueuedTransactions()).toBe(true);
      expect(countSpy).not.toHaveBeenCalled();
    } finally {
      countSpy.mockRestore();
    }

    const origDesc = Object.getOwnPropertyDescriptor(Repo.transactions, 'schema');
    const whereSpy = jest.spyOn(Repo.transactions, 'where').mockImplementation((() => {
      throw new Error('must not call where on stripped mock');
    }) as never);
    Object.defineProperty(Repo.transactions, 'schema', { value: undefined, configurable: true });
    try {
      expect(await hasQueuedTransactions()).toBe(true);
    } finally {
      if (origDesc) {
        Object.defineProperty(Repo.transactions, 'schema', origDesc);
      } else {
        delete (Repo.transactions as unknown as Record<string, unknown>).schema;
      }
      whereSpy.mockRestore();
    }
  });

  it('localSwapOrders reads 1..64 completed swaps in a single read without calling core.count', async () => {
    const swaps = Array.from({ length: 5 }, (_, i) =>
      makeTx(`swap-${i}`, {
        type: 'swap',
        status: ITransactionStatus.Completed,
        extraInputs: { orderId: `order-${i}`, swapType: 'pswap' } as ITransaction['extraInputs']
      })
    );
    await Repo.transactions.bulkPut(swaps);

    const countSpy = jest.spyOn(Repo.transactions.core, 'count');
    const probe = installCoreReadProbe(Repo.transactions);
    try {
      const orders = await localSwapOrders('mtst1acct');
      expect(orders).toHaveLength(5);
      expect(countSpy).not.toHaveBeenCalled();
      expect(probe.cursorIndexes).toEqual(['[status+type]']);
    } finally {
      probe.restore();
      countSpy.mockRestore();
    }
  });

  it('countIndexEntriesUpTo chunks counts > 64 without core.count and yields for concurrent writes', async () => {
    await Repo.transactions.bulkPut(
      Array.from({ length: 150 }, (_, i) =>
        makeTx(`cnt-${i}`, {
          status: ITransactionStatus.Completed,
          type: 'send'
        })
      )
    );

    const countSpy = jest.spyOn(Repo.transactions.core, 'count');
    let writePromise: Promise<string> | undefined;
    let writeDone = false;
    const origOpenCursor = Repo.transactions.core.openCursor.bind(Repo.transactions.core);
    let cursorOpens = 0;
    Repo.transactions.core.openCursor = req => {
      cursorOpens += 1;
      if (!writePromise) {
        writePromise = Dexie.ignoreTransaction(() =>
          Repo.transactions.add(makeTx('cnt-concurrent', { status: ITransactionStatus.Queued, completedAt: undefined }))
        ).then(id => {
          writeDone = true;
          return id;
        });
      }
      return origOpenCursor(req);
    };

    try {
      const capped = await countIndexEntriesUpTo(
        Repo.transactions,
        '[status+type]',
        equalIndexSpec('[status+type]', [ITransactionStatus.Completed, 'send']).range,
        100
      );
      expect(capped).toBe(100);
      expect(countSpy).not.toHaveBeenCalled();
      expect(cursorOpens).toBe(2);
      expect(writePromise).toBeDefined();
      await writePromise;
      expect(writeDone).toBe(true);

      const fullCount = await countIndexEntriesUpTo(
        Repo.transactions,
        '[status+type]',
        equalIndexSpec('[status+type]', [ITransactionStatus.Completed, 'send']).range
      );
      expect(fullCount).toBe(150);
    } finally {
      Repo.transactions.core.openCursor = origOpenCursor;
      countSpy.mockRestore();
    }
  });

  it('compareIdbKeys orders binary and heterogeneous keys identically via dexieCmp when indexedDB is absent', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      expect(compareIdbKeys(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBeLessThan(0);
      expect(compareIdbKeys(new Uint8Array([1, 2]), 'abc')).toBeGreaterThan(0);
      expect(compareIdbKeys(new Date(100), 'abc')).toBeLessThan(0);
      expect(compareIdbKeys(5, new Date(100))).toBeLessThan(0);
    } finally {
      if (desc) {
        Object.defineProperty(globalThis, 'indexedDB', desc);
      } else {
        delete (globalThis as unknown as Record<string, unknown>).indexedDB;
      }
    }
  });

  it('get.ts query helpers work via centralized fallback on a toArray-only stripped mock without .where or .filter', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await Repo.transactions.bulkPut([
      makeTx('held-queued', {
        type: 'consume',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec - 5,
        completedAt: undefined,
        noteId: 'n1',
        noteIds: ['n1']
      }),
      makeTx('gen-row', {
        type: 'send',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: nowSec - 6,
        completedAt: undefined
      }),
      makeTx('failed-row', {
        type: 'send',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - 7,
        completedAt: undefined
      }),
      makeTx('unconf-row', {
        type: 'send',
        status: ITransactionStatus.Unconfirmed,
        initiatedAt: nowSec - 8,
        completedAt: undefined
      }),
      makeTx('restored-row', {
        type: 'send',
        status: ITransactionStatus.Completed,
        initiatedAt: nowSec - 20,
        completedAt: nowSec - 18,
        restoredFromBackup: true
      }),
      makeTx('held-recent', {
        type: 'execute',
        status: ITransactionStatus.Completed,
        initiatedAt: nowSec - 15,
        completedAt: nowSec - 10,
        heldNoteIds: ['n2']
      })
    ]);

    const origSchema = Object.getOwnPropertyDescriptor(Repo.transactions, 'schema');
    const origFilter = Object.getOwnPropertyDescriptor(Repo.transactions, 'filter');
    const whereSpy = jest.spyOn(Repo.transactions, 'where').mockImplementation((() => {
      throw new Error('must not call where on stripped mock');
    }) as never);
    Object.defineProperty(Repo.transactions, 'schema', { value: undefined, configurable: true });
    Object.defineProperty(Repo.transactions, 'filter', { value: undefined, configurable: true });
    try {
      const held = await getNoteHoldingTransactions('mtst1acct');
      expect(held.map(tx => tx.id)).toEqual(['held-recent', 'held-queued']);
      expect(await hasQueuedTransactions()).toBe(true);
      expect((await getUncompletedTransactions('mtst1acct')).map(tx => tx.id)).toEqual(['gen-row', 'held-queued']);
      expect((await getTransactionsInProgress()).map(tx => tx.id)).toEqual(['gen-row']);
      expect((await getAllUncompletedTransactions()).map(tx => tx.id)).toEqual(['gen-row', 'held-queued']);
      expect(await hasRestoredTransactionsOf('mtst1acct')).toBe(true);
      expect((await getFailedTransactions()).map(tx => tx.id)).toEqual(['failed-row']);
      expect((await getUnconfirmedTransactions()).map(tx => tx.id)).toEqual(['unconf-row']);
      expect((await getCompletedTransactions('mtst1acct')).map(tx => tx.id)).toEqual(['restored-row', 'held-recent']);
    } finally {
      if (origSchema) {
        Object.defineProperty(Repo.transactions, 'schema', origSchema);
      } else {
        delete (Repo.transactions as unknown as Record<string, unknown>).schema;
      }
      if (origFilter) {
        Object.defineProperty(Repo.transactions, 'filter', origFilter);
      } else {
        delete (Repo.transactions as unknown as Record<string, unknown>).filter;
      }
      whereSpy.mockRestore();
    }
  });

  it('getCompletedTransactionsPage resumes without duplicates across merge-to-positive chunk transitions', async () => {
    await withIsolatedTransactionsDb('page-merge-to-pos', async (_isolated, table) => {
      const rows: ITransaction[] = Array.from({ length: 80 }, (_, i) =>
        makeTx(`tx-${String(i).padStart(4, '0')}`, {
          accountId: 'mtst1acct',
          initiatedAt: 1_900_000_000 + i,
          completedAt: 1_700_000_000 + i
        })
      );
      rows.push(
        makeTx('anchor-page1', {
          accountId: 'mtst1acct',
          initiatedAt: 1_700_000_085,
          completedAt: 1_700_000_085
        }),
        makeTx('fallback-top', {
          accountId: 'mtst1acct',
          initiatedAt: 1_700_000_084,
          completedAt: undefined
        })
      );
      await table.bulkAdd(rows);

      const firstPage = await getCompletedTransactionsPage(
        { accountId: 'mtst1acct', limit: 1, includeFailed: true, fromEnd: true },
        table
      );
      expect(firstPage.transactions.map(tx => tx.id)).toEqual(['anchor-page1']);

      const page = await getCompletedTransactionsPage(
        { accountId: 'mtst1acct', limit: 75, includeFailed: true, cursor: firstPage.nextCursor },
        table
      );
      expect(page.transactions).toHaveLength(75);
      expect(new Set(page.transactions.map(tx => tx.id)).size).toBe(75);
      expect(page.transactions[0]?.id).toBe('fallback-top');
      expect(page.transactions[1]?.id).toBe('tx-0079');
      expect(page.transactions[74]?.id).toBe('tx-0006');
    });
  });

  it('getCompletedTransactionsPage does not drop completedAt:undefined rows on concurrent completion TOCTOU', async () => {
    for (const baseCount of [1, 80]) {
      await withIsolatedTransactionsDb(`page-toctou-${baseCount}`, async (isolated, table) => {
        const rows: ITransaction[] = Array.from({ length: baseCount }, (_, i) =>
          makeTx(`done-${String(i).padStart(4, '0')}`, {
            accountId: 'mtst1acct',
            initiatedAt: 1_700_000_000 + i,
            completedAt: 1_700_000_000 + i
          })
        );
        rows.push(
          makeTx('fallback-missing', {
            accountId: 'mtst1acct',
            status: ITransactionStatus.Completed,
            initiatedAt: 1_700_000_500,
            completedAt: undefined
          }),
          makeTx('completing-row', {
            accountId: 'mtst1acct',
            status: ITransactionStatus.Unconfirmed,
            initiatedAt: 1_700_000_050,
            completedAt: undefined
          })
        );
        await table.bulkAdd(rows);

        const core = table.core;
        const origCount = core.count.bind(core);
        const origOpenCursor = core.openCursor.bind(core);
        let sawNumericStart = false;
        let pendingCompletion: Promise<number> | undefined;
        let triggered = false;
        const fireBetweenTransactions = () => {
          if (triggered) return;
          triggered = true;
          pendingCompletion = Dexie.ignoreTransaction(() =>
            table.update('completing-row', {
              status: ITransactionStatus.Completed,
              completedAt: 1_700_000_600
            })
          );
        };
        const origTx = isolated.transaction.bind(isolated);
        const txSpy = jest.spyOn(isolated, 'transaction').mockImplementation(((...args: unknown[]) => {
          const txPromise = (origTx as (...a: unknown[]) => Promise<unknown>)(...args);
          return txPromise.then(async res => {
            if (sawNumericStart && pendingCompletion) {
              await pendingCompletion;
            }
            return res;
          });
        }) as typeof isolated.transaction);
        core.count = req =>
          origCount(req).then(count => {
            if (req.query.index.name === 'status') {
              sawNumericStart = true;
              fireBetweenTransactions();
            }
            return count;
          });
        core.openCursor = req => {
          if (req.values === false && req.query.index.name === 'status') {
            sawNumericStart = true;
            fireBetweenTransactions();
          }
          return origOpenCursor(req);
        };

        try {
          const page = await getCompletedTransactionsPage(
            { accountId: 'mtst1acct', limit: baseCount + 10, includeFailed: false, fromEnd: true },
            table
          );
          expect(page.transactions.map(tx => tx.id)).toContain('fallback-missing');
        } finally {
          txSpy.mockRestore();
          core.count = origCount;
          core.openCursor = origOpenCursor;
        }
      });
    }
  });

  it('getCompletedTransactionsPage seeks cross-page tied timestamps in O(log N) without rescanning earlier ties and without core.count', async () => {
    await withIsolatedTransactionsDb('page-cross-tie', async (_isolated, table) => {
      const tiedCompletedAt = 1_700_000_000;
      await table.bulkAdd(
        Array.from({ length: 200 }, (_, i) =>
          makeTx(`tx-${String(i).padStart(4, '0')}`, {
            accountId: 'mtst1acct',
            initiatedAt: tiedCompletedAt - 10,
            completedAt: tiedCompletedAt
          })
        )
      );

      let cursor: Awaited<ReturnType<typeof getCompletedTransactionsPage>>['nextCursor'] = null;
      for (let p = 0; p < 15; p += 1) {
        const res = await getCompletedTransactionsPage(
          cursor === null
            ? { accountId: 'mtst1acct', limit: 10, includeFailed: true, fromEnd: true }
            : { accountId: 'mtst1acct', limit: 10, includeFailed: true, cursor },
          table
        );
        cursor = res.nextCursor;
      }

      const countSpy = jest.spyOn(table.core, 'count');
      const probe = installCoreReadProbe(table);
      try {
        const page16 = await getCompletedTransactionsPage(
          { accountId: 'mtst1acct', limit: 10, includeFailed: true, cursor },
          table
        );
        expect(page16.transactions[0]?.id).toBe('tx-0049');
        expect(page16.transactions[9]?.id).toBe('tx-0040');
        expect(countSpy).not.toHaveBeenCalled();
        expect(probe.rowsRead).toBeLessThanOrEqual(25);
      } finally {
        probe.restore();
        countSpy.mockRestore();
      }
    });
  });

  it('getNoteHoldingTransactions avoids core.count and caps heldNoteIds cardinality probe at recentCompletedCount', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const bulk: ITransaction[] = [
      ...Array.from({ length: 120 }, (_, i) =>
        makeTx(`recent-send-${i}`, {
          initiatedAt: nowSec - 20,
          completedAt: nowSec - 10
        })
      ),
      ...Array.from({ length: 250 }, (_, i) =>
        makeTx(`old-held-${i}`, {
          type: 'execute',
          status: ITransactionStatus.Completed,
          initiatedAt: nowSec - 5_000 - i,
          completedAt: nowSec - 4_000 - i,
          heldNoteIds: [`n-a-${i}`, `n-b-${i}`]
        })
      )
    ];
    await Repo.transactions.bulkPut(bulk);

    const countSpy = jest.spyOn(Repo.transactions.core, 'count');
    let heldCursorSteps = 0;
    const origOpenCursor = Repo.transactions.core.openCursor.bind(Repo.transactions.core);
    Repo.transactions.core.openCursor = req =>
      origOpenCursor(req).then(cursor => {
        if (cursor === null || req.values !== false || req.query.index.name !== 'heldNoteIds') return cursor;
        heldCursorSteps += 1;
        const origStart = cursor.start;
        cursor.start = cb =>
          origStart.call(cursor, () => {
            if (!cursor.done) heldCursorSteps += 1;
            cb();
          });
        return cursor;
      });
    try {
      await getNoteHoldingTransactions('mtst1acct');
      expect(countSpy).not.toHaveBeenCalled();
      expect(heldCursorSteps).toBeLessThanOrEqual(130);
    } finally {
      Repo.transactions.core.openCursor = origOpenCursor;
      countSpy.mockRestore();
    }
  });

  it('getCompletedTransactionsPage seeks tied negative and fallback timestamps in O(log N) across pages', async () => {
    for (const mode of ['negative', 'fallback'] as const) {
      await withIsolatedTransactionsDb(`page-tie-${mode}`, async (_isolated, table) => {
        await table.bulkAdd(
          Array.from({ length: 100 }, (_, i) =>
            makeTx(`tx-${String(i).padStart(4, '0')}`, {
              accountId: 'mtst1acct',
              initiatedAt: mode === 'fallback' ? 1_700_000_000 : 100,
              completedAt: mode === 'negative' ? -100 : undefined
            })
          )
        );

        let cursor: Awaited<ReturnType<typeof getCompletedTransactionsPage>>['nextCursor'] = null;
        for (let p = 0; p < 7; p += 1) {
          const res = await getCompletedTransactionsPage(
            cursor === null
              ? { accountId: 'mtst1acct', limit: 10, includeFailed: true, fromEnd: true }
              : { accountId: 'mtst1acct', limit: 10, includeFailed: true, cursor },
            table
          );
          cursor = res.nextCursor;
        }

        const probe = installCoreReadProbe(table);
        try {
          const page8 = await getCompletedTransactionsPage(
            { accountId: 'mtst1acct', limit: 10, includeFailed: true, cursor },
            table
          );
          expect(page8.transactions[0]?.id).toBe('tx-0029');
          expect(page8.transactions[9]?.id).toBe('tx-0020');
          expect(probe.rowsRead).toBeLessThanOrEqual(25);
        } finally {
          probe.restore();
        }
      });
    }
  }, 15_000);

  it('detectActiveHistoryStreams probes Failed before Completed so a Failed fallback row short-circuits Completed probes, and honors outer transactions', async () => {
    await withIsolatedTransactionsDb('page-order-outer', async (isolated, table) => {
      await table.bulkAdd([
        ...Array.from({ length: 70 }, (_, i) =>
          makeTx(`done-${i}`, {
            accountId: 'mtst1acct',
            status: ITransactionStatus.Completed,
            initiatedAt: 1_700_000_000 + i,
            completedAt: 1_700_000_000 + i
          })
        ),
        makeTx('fail-zero', {
          accountId: 'mtst1acct',
          status: ITransactionStatus.Failed,
          initiatedAt: 1_700_000_500,
          completedAt: 0
        })
      ]);

      const probedStatuses: unknown[] = [];
      const origQuery = table.core.query.bind(table.core);
      table.core.query = req => {
        if (req.values === false && req.query.index.name === 'status') {
          probedStatuses.push(req.query.range.lower);
        }
        return origQuery(req);
      };
      try {
        const page = await getCompletedTransactionsPage(
          { accountId: 'mtst1acct', limit: 5, includeFailed: true, fromEnd: true },
          table
        );
        expect(page.transactions[0]?.id).toBe('fail-zero');
        expect(probedStatuses).toEqual([ITransactionStatus.Failed]);
      } finally {
        table.core.query = origQuery;
      }

      await table.delete('fail-zero');
      const probe = installCoreReadProbe(table);
      try {
        const page = await isolated.transaction('r', table, () =>
          getCompletedTransactionsPage({ accountId: 'mtst1acct', limit: 5, includeFailed: false, fromEnd: true }, table)
        );
        expect(page.transactions).toHaveLength(5);
        expect(probe.cursorIndexes).not.toContain('initiatedAt');
      } finally {
        probe.restore();
      }
    });
  });
});
