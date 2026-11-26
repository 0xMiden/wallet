import Dexie, { type DBCoreCursor } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { localSwapOrders } from 'lib/miden/swap/classification';

import {
  getAllUncompletedTransactions,
  getCompletedTransactionsPage,
  getFailedTransactions,
  getNoteHoldingTransactions,
  getTransactionsInProgress,
  getUncompletedTransactions,
  getUnconfirmedTransactions,
  hasQueuedTransactions,
  hasRestoredTransactionsOf
} from './get';
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
  cursorCalls: number;
  cursorIndexes: string[];
  restore: () => void;
}

function installCoreReadProbe(
  table: Dexie.Table<ITransaction, string>,
  onReadOp?: (probe: TableReadProbe, indexName: string) => void
): TableReadProbe {
  const core = table.core;
  const origQuery = core.query.bind(core);
  const origOpenCursor = core.openCursor.bind(core);
  const origGet = core.get.bind(core);
  const origGetMany = core.getMany.bind(core);

  const probe: TableReadProbe = {
    rowsRead: 0,
    cursorCalls: 0,
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
      probe.cursorCalls += 1;
      onReadOp?.(probe, indexName);
    }
    return origQuery(req).then(res => {
      if (req.values) probe.rowsRead += res.result.length;
      return res;
    });
  };

  core.openCursor = req => {
    const indexName = req.query.index.name ?? '';
    probe.cursorCalls += 1;
    probe.cursorIndexes.push(indexName);
    onReadOp?.(probe, indexName);
    return origOpenCursor(req).then((cursor: DBCoreCursor | null) => {
      if (cursor === null) return null;
      probe.rowsRead += 1;
      let currentCounted = true;
      const origStart = cursor.start;
      cursor.start = function (callback) {
        return origStart.call(this, () => {
          if (!this.done && !currentCounted) {
            probe.rowsRead += 1;
            currentCounted = true;
          }
          if (!Reflect.get(this.continue, '__probed')) {
            const origContinue = this.continue;
            const wrappedContinue = (...args: Parameters<typeof origContinue>) => {
              currentCounted = false;
              return origContinue.apply(this, args);
            };
            Reflect.set(wrappedContinue, '__probed', true);
            this.continue = wrappedContinue;
          }
          if (this.continuePrimaryKey && !Reflect.get(this.continuePrimaryKey, '__probed')) {
            const origContinuePk = this.continuePrimaryKey;
            const wrappedContinuePk = (...args: Parameters<typeof origContinuePk>) => {
              currentCounted = false;
              return origContinuePk.apply(this, args);
            };
            Reflect.set(wrappedContinuePk, '__probed', true);
            this.continuePrimaryKey = wrappedContinuePk;
          }
          if (!Reflect.get(this.advance, '__probed')) {
            const origAdvance = this.advance;
            const wrappedAdvance = (...args: Parameters<typeof origAdvance>) => {
              currentCounted = false;
              return origAdvance.apply(this, args);
            };
            Reflect.set(wrappedAdvance, '__probed', true);
            this.advance = wrappedAdvance;
          }
          callback();
        });
      };
      return cursor;
    });
  };

  return probe;
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

    let writePromise: Promise<string> | undefined;
    let writeDone = false;
    let cursorCallsAfterWriteDone = 0;

    const probe = installCoreReadProbe(Repo.transactions, () => {
      if (writeDone) {
        cursorCallsAfterWriteDone += 1;
        return;
      }
      if (!writePromise) {
        writePromise = Dexie.ignoreTransaction(() =>
          Repo.transactions.add(
            makeTx('concurrent-write', {
              type: 'send',
              status: ITransactionStatus.Queued,
              initiatedAt: nowSec + 1,
              completedAt: undefined
            })
          )
        ).then(id => {
          writeDone = true;
          return id;
        });
      }
    });

    try {
      const held = await getNoteHoldingTransactions('mtst1acct');
      expect(held.map(tx => tx.id)).toEqual(['live-consume']);
      expect(writePromise).toBeDefined();
      await writePromise;
      expect(writeDone).toBe(true);
      expect(cursorCallsAfterWriteDone).toBeGreaterThan(0);
    } finally {
      probe.restore();
    }
  });

  it('getCompletedTransactionsPage skips initiatedAt fallback scan when all terminal rows have nonzero completedAt', async () => {
    const name = `page-skip-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolated = Repo.createSchemaFor(name);
    try {
      await isolated.open();
      const table = isolated.table<ITransaction, string>(Repo.Table.Transactions);
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
    } finally {
      isolated.close();
      await Dexie.delete(name);
    }
  });

  it('getCompletedTransactionsPage chunks large tied-timestamp reads so concurrent writes commit mid-page without O(N^2) rescan', async () => {
    const name = `page-chunked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolated = Repo.createSchemaFor(name);
    try {
      await isolated.open();
      const table = isolated.table<ITransaction, string>(Repo.Table.Transactions);
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

      let writePromise: Promise<string> | undefined;
      let writeDone = false;
      let cursorCallsAfterWriteDone = 0;

      const probe = installCoreReadProbe(table, () => {
        if (writeDone) {
          cursorCallsAfterWriteDone += 1;
          return;
        }
        if (!writePromise) {
          writePromise = Dexie.ignoreTransaction(() =>
            table.add(
              makeTx('tx-concurrent-new', {
                accountId: 'mtst1acct',
                initiatedAt: tiedCompletedAt + 5,
                completedAt: tiedCompletedAt + 5
              })
            )
          ).then(id => {
            writeDone = true;
            return id;
          });
        }
      });

      try {
        const page = await getCompletedTransactionsPage(
          { accountId: 'mtst1acct', limit: 350, includeFailed: true, fromEnd: true },
          table
        );
        expect(page.transactions).toHaveLength(350);
        expect(page.rawCount).toBe(350);
        expect(page.hasMore).toBe(true);
        expect(new Set(page.transactions.map(tx => tx.id)).size).toBe(350);
        expect(page.transactions[0]?.id).toBe('tx-0499');
        expect(page.transactions[349]?.id).toBe('tx-0150');

        expect(readTxCount).toBeGreaterThan(1);
        expect(writePromise).toBeDefined();
        await writePromise;
        expect(writeDone).toBe(true);
        expect(cursorCallsAfterWriteDone).toBeGreaterThan(0);
        // O(log N) primary-key cursor resume avoids quadratic rescanning of tied timestamps.
        expect(probe.rowsRead).toBeLessThan(400);
      } finally {
        probe.restore();
        txSpy.mockRestore();
      }
    } finally {
      isolated.close();
      await Dexie.delete(name);
    }
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

    let writePromise: Promise<string> | undefined;
    let writeDone = false;
    let cursorCallsAfterWriteDone = 0;

    const probe = installCoreReadProbe(Repo.transactions, () => {
      if (writeDone) {
        cursorCallsAfterWriteDone += 1;
        return;
      }
      if (!writePromise) {
        writePromise = Dexie.ignoreTransaction(() =>
          Repo.transactions.add(
            makeTx('concurrent-restored-check', {
              accountId: 'mtst1other',
              restoredFromBackup: false
            })
          )
        ).then(id => {
          writeDone = true;
          return id;
        });
      }
    });

    try {
      expect(await hasRestoredTransactionsOf('mtst1acct')).toBe(false);
      expect(writePromise).toBeDefined();
      await writePromise;
      expect(writeDone).toBe(true);
      expect(cursorCallsAfterWriteDone).toBeGreaterThan(0);
    } finally {
      probe.restore();
    }
  });

  it('getCompletedTransactionsPage chunks the merge stream when an initiatedAt fallback row exists without drops or duplicates', async () => {
    const name = `page-merge-chunked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolated = Repo.createSchemaFor(name);
    try {
      await isolated.open();
      const table = isolated.table<ITransaction, string>(Repo.Table.Transactions);
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

      let writePromise: Promise<string> | undefined;
      let writeDone = false;
      let cursorCallsAfterWriteDone = 0;

      const probe = installCoreReadProbe(table, () => {
        if (writeDone) {
          cursorCallsAfterWriteDone += 1;
          return;
        }
        if (!writePromise) {
          writePromise = Dexie.ignoreTransaction(() =>
            table.add(
              makeTx('tx-concurrent-merge', {
                accountId: 'mtst1acct',
                initiatedAt: tiedCompletedAt + 10,
                completedAt: tiedCompletedAt + 10
              })
            )
          ).then(id => {
            writeDone = true;
            return id;
          });
        }
      });

      try {
        const page = await getCompletedTransactionsPage(
          { accountId: 'mtst1acct', limit: 200, includeFailed: true, fromEnd: true },
          table
        );
        expect(page.transactions).toHaveLength(200);
        expect(page.hasMore).toBe(true);
        expect(new Set(page.transactions.map(tx => tx.id)).size).toBe(200);
        expect(page.transactions[0]?.id).toBe('fallback-missing-completed');
        expect(page.transactions[1]?.id).toBe('tx-0259');
        expect(page.transactions[199]?.id).toBe('tx-0061');
        expect(writePromise).toBeDefined();
        await writePromise;
        expect(writeDone).toBe(true);
        expect(cursorCallsAfterWriteDone).toBeGreaterThan(0);
      } finally {
        probe.restore();
      }
    } finally {
      isolated.close();
      await Dexie.delete(name);
    }
  });
});
