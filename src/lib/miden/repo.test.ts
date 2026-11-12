import Dexie, { DBCore, DBCoreCursor, DBCoreMutateResponse, DBCoreTable, Middleware } from 'dexie';
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb';

import { deriveSwapReceipt } from 'app/templates/history/swapReceipt';
import {
  annotateCrash,
  snapshotCrashDiagnostics,
  StorageOperation,
  StorageOwner
} from 'lib/telemetry/crash-diagnostics';

import { compareAccountIds } from './activity/utils';
import { ISwapExtraInputs, ITransaction, ITransactionStatus } from './db/types';
import {
  createSchemaFor,
  db,
  exportDb,
  importDb,
  spendingLimits,
  transactions,
  Table,
  TRANSACTIONS_V17_STORE,
  TRANSACTIONS_V2_STORE,
  SPENDING_LIMITS_V17_STORE,
  SPENDING_LIMITS_V19_STORE
} from './repo';
import { isOpenRecoveredOrder, isRecoveredReturnOrder, recoveredSwapOrderRef } from './swap/recovered-order';
import { getCompletedTransactionsPage } from './transaction/get';
import { isRequeueableTransaction } from './transaction/retry';
import { NoteTypeEnum } from './types';

describe('miden repo export/import', () => {
  beforeEach(async () => {
    await transactions.clear();
  });

  it('exports transactions with serializable fields and imports them back', async () => {
    await transactions.bulkAdd([
      {
        id: '1',
        type: 'send',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        transactionId: 'tx1',
        initiatedAt: Math.floor(Date.now() / 1000),
        completedAt: Math.floor(Date.now() / 1000),
        amount: BigInt(42),
        requestBytes: new Uint8Array([1, 2, 3]),
        displayIcon: 'SEND'
      }
    ]);

    const dump = await exportDb();
    const parsed = JSON.parse(dump);
    expect(parsed[Table.Transactions][0].amount).toBe('42');
    expect(parsed[Table.Transactions][0].requestBytes).toEqual([1, 2, 3]);

    await importDb(dump);

    const imported = await transactions.toArray();
    expect(imported).toHaveLength(1);
    expect(imported[0]!.amount).toBe(BigInt(42));
    expect(imported[0]!.requestBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  // Field-by-field assertions only prove the fields somebody thought to name.
  // The walker's job is to preserve the WHOLE row, so this asserts identity —
  // it fails if any future change drops or reshapes a field nobody listed here.
  it('restores a maximal row identical to the one exported', async () => {
    const original = {
      id: 'max-1',
      type: 'swap' as const,
      status: ITransactionStatus.Completed,
      accountId: 'acc1',
      secondaryAccountId: 'acc2',
      transactionId: 'tx-max',
      initiatedAt: 11,
      completedAt: 22,
      amount: BigInt('123456789012345678901234567890'),
      faucetId: 'faucet-a',
      noteId: 'note-1',
      noteIds: ['note-1', 'note-2'],
      outputNoteIds: ['out-1'],
      noteType: NoteTypeEnum.Private,
      displayIcon: 'SWAP' as const,
      displayMessage: 'a message',
      errorMessage: '',
      requestBytes: new Uint8Array([0, 255, 7]),
      assetTotals: [{ faucetId: 'faucet-b', amount: BigInt(0) }],
      extraInputs: {
        requestedFaucetId: 'faucet-c',
        requestedAmount: BigInt(-5),
        orderId: BigInt(99),
        nested: { deep: [BigInt(1), 'two', 3, true, null] }
      }
    };
    await transactions.bulkAdd([original]);

    await importDb(await exportDb());

    const [restored] = await transactions.toArray();
    // The provenance stamp is the ONLY thing import adds to a terminal row —
    // asserting the whole object is what proves nothing else was rewritten.
    expect(restored).toEqual({ ...original, restoredFromBackup: true });
  });

  // A row carries BigInt in more places than the top-level `amount`: `assetTotals`
  // on a batch claim, `extraInputs.requestedAmount` on a swap. Hand-listing the
  // fields to convert meant any of those threw "Do not know how to serialize a
  // BigInt" out of `exportDb`, which the export screen reports as success while
  // writing no file — so the round trip is asserted over the nested ones too.
  it('round-trips BigInt nested in assetTotals and extraInputs', async () => {
    await transactions.bulkAdd([
      {
        id: 'consume-1',
        type: 'consume',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        initiatedAt: 1,
        amount: BigInt(20),
        faucetId: 'faucet-a',
        assetTotals: [
          { faucetId: 'faucet-a', amount: BigInt(20) },
          { faucetId: 'faucet-b', amount: BigInt(10) }
        ],
        displayIcon: 'RECEIVE'
      },
      {
        id: 'swap-1',
        type: 'swap',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        initiatedAt: 2,
        amount: BigInt(5),
        extraInputs: { requestedFaucetId: 'faucet-b', requestedAmount: BigInt(7), orderId: BigInt(9) },
        displayIcon: 'SEND'
      }
    ]);

    const dump = await exportDb();
    await importDb(dump);

    const imported = await transactions.toArray();
    const consume = imported.find(tx => tx.id === 'consume-1');
    expect(consume?.assetTotals).toEqual([
      { faucetId: 'faucet-a', amount: BigInt(20) },
      { faucetId: 'faucet-b', amount: BigInt(10) }
    ]);
    expect(consume?.amount).toBe(BigInt(20));

    const swap = imported.find(tx => tx.id === 'swap-1');
    expect(swap?.type === 'swap' && swap.extraInputs?.requestedAmount).toBe(BigInt(7));
    expect(swap?.type === 'swap' && swap.extraInputs?.orderId).toBe(BigInt(9));
  });

  it('round-trips resultBytes, which the previous format could not', async () => {
    await transactions.bulkAdd([
      {
        id: 'result-1',
        type: 'send',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        initiatedAt: 4,
        resultBytes: new Uint8Array([9, 8, 7]),
        displayIcon: 'SEND'
      }
    ]);

    await importDb(await exportDb());

    const imported = await transactions.toArray();
    expect(imported[0]!.resultBytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  // `amount` is written as a plain string (readable by builds that predate the
  // BigInt tag) and byte fields as untagged number arrays; both import by name.
  it('imports a dump whose amount and byte fields are untagged', async () => {
    await importDb(
      JSON.stringify({
        [Table.Transactions]: [
          {
            id: 'untagged-1',
            type: 'send',
            status: ITransactionStatus.Completed,
            accountId: 'acc1',
            initiatedAt: 3,
            amount: '42',
            requestBytes: [1, 2, 3],
            resultBytes: [9, 8, 7],
            displayIcon: 'SEND'
          }
        ]
      })
    );

    const imported = await transactions.toArray();
    expect(imported[0]!.amount).toBe(BigInt(42));
    expect(imported[0]!.requestBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(imported[0]!.resultBytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  // A byte field holds a cryptographic blob. `new Uint8Array(...)` accepts every
  // one of these inputs and quietly stores something else — 999 as 231, -1 as
  // 255, a string as 0 — which is a different blob, and nothing downstream can
  // tell. `importDb` is atomic, so failing here costs the user nothing.
  describe('a byte field that is not bytes', () => {
    const dumpWith = (fields: Record<string, unknown>) =>
      JSON.stringify({
        [Table.Transactions]: [
          {
            id: 'bad-bytes',
            type: 'send',
            status: ITransactionStatus.Completed,
            accountId: 'acc1',
            initiatedAt: 3,
            displayIcon: 'SEND',
            ...fields
          }
        ]
      });

    it.each([
      ['a value above 255', { requestBytes: [1, 999, 3] }],
      ['a negative value', { requestBytes: [1, -1, 3] }],
      ['a fractional value', { requestBytes: [1, 1.5, 3] }],
      ['a non-number', { requestBytes: [1, 'two', 3] }]
    ])('is rejected rather than truncated: %s', async (_label, fields) => {
      await expect(importDb(dumpWith(fields))).rejects.toThrow(/is not a byte/);
    });

    it.each([
      ['an index-keyed resultBytes', { resultBytes: { '0': 9, '1': 8 } }],
      ['an empty object', { resultBytes: {} }],
      ['an index-keyed requestBytes', { requestBytes: { '0': 1 } }]
    ])('is rejected rather than stored as a plain object: %s', async (_label, fields) => {
      await expect(importDb(dumpWith(fields))).rejects.toThrow(/is not a byte array/);
    });
  });

  // `$bigint` is a reserved word in a namespace the wallet does not own:
  // `extraInputs` carries objects a dApp had a hand in. Without escaping, such an
  // object came back from a round-trip as a number instead of itself — and when
  // its string was not numeric, `BigInt()` threw and took the whole import down.
  describe('data that looks like the BigInt tag', () => {
    const roundTrip = async (extraInputs: unknown) => {
      await transactions.clear();
      await transactions.bulkAdd([
        {
          id: 'collide',
          type: 'send',
          status: ITransactionStatus.Completed,
          accountId: 'acc1',
          initiatedAt: 3,
          displayIcon: 'SEND',
          extraInputs
        } as unknown as ITransaction
      ]);
      const dump = await exportDb();
      await importDb(dump);
      return (await transactions.toArray())[0]!.extraInputs;
    };

    it.each([
      ['a non-numeric string', { $bigint: 'not a number' }],
      ['a numeric string, indistinguishable from a real tag', { $bigint: '123' }],
      ['an already-escaped-looking key', { $bigint$: 'x' }],
      ['nested inside another object', { note: { $bigint: '7' } }]
    ])('survives a round-trip unchanged: %s', async (_label, extraInputs) => {
      expect(await roundTrip(extraInputs)).toEqual(extraInputs);
    });

    it('still restores a real BigInt written by the exporter', async () => {
      expect(await roundTrip({ requestedAmount: 5n })).toEqual({ requestedAmount: 5n });
    });

    // A tag whose payload is not a canonical integer was never written by this
    // code, so it is foreign data — and feeding it to `BigInt()` threw.
    it('leaves a foreign tag alone rather than throwing on import', async () => {
      await importDb(
        JSON.stringify({
          [Table.Transactions]: [
            {
              id: 'foreign-tag',
              type: 'send',
              status: ITransactionStatus.Completed,
              accountId: 'acc1',
              initiatedAt: 3,
              displayIcon: 'SEND',
              extraInputs: { $bigint: 'not a number' }
            }
          ]
        })
      );

      expect((await transactions.toArray())[0]!.extraInputs).toEqual({ $bigint: 'not a number' });
    });
  });

  // A malformed dump must fail in the pure mapping step, which runs before the
  // existing database is dropped — not later, inside `bulkAdd`.
  it('rejects a dump nested past the walk limit before touching the database', async () => {
    await transactions.bulkAdd([
      {
        id: 'survivor',
        type: 'send',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        initiatedAt: 5,
        displayIcon: 'SEND'
      }
    ]);

    let nested: unknown = 'deep';
    for (let i = 0; i < 200; i++) nested = [nested];

    await expect(
      importDb(JSON.stringify({ [Table.Transactions]: [{ id: 'bad', extraInputs: nested }] }))
    ).rejects.toThrow(/nested too deeply/);

    const survivors = await transactions.toArray();
    expect(survivors.map(tx => tx.id)).toEqual(['survivor']);
  });

  // The depth guard above only covers dumps that fail during the WALK. A dump can
  // also parse and map cleanly and still be rejected by the write itself -- two
  // rows sharing a primary key is enough. Importing used to `db.delete()` before
  // writing anything, so that rejection destroyed the user's history and left
  // nothing to restore from; the replacement has to be atomic.
  it('keeps existing history when the import write itself fails', async () => {
    await transactions.bulkAdd([
      {
        id: 'survivor',
        type: 'send',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        initiatedAt: 5,
        amount: BigInt(1),
        displayIcon: 'SEND'
      }
    ]);

    const duplicateIdDump = JSON.stringify({
      [Table.Transactions]: [
        { id: 'dup', type: 'send', status: ITransactionStatus.Completed, accountId: 'a', initiatedAt: 1 },
        { id: 'dup', type: 'send', status: ITransactionStatus.Completed, accountId: 'a', initiatedAt: 2 }
      ]
    });

    await expect(importDb(duplicateIdDump)).rejects.toThrow();

    const survivors = await transactions.toArray();
    expect(survivors.map(tx => tx.id)).toEqual(['survivor']);
    expect(survivors[0]!.amount).toBe(BigInt(1));
  });

  // `safeGenerateTransactionsLoop` drives EVERY queued row through the signer
  // without asking where it came from, so a queued row in a dump is not history
  // -- it is an instruction to sign. A tampered backup must not be able to
  // spend, and an honest one's stale queued row must not fire either.
  it.each([
    ['Queued', ITransactionStatus.Queued],
    ['GeneratingTransaction', ITransactionStatus.GeneratingTransaction]
  ])('lands an imported %s row in a terminal state', async (_label, status) => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        {
          id: 'injected',
          type: 'send',
          status,
          accountId: 'victim',
          secondaryAccountId: 'attacker',
          initiatedAt: 1,
          amount: '999999',
          displayIcon: 'SEND'
        }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.status).toBe(ITransactionStatus.Failed);
    // Failed alone is not inert: `isRequeueableTransaction` offers a one-tap
    // Retry on a failed send, which re-signs it. The flag is what blocks that.
    expect(restored!.restoredFromBackup).toBe(true);
    expect(isRequeueableTransaction(restored!)).toBe(false);
    // Failing a row moves it onto the completed-history path, which reads
    // `completedAt` as the timestamp and builds a Date from it with no fallback.
    expect(restored!.completedAt).toBe(1);
    // The row survives as a record -- only its ability to execute is removed.
    expect(restored!.id).toBe('injected');
    expect(restored!.amount).toBe(BigInt(999999));
  });

  // Asserted on the DUMP, not on a re-import: import re-stamps the flag, so a
  // round-trip check passes even when the export drops it. Re-exporting a
  // restored wallet must keep the provenance rather than laundering it.
  it('carries restoredFromBackup through export', async () => {
    await transactions.bulkAdd([
      {
        id: 'imported',
        type: 'send',
        status: ITransactionStatus.Failed,
        accountId: 'acc1',
        initiatedAt: 5,
        restoredFromBackup: true,
        displayIcon: 'SEND'
      }
    ]);

    const dumped = JSON.parse(await exportDb());
    expect(dumped[Table.Transactions][0].restoredFromBackup).toBe(true);
  });

  // The flag is stamped by a literal AFTER the spread. Reversing those two
  // clauses hands the attacker control of the gate, and every other test here
  // passes either way because none of their dumps mention the field.
  it('ignores a restoredFromBackup the dump tries to supply', async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        {
          id: 'liar',
          type: 'send',
          status: ITransactionStatus.Failed,
          restoredFromBackup: false,
          accountId: 'victim',
          initiatedAt: 1
        }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.restoredFromBackup).toBe(true);
    expect(isRequeueableTransaction(restored!)).toBe(false);
  });

  // A backup must not record which dApps the user used, and a restored row is never waitable by one (#1416). Asserted
  // on the dump itself: import drops the field too, so a round trip passes even when the export keeps it.
  it('leaves dappOrigins out of the dump', async () => {
    await transactions.bulkAdd([
      {
        id: 'dapp-row',
        type: 'send',
        status: ITransactionStatus.Completed,
        accountId: 'acc1',
        initiatedAt: 5,
        completedAt: 6,
        displayIcon: 'SEND',
        dappOrigins: ['https://dapp.example']
      }
    ]);

    const [dumped] = JSON.parse(await exportDb())[Table.Transactions];
    expect(dumped.id).toBe('dapp-row');
    expect(dumped).not.toHaveProperty('dappOrigins');
  });

  it('drops a dappOrigins the dump supplies', async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        {
          id: 'planted',
          type: 'send',
          status: ITransactionStatus.Completed,
          accountId: 'acc1',
          initiatedAt: 1,
          completedAt: 2,
          displayIcon: 'SEND',
          dappOrigins: ['https://dapp.example']
        }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.restoredFromBackup).toBe(true);
    expect(restored).not.toHaveProperty('dappOrigins');
  });

  // On a Guardian-recovered order the Cancel stamp is the permission settlement acts on to return the order, and only
  // this wallet's own Cancel may give it (#1487). A restored row's stamp is read nowhere else.
  it("drops a dump's swap Cancel stamp and keeps the rest of the order", async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        {
          id: 'local-order',
          type: 'swap',
          status: ITransactionStatus.Completed,
          accountId: 'acc1',
          initiatedAt: 1,
          completedAt: 2,
          displayIcon: 'DEFAULT',
          extraInputs: { orderId: '42', autoConsume: true, expiresAt: 150, expiryTriggeredAt: 150 }
        }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.extraInputs).toEqual({ orderId: '42', autoConsume: true, expiresAt: 150 });
  });

  const recoveredOrderRow = (extraInputs: Partial<ISwapExtraInputs>): ITransaction => ({
    id: 'recovered-order',
    type: 'swap',
    status: ITransactionStatus.Completed,
    accountId: 'acc1',
    initiatedAt: 1,
    completedAt: 2,
    displayIcon: 'DEFAULT',
    amount: 70n,
    outputNoteIds: ['order-note'],
    restoredFromBackup: true,
    recovered: true,
    recovery: {
      version: 5,
      network: 'testnet',
      operators: [],
      nonce: 2,
      inputNotes: [],
      outputNotes: [
        {
          id: 'order-note',
          assets: [],
          visibility: 'public',
          swap: { orderId: '42', requestedAsset: { faucetId: 'requested', amount: '30' } }
        }
      ],
      completeness: 'decoded',
      reclaimed: false
    },
    extraInputs: {
      orderId: '42',
      requestedFaucetId: 'requested',
      requestedAmount: 30n,
      autoConsume: false,
      ...extraInputs
    }
  });

  // A backup cut between a recovered order's Cancel and its reclaim carries the stamp and the expiry that Cancel
  // moved to the press (recovery writes none). Dropping only the stamp left the expiry lapsed, so the importing device
  // showed the return as pending, offered no Cancel and never acted on it. The import returns the order to open.
  it('imports a cancelled recovered order open again, with Cancel on offer', async () => {
    const recoveredOrder = recoveredOrderRow({
      expiresAt: 150,
      expiryTriggeredAt: 150,
      recoveredTip: { noteId: 'remainder-note', depth: 1, remainingOffered: 20n }
    });
    await transactions.bulkAdd([recoveredOrder]);
    const backup = await exportDb();
    await transactions.clear();

    await importDb(backup);

    const [restored] = await transactions.toArray();
    expect(restored!.extraInputs).toEqual({
      orderId: '42',
      requestedFaucetId: 'requested',
      requestedAmount: 30n,
      autoConsume: false
    });
    expect(isOpenRecoveredOrder(restored!)).toBe(true);
    expect(isRecoveredReturnOrder(restored!)).toBe(false);
    const receipt = deriveSwapReceipt({
      requestedAmount: 30n,
      tracking: { orderId: '42', state: 'active', currentDepth: 0, remainingOffered: 70n, remainingRequested: 30n },
      settlement: null,
      autoConsume: false,
      recovered: true,
      expiresAt: restored!.extraInputs.expiresAt ?? null
    });
    expect(receipt.offerCancel).toBe(true);
  });

  it('imports a recovered order without its recorded lineage checkpoint', async () => {
    await transactions.bulkAdd([
      recoveredOrderRow({ recoveredCheckpoint: { noteId: 'spent-remainder-16', depth: 16 } })
    ]);
    const backup = await exportDb();
    await transactions.clear();

    await importDb(backup);

    const [restored] = await transactions.toArray();
    expect(restored!.extraInputs?.recoveredCheckpoint).toBeUndefined();
    expect(recoveredSwapOrderRef(restored!)).toEqual(expect.objectContaining({ tipNoteId: 'order-note', tipDepth: 0 }));
  });

  // `lineageClosedAt` is what makes a recovered order's closure final, so a backup carrying it closed an order its node
  // may still hold open, with no read of the node (#1487).
  it('imports a recovered order without its lineage close record, tracked until its next read', async () => {
    await transactions.bulkAdd([recoveredOrderRow({ settledAt: 160, lineageClosedAt: 160 })]);
    const backup = await exportDb();
    await transactions.clear();

    await importDb(backup);

    const [restored] = await transactions.toArray();
    expect(restored!.extraInputs).toEqual({
      orderId: '42',
      requestedFaucetId: 'requested',
      requestedAmount: 30n,
      autoConsume: false,
      settledAt: 160
    });
    expect(recoveredSwapOrderRef(restored!)).toEqual(
      expect.objectContaining({ txId: 'recovered-order', provisionalClosure: true })
    );
  });

  // A spent order note closes a recovered order as finally as `lineageClosedAt` does, so it is dropped with it (#1487).
  it('imports a recovered order without its spent-note close, tracked until its next read', async () => {
    await transactions.bulkAdd([recoveredOrderRow({ orderNoteSpentAt: 160, lineageClosedAt: 160 })]);
    const backup = await exportDb();
    await transactions.clear();

    await importDb(backup);

    const [restored] = await transactions.toArray();
    expect(restored!.extraInputs).toEqual({
      orderId: '42',
      requestedFaucetId: 'requested',
      requestedAmount: 30n,
      autoConsume: false
    });
    expect(recoveredSwapOrderRef(restored!)).toEqual(expect.objectContaining({ txId: 'recovered-order' }));
  });

  it('keeps the expiry of a restored swap that recovery did not rebuild', async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        {
          id: 'file-order',
          type: 'swap',
          status: ITransactionStatus.Completed,
          accountId: 'acc1',
          initiatedAt: 1,
          completedAt: 2,
          displayIcon: 'DEFAULT',
          extraInputs: {
            orderId: '42',
            expiresAt: 150,
            settledAt: 160,
            lineageClosedAt: 160,
            recoveredTip: { noteId: 'kept', depth: 1 }
          }
        }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.extraInputs).toEqual({
      orderId: '42',
      expiresAt: 150,
      settledAt: 160,
      lineageClosedAt: 160,
      recoveredTip: { noteId: 'kept', depth: 1 }
    });
  });

  // The status test is an allow-list of the terminal values, so a dump is free
  // to carry a status no consumer recognises. Such a row is invisible in every
  // history view (all of them compare with `===`) while still holding its id.
  it.each([
    ['out of range', 99],
    ['a string', '0'],
    ['absent', undefined]
  ])('treats a status that is %s as unfinished', async (_label, status) => {
    const dump = JSON.stringify({
      [Table.Transactions]: [{ id: 'odd', type: 'send', status, accountId: 'a', initiatedAt: 7 }]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.status).toBe(ITransactionStatus.Failed);
    expect(restored!.completedAt).toBe(7);
    expect(restored!.restoredFromBackup).toBe(true);
  });

  const importOne = async (tx: Record<string, unknown>) => {
    await importDb(
      JSON.stringify({
        [Table.Transactions]: [{ id: 'x', status: ITransactionStatus.Completed, accountId: 'a', initiatedAt: 1, ...tx }]
      })
    );
    const [restored] = await transactions.toArray();
    return restored!;
  };

  // Import must NOT rewrite the lifecycle markers in `extraInputs`. An earlier
  // revision settled them to stop a restored row being resumed; those same
  // strings are what the bridge/earn status pills render, so it rewrote journeys
  // the user had genuinely completed as "Failed" — on rows whose `status` is
  // Completed, which is exactly where the failure card withholds the reason. The
  // resumers are gated on `restoredFromBackup` instead; display stays truthful.
  it.each([
    ['a completed Epoch bridge', 'bridged-send', { provider: 'epoch', epochStatus: 'confirmed' }],
    ['an in-flight Epoch bridge', 'bridged-send', { provider: 'epoch', epochStatus: 'pending' }],
    ['a claimed AggLayer bridge', 'bridged-send', { provider: 'agglayer', claimStatus: 'claimed' }],
    ['a claimable AggLayer bridge', 'bridged-send', { provider: 'agglayer', claimStatus: 'ready' }],
    ['a delivered bridge receive', 'bridged-receive', { phase: 'received' }],
    ['an in-flight bridge receive', 'bridged-receive', { phase: 'delivering' }],
    ['a settled earn deposit', 'earn-deposit', { epochStatus: 'confirmed' }],
    ['an in-flight earn withdrawal', 'earn-withdraw', { phase: 'redeeming' }]
  ])('restores %s exactly as the backup recorded it', async (_label, type, extraInputs) => {
    const restored = await importOne({ type, extraInputs });

    expect(restored.extraInputs).toEqual(extraInputs);
    // Provenance is still recorded — that is what the resumers read.
    expect(restored.restoredFromBackup).toBe(true);
  });

  // A Completed row skips the neutralization branch entirely, so it was the one
  // path that could still reach history without a timestamp. History reads
  // `completedAt` straight off the row with no fallback and builds a Date from
  // it — a missing one throws while grouping by day and takes down the list.
  it('stamps a timestamp on a terminal row that arrives without one', async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        { id: 'no-ts', type: 'send', status: ITransactionStatus.Completed, accountId: 'a', initiatedAt: 42 }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.status).toBe(ITransactionStatus.Completed);
    expect(restored!.completedAt).toBe(42);
  });

  it('keeps a terminal row own completedAt when it has one', async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        {
          id: 'has-ts',
          type: 'send',
          status: ITransactionStatus.Completed,
          accountId: 'a',
          initiatedAt: 42,
          completedAt: 99
        }
      ]
    });

    await importDb(dump);

    const [restored] = await transactions.toArray();
    expect(restored!.completedAt).toBe(99);
  });

  it('leaves terminal rows untouched on import', async () => {
    const dump = JSON.stringify({
      [Table.Transactions]: [
        { id: 'done', type: 'send', status: ITransactionStatus.Completed, accountId: 'a', initiatedAt: 1 },
        { id: 'bad', type: 'send', status: ITransactionStatus.Failed, accountId: 'a', initiatedAt: 2 }
      ]
    });

    await importDb(dump);

    // Keyed by id, not position: `toArray` returns index order, not insertion order.
    const restored = new Map((await transactions.toArray()).map(tx => [tx.id, tx]));
    expect(restored.get('done')!.status).toBe(ITransactionStatus.Completed);
    expect(restored.get('bad')!.status).toBe(ITransactionStatus.Failed);
    // Terminal rows keep their status, but every imported row is still marked --
    // an imported "completed" row is unverified local data, not a chain fact,
    // and a genuinely failed one must not become retryable just by being in a dump.
    expect(restored.get('done')!.restoredFromBackup).toBe(true);
    expect(isRequeueableTransaction(restored.get('bad')!)).toBe(false);
  });

  // A dump is free to carry anything under `initiatedAt`, and the insert check
  // accepts only a non-negative safe integer (the spending-limit policy's rule),
  // so anything else falls back to the row's completedAt, else the current time.
  it.each([
    ['missing', undefined, 1_700_000_100, 1_700_000_100],
    ['NaN (null after JSON)', Number.NaN, 1_700_000_100, 1_700_000_100],
    ['negative', -5, 1_700_000_100, 1_700_000_100],
    ['fractional', 1_700_000_000.5, 1_700_000_100, 1_700_000_100]
  ])(
    'gives an imported row with a %s initiatedAt its completedAt instead',
    async (_label, initiatedAt, completedAt, expected) => {
      const row: Record<string, unknown> = { id: 'imported-1', status: 2, completedAt };
      if (initiatedAt !== undefined) row.initiatedAt = initiatedAt;
      await importDb(JSON.stringify({ [Table.Transactions]: [row] }));

      await expect(transactions.get('imported-1')).resolves.toMatchObject({ initiatedAt: expected });
    }
  );

  it('gives an imported row with neither timestamp usable the current time', async () => {
    const before = Math.floor(Date.now() / 1000);
    await importDb(JSON.stringify({ [Table.Transactions]: [{ id: 'imported-2', status: 2 }] }));

    const after = Math.floor(Date.now() / 1000);

    const row = await transactions.get('imported-2');
    expect(Number.isSafeInteger(row?.initiatedAt)).toBe(true);
    expect(row!.initiatedAt).toBeGreaterThanOrEqual(before);
    expect(row!.initiatedAt).toBeLessThanOrEqual(after);
  });

  it('keeps a usable imported initiatedAt as it is', async () => {
    await importDb(
      JSON.stringify({
        [Table.Transactions]: [{ id: 'imported-3', status: 2, initiatedAt: 1_600_000_000, completedAt: 1_700_000_100 }]
      })
    );

    await expect(transactions.get('imported-3')).resolves.toMatchObject({ initiatedAt: 1_600_000_000 });
  });
});

describe('spending limits schema', () => {
  beforeEach(async () => {
    await spendingLimits.clear();
    await transactions.clear();
  });

  it('keys spending limits by account alone on schema version 3.1', () => {
    const schema = spendingLimits.schema;

    expect(db.verno).toBe(3.1);
    expect(schema.primKey.keyPath).toBe('accountId');
    expect(schema.indexes.map(index => index.name)).toEqual(expect.arrayContaining(['revision']));
  });

  it('keeps one spending-limit record per account', async () => {
    await spendingLimits.put({
      accountId: 'account-a',
      limit: '10',
      revision: 'revision-1',
      createdAt: 1,
      updatedAt: 1
    });
    await spendingLimits.put({
      accountId: 'account-a',
      limit: '20',
      revision: 'revision-2',
      createdAt: 1,
      updatedAt: 2
    });
    await spendingLimits.put({
      accountId: 'account-b',
      limit: '30',
      revision: 'revision-3',
      createdAt: 3,
      updatedAt: 3
    });

    expect(await spendingLimits.count()).toBe(2);
    expect(await spendingLimits.get('account-a')).toEqual(
      expect.objectContaining({ limit: '20', revision: 'revision-2' })
    );
  });

  it('keys spending limits by account alone', async () => {
    await spendingLimits.put({
      accountId: 'acct-1',
      limit: '50000000',
      revision: 'rev-1',
      createdAt: 1,
      updatedAt: 1
    });

    await expect(spendingLimits.get('acct-1')).resolves.toMatchObject({ limit: '50000000' });
  });

  it('indexes the exact spending-limit authorization attached to a transaction', async () => {
    expect(transactions.schema.indexes.map(index => index.name)).toContain('spendingLimitAuthorizationId');

    await transactions.add({
      id: 'transaction-1',
      type: 'send',
      accountId: 'account-a',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'SEND',
      spendingLimitAuthorizationId: 'authorization-1'
    });

    await expect(
      transactions.where('spendingLimitAuthorizationId').equals('authorization-1').primaryKeys()
    ).resolves.toEqual(['transaction-1']);
  });

  it('stores a stamped dollar value on a transaction row', async () => {
    await transactions.add({
      id: 'tx-usd',
      type: 'send',
      accountId: 'account-a',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'SEND',
      spentUsd: 1_500_000n
    });

    await expect(transactions.get('tx-usd')).resolves.toMatchObject({ spentUsd: 1_500_000n });
  });
});

// Every other test in this file opens `db` already declared through 1.9, so nothing above proves
// Dexie actually accepts the primary-key change on a database that has real 1.7 rows in it, or
// even that the two-version drop-then-recreate shape repo.ts uses is necessary rather than an
// unnecessary complication. Reproduced on isolated, uniquely-named databases so neither test here
// can collide with the shared `db` singleton every other test in this file mutates.
//
// The migration-proving test below reopens through `createSchemaFor`, `repo.ts`'s own exported
// schema builder - NOT a hand-typed duplicate of the version chain. That distinction is load-
// bearing: an earlier version of this test built its own parallel 1.7/1.8/1.9 chain, which meant
// it kept passing even after `repo.ts`'s real 1.8/1.9 were collapsed back into a single version
// (the defect this test exists to catch) - the private chain never saw the mutation. Routing the
// reopen through the real `defineSchema` (via `createSchemaFor`) means a future collapse changes
// what THIS test replays too, so it fails instead of passing green next to a broken migration.
describe('schema migration (1.7 -> 2, 1.9 -> 2)', () => {
  // A second, independent oracle for the two constants `seedV17` and the real chain
  // (`createSchemaFor`, via `defineSchema`) both read below. Version 1.7 has already shipped on
  // origin/main, so its shape is immutable in every existing user's IndexedDB - coupling this
  // test's seed to repo.ts's own exports (rather than a hand-typed duplicate) closed one hole, but
  // opened another: a future edit to what repo.ts DECLARES for 1.7 would have seed and reopen
  // silently agree on the new, wrong shape, and every test below would keep passing next to a
  // migration that no real user's database can actually run. These literals are that record.
  it('pins the shipped 1.7 store definitions to literals independent of repo.ts', () => {
    expect(TRANSACTIONS_V17_STORE).toBe(
      'id,accountId,transactionId,initiatedAt,completedAt,noteId,*noteIds,noteDelivery,extraInputs.destinationAddress,extraInputs.swapOrderTxId,spendingLimitAuthorizationId'
    );
    expect(SPENDING_LIMITS_V17_STORE).toBe('[accountId+faucetId],accountId,faucetId,revision');
  });

  const TEN_TRANSACTIONS_V17_INDEXES = [
    'accountId',
    'transactionId',
    'initiatedAt',
    'completedAt',
    'noteId',
    'noteIds',
    'noteDelivery',
    'extraInputs.destinationAddress',
    'extraInputs.swapOrderTxId',
    'spendingLimitAuthorizationId'
  ];

  const seedV17 = async (name: string): Promise<void> => {
    const seed = new Dexie(name);
    seed.version(1.7).stores({
      [Table.Transactions]: TRANSACTIONS_V17_STORE,
      [Table.SpendingLimits]: SPENDING_LIMITS_V17_STORE
    });
    await seed.open();
    // Rows shaped the way a real pre-upgrade installation would have them: two per-asset limits
    // for the same account, which is exactly what the old compound key allowed and the new one does
    // not; and an ordinary transaction row, so the migration's effect on the SIBLING table - which
    // 1.8/1.9 never touch - is asserted too, not just assumed.
    await seed.table(Table.SpendingLimits).bulkAdd([
      { accountId: 'account-a', faucetId: 'faucet-1', revision: 'rev-1', limit: '10', createdAt: 1, updatedAt: 1 },
      { accountId: 'account-a', faucetId: 'faucet-2', revision: 'rev-2', limit: '20', createdAt: 1, updatedAt: 1 }
    ]);
    await seed.table(Table.Transactions).add({
      id: 'tx-1',
      type: 'send',
      status: ITransactionStatus.Completed,
      accountId: 'account-a',
      initiatedAt: 1,
      displayIcon: 'SEND'
    });
    await expect(seed.table(Table.SpendingLimits).count()).resolves.toBe(2);
    await expect(seed.table(Table.Transactions).count()).resolves.toBe(1);
    seed.close();
  };

  // Documents WHY repo.ts spends two version numbers on this migration instead of one: Dexie
  // itself refuses to change a table's primary key within a single version step, even against an
  // empty table, rather than this being merely untested. Collapsing 1.8/1.9 back into one version
  // is therefore not a safe simplification. Deliberately hand-built (not `createSchemaFor`) since
  // its whole point is to construct the WRONG, collapsed shape.
  it('rejects an in-place primary-key change on a single version, even with no data', async () => {
    const name = `spending-limits-migration-rejected-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seed = new Dexie(name);
    seed.version(1.7).stores({ [Table.SpendingLimits]: SPENDING_LIMITS_V17_STORE });
    await seed.open();
    seed.close();

    const invalid = new Dexie(name);
    invalid.version(1.7).stores({ [Table.SpendingLimits]: SPENDING_LIMITS_V17_STORE });
    invalid.version(1.8).stores({ [Table.SpendingLimits]: SPENDING_LIMITS_V19_STORE });

    await expect(invalid.open()).rejects.toThrow(/changing primary key/);
    await Dexie.delete(name);
  });

  it('accepts the drop-then-recreate migration on a populated 1.7 database and clears the table', async () => {
    const name = `spending-limits-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await seedV17(name);

    // Reopen under the same name through the REAL chain repo.ts declares (see the describe-level
    // comment for why this must not be a hand-rolled duplicate): 1.8 drops the old compound-keyed
    // table, 1.9 recreates it keyed by account alone, and 2 adds the `type` index.
    const upgraded = createSchemaFor(name);

    await expect(upgraded.open()).resolves.toBeDefined();
    expect(upgraded.verno).toBe(3.1);
    expect(upgraded.table(Table.SpendingLimits).schema.primKey.keyPath).toBe('accountId');
    expect(upgraded.table(Table.Transactions).schema.indexes.map(index => index.name)).toContain('type');
    await expect(upgraded.table(Table.SpendingLimits).count()).resolves.toBe(0);

    // Usable afterward, not merely empty: the new shape accepts a write keyed by account alone.
    await upgraded
      .table(Table.SpendingLimits)
      .put({ accountId: 'account-a', revision: 'rev-3', limit: '30', createdAt: 2, updatedAt: 2 });
    await expect(upgraded.table(Table.SpendingLimits).get('account-a')).resolves.toMatchObject({ limit: '30' });

    // The sibling `transactions` table keeps its row and its ten 1.7 indexes through the spending-limit
    // steps and through v2, which redeclares it with `type` added - asserted here rather than left
    // for a reader to trust.
    expect(upgraded.table(Table.Transactions).schema.indexes.map(index => index.name)).toEqual(
      expect.arrayContaining(TEN_TRANSACTIONS_V17_INDEXES)
    );
    await expect(upgraded.table(Table.Transactions).get('tx-1')).resolves.toMatchObject({
      accountId: 'account-a',
      status: ITransactionStatus.Completed
    });

    upgraded.close();
    await Dexie.delete(name);
  });

  // Every 1.16.2 install takes this step. The shipped 1.9 shape is pinned to literals for the same
  // reason as 1.7 above: it can never change in users' IndexedDB. The 1.7 case cannot see a later
  // step that clears `spendingLimits`, because it expects that table empty.
  it('upgrades a populated 1.9 database through 2, keeping its spending limit and indexing type', async () => {
    const name = `schema-migration-v19-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seed = new Dexie(name);
    seed.version(1.9).stores({
      [Table.Transactions]:
        'id,accountId,transactionId,initiatedAt,completedAt,noteId,*noteIds,noteDelivery,extraInputs.destinationAddress,extraInputs.swapOrderTxId,spendingLimitAuthorizationId',
      [Table.SpendingLimits]: 'accountId,revision'
    });
    await seed.open();
    await seed
      .table(Table.SpendingLimits)
      .add({ accountId: 'account-a', revision: 'rev-1', limit: '100', createdAt: 1, updatedAt: 1 });
    const row = { status: ITransactionStatus.Completed, accountId: 'account-a', initiatedAt: 1, displayIcon: 'SEND' };
    await seed.table(Table.Transactions).bulkAdd([
      { ...row, id: 'tx-send', type: 'bridged-send' },
      { ...row, id: 'tx-receive', type: 'bridged-receive' },
      { ...row, id: 'tx-other', type: 'send' }
    ]);
    seed.close();

    const upgraded = createSchemaFor(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(3.1);
    await expect(upgraded.table(Table.SpendingLimits).get('account-a')).resolves.toMatchObject({
      revision: 'rev-1',
      limit: '100'
    });
    const bridged = await upgraded
      .table(Table.Transactions)
      .where('type')
      .anyOf('bridged-send', 'bridged-receive')
      .primaryKeys();
    expect([...bridged].sort()).toEqual(['tx-receive', 'tx-send']);

    upgraded.close();
    await Dexie.delete(name);
  });
});

describe('writing a transaction row', () => {
  it('upgrades a populated v3 store without losing transaction blobs or spending limits', async () => {
    const name = `badge-index-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seed = new Dexie(name);
    seed
      .version(3)
      .stores({ [Table.Transactions]: TRANSACTIONS_V2_STORE, [Table.SpendingLimits]: SPENDING_LIMITS_V19_STORE });
    await seed.open();
    const legacy: ITransaction = {
      id: 'legacy-badge-upgrade',
      accountId: 'account-a',
      type: 'send',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND',
      resultBytes: new Uint8Array([1, 2, 3])
    };
    await seed.table(Table.Transactions).add(legacy);
    await seed
      .table(Table.SpendingLimits)
      .add({ accountId: 'account-a', limit: '20', revision: 'old', createdAt: 1, updatedAt: 1 });
    seed.close();
    const upgraded = createSchemaFor(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(3.1);
      expect(await upgraded.table(Table.Transactions).get(legacy.id)).toEqual(legacy);
      expect(
        await upgraded
          .table(Table.Transactions)
          .where('[badgeNetwork+status+type]')
          .equals(['mainnet', ITransactionStatus.Completed, 'send'])
          .count()
      ).toBe(0);
      expect(await upgraded.table(Table.SpendingLimits).get('account-a')).toMatchObject({
        limit: '20',
        revision: 'old'
      });
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });
  it('indexes only explicitly stamped badge evidence and leaves legacy history intact', async () => {
    await transactions.clear();
    const old: ITransaction = {
      id: 'badge-legacy',
      type: 'send',
      accountId: 'account-a',
      initiatedAt: 1,
      status: ITransactionStatus.Completed,
      displayIcon: 'SEND'
    };
    await transactions.bulkAdd([
      old,
      { ...old, id: 'badge-testnet', badgeNetwork: 'testnet' },
      { ...old, id: 'badge-mainnet', badgeNetwork: 'mainnet' }
    ]);
    expect(
      await transactions
        .where('[badgeNetwork+status+type]')
        .equals(['mainnet', ITransactionStatus.Completed, 'send'])
        .primaryKeys()
    ).toEqual(['badge-mainnet']);
    expect(await transactions.get('badge-legacy')).toEqual(old);
  });
  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['negative', -1],
    ['fractional', 1_700_000_000.5]
  ])('refuses a row with a %s initiatedAt, and writes nothing', async (_label, value) => {
    const row: Record<string, unknown> = { id: 'hook-1', accountId: 'a', status: 0 };
    if (value !== undefined) row.initiatedAt = value;

    await expect(transactions.add(row as never)).rejects.toThrow(/initiatedAt/);
    await expect(transactions.get('hook-1')).resolves.toBeUndefined();
  });

  it('refuses a bulkAdd that carries one unplaceable row, and writes none of them', async () => {
    await expect(
      transactions.bulkAdd([
        { id: 'hook-2', accountId: 'a', status: 0, initiatedAt: 1_700_000_000 },
        { id: 'hook-3', accountId: 'a', status: 0 }
      ] as never)
    ).rejects.toThrow();
    await expect(transactions.get('hook-3')).resolves.toBeUndefined();
    await expect(transactions.get('hook-2')).resolves.toBeUndefined();
  });

  it('writes a row with a non-negative safe-integer initiatedAt', async () => {
    await transactions.add({ id: 'hook-4', accountId: 'a', status: 0, initiatedAt: 1_700_000_000 } as never);
    await expect(transactions.get('hook-4')).resolves.toMatchObject({ initiatedAt: 1_700_000_000 });
  });

  it('refuses the same row in a database built by createSchemaFor', async () => {
    const name = `insert-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolated = createSchemaFor(name);

    await expect(isolated.table(Table.Transactions).add({ id: 'hook-5', accountId: 'a', status: 0 })).rejects.toThrow(
      /initiatedAt/
    );
    isolated.close();
    await Dexie.delete(name);
  });

  it('issues one getMany for the row a modify replaces, and none for the insert check', async () => {
    await transactions.add({ id: 'hook-6', accountId: 'a', status: 0, initiatedAt: 1_700_000_000 } as never);
    let reads = 0;
    // Level 1 sits below Dexie's hooks middleware (level 2), which issues a hook's read of the rows a
    // put replaces, and above the transaction cache (level -1) that would answer that read.
    const counter: Middleware<DBCore> = {
      stack: 'dbcore',
      name: 'get-many-counter',
      level: 1,
      create: down => ({
        ...down,
        table: name => {
          const table = down.table(name);
          if (name !== Table.Transactions) return table;
          return {
            ...table,
            getMany: req => {
              reads += 1;
              return table.getMany(req);
            }
          };
        }
      })
    };
    db.close();
    db.use(counter);
    await db.open();
    try {
      await transactions.where({ id: 'hook-6' }).modify({ status: ITransactionStatus.Completed });
      expect(reads).toBe(1);
    } finally {
      db.unuse({ stack: 'dbcore', name: 'get-many-counter' });
      db.close();
      await db.open();
    }
    await expect(transactions.get('hook-6')).resolves.toMatchObject({ status: ITransactionStatus.Completed });
  });
});

describe('wallet storage rejection boundaries', () => {
  type BoundaryMethod = 'get' | 'getMany' | 'query' | 'count' | 'openCursor' | 'mutate';
  type BoundaryMode = 'success' | 'throw' | 'reject' | 'primitive';
  const owners: { table: Table; owner: StorageOwner }[] = [
    { table: Table.Transactions, owner: 'wallet_transactions' },
    { table: Table.SpendingLimits, owner: 'wallet_limits' }
  ];
  const methods: { method: BoundaryMethod; operation: StorageOperation }[] = [
    { method: 'get', operation: 'get' },
    { method: 'getMany', operation: 'get' },
    { method: 'query', operation: 'query' },
    { method: 'count', operation: 'count' },
    { method: 'openCursor', operation: 'cursor_open' },
    { method: 'mutate', operation: 'mutate' }
  ];
  const modes: BoundaryMode[] = ['throw', 'reject', 'primitive'];
  const cases = owners.flatMap(owner =>
    methods.flatMap(method => modes.map(mode => ({ ...owner, ...method, requestedMode: mode })))
  );
  let sequence = 0;

  // The control has the same primary keys and indexes without wallet middleware.
  // Its partial writes and transaction lifetime provide the reference behavior.
  function database(instrumented = true): Dexie {
    const name = `storage-boundary-${Date.now()}-${sequence++}`;
    if (instrumented) return createSchemaFor(name);
    const control = new Dexie(name, { modifyChunkSize: 25 });
    control.version(3.1).stores({
      [Table.Transactions]: TRANSACTIONS_V2_STORE,
      [Table.SpendingLimits]: SPENDING_LIMITS_V19_STORE
    });
    return control;
  }

  async function dispose(target: Dexie): Promise<void> {
    target.close();
    await Dexie.delete(target.name);
  }

  async function rejection(invoke: () => unknown): Promise<unknown> {
    try {
      await invoke();
    } catch (error) {
      return error;
    }
    throw new Error('Expected the operation to reject');
  }

  function pair(owner: StorageOwner, operation: StorageOperation) {
    return { storageOwner: owner, storageOperation: operation };
  }

  function row(key: string): Record<string, unknown> {
    return { id: key, accountId: key, initiatedAt: 1, revision: 'original', status: 0 };
  }

  async function seed(target: Dexie, table: Table): Promise<void> {
    await target.table<Record<string, unknown>, string>(table).bulkAdd([row('a'), row('b'), row('c')]);
  }

  // Real hooks and observability consult Dexie's active transaction zone.
  // A bare IDB transaction would bypass that public-operation invariant.
  function cursorRequest(target: Dexie, tableName: Table) {
    const current = Dexie.currentTransaction;
    if (current === null) throw new Error('Cursor requires a Dexie transaction');
    const table = target.core.table(tableName);
    return {
      trans: current.idbtrans,
      values: true,
      query: { index: table.schema.primaryKey, range: { type: 3, lower: undefined, upper: undefined } }
    };
  }

  // The lower middleware controls settlement without replacing the production construction path.
  // Separate parameter rows prove both throw and rejection paths on the unimplemented source.
  // Frozen failures also prevent an observer from relying on writable Error properties.
  it.each(cases)(
    'labels $table $method $requestedMode without changing settlement or arguments',
    async ({ table, owner, method, operation, requestedMode }) => {
      const target = database();
      let mode: BoundaryMode = 'success';
      let failure = new Error('boundary failure');
      let calls = 0;
      let observedRequest: unknown;
      let observedReceiver: unknown;
      let expectedReceiver: DBCoreTable | undefined;
      let expectedRequest: unknown;
      const objectResponse = { untouched: true };
      const arrayResponse = [objectResponse];
      const queryResponse = { result: arrayResponse };
      const mutationResponse: DBCoreMutateResponse = { numFailures: 0, failures: {}, results: ['a'], lastResult: 'a' };
      function settle<T>(receiver: DBCoreTable, request: unknown, value: T): Promise<T> {
        calls++;
        observedReceiver = receiver;
        observedRequest = request;
        if (mode === 'throw') throw failure;
        if (mode === 'reject') return Dexie.Promise.reject(failure);
        if (mode === 'primitive') return Dexie.Promise.reject('primitive rejection');
        return Dexie.Promise.resolve(value);
      }
      target.use({
        stack: 'dbcore',
        name: 'boundary-settlement-control',
        level: 10.5,
        create: down => ({
          ...down,
          table: name => {
            const original = down.table(name);
            if (name !== table) return original;
            const wrapped: DBCoreTable = {
              ...original,
              get(request) {
                return settle(this, request, objectResponse);
              },
              getMany(request) {
                return settle(this, request, arrayResponse);
              },
              query(request) {
                return settle(this, request, queryResponse);
              },
              count(request) {
                return settle(this, request, 17);
              },
              openCursor(request) {
                return settle(this, request, null);
              },
              mutate(request) {
                return settle(this, request, mutationResponse);
              }
            };
            expectedReceiver = wrapped;
            return wrapped;
          }
        })
      });
      try {
        await target.open();
        const coreTable = target.core.table(table);
        function invoke(): Promise<unknown> {
          const trans = target.core.transaction([table], 'readwrite');
          const query = { index: coreTable.schema.primaryKey, range: { type: 3, lower: undefined, upper: undefined } };
          switch (method) {
            case 'get': {
              const request = { trans, key: 'a' };
              expectedRequest = request;
              return coreTable.get(request);
            }
            case 'getMany': {
              const request = { trans, keys: ['a'] };
              expectedRequest = request;
              return coreTable.getMany(request);
            }
            case 'query': {
              const request = { trans, query, values: true };
              expectedRequest = request;
              return coreTable.query(request);
            }
            case 'count': {
              const request = { trans, query };
              expectedRequest = request;
              return coreTable.count(request);
            }
            case 'openCursor': {
              const request = { trans, query, values: true };
              expectedRequest = request;
              return coreTable.openCursor(request);
            }
            case 'mutate': {
              const request: Parameters<DBCoreTable['mutate']>[0] = { type: 'add', trans, values: [row('a')] };
              expectedRequest = request;
              return coreTable.mutate(request);
            }
          }
        }
        const responses: Record<BoundaryMethod, unknown> = {
          get: objectResponse,
          getMany: arrayResponse,
          query: queryResponse,
          count: 17,
          openCursor: null,
          mutate: mutationResponse
        };
        expect(await invoke()).toBe(responses[method]);
        expect(observedReceiver).toBe(expectedReceiver);
        expect(observedRequest).toBe(expectedRequest);
        expect(calls).toBe(1);
        mode = requestedMode;
        failure = Object.freeze(new Error(`${method} ${mode}`));
        const caught = await rejection(invoke);
        expect(caught).toBe(mode === 'primitive' ? 'primitive rejection' : failure);
        expect(observedReceiver).toBe(expectedReceiver);
        expect(observedRequest).toBe(expectedRequest);
        expect(calls).toBe(2);
        expect(snapshotCrashDiagnostics(caught)).toEqual(mode === 'primitive' ? {} : pair(owner, operation));
      } finally {
        await dispose(target);
      }
    }
  );

  // A schema can still contain a historical store during an upgrade. Its name must
  // never become telemetry merely because it passed through the wallet middleware.
  it('does not guess an owner for a historical or unknown table', async () => {
    const target = database();
    target.version(3.2).stores({ transactionRequests: 'id', unrelated: 'id' });
    const failures = new Map<string, Error>();
    target.use({
      stack: 'dbcore',
      name: 'historical-table-failure',
      level: 10.5,
      create: down => ({
        ...down,
        table: name => {
          const table = down.table(name);
          if (name !== 'transactionRequests' && name !== 'unrelated') return table;
          const failure = new Error(name);
          failures.set(name, failure);
          return { ...table, get: () => Dexie.Promise.reject(failure) };
        }
      })
    });
    try {
      await target.open();
      for (const name of ['transactionRequests', 'unrelated']) {
        const caught = await rejection(() => target.table(name).get('a'));
        expect(caught).toBe(failures.get(name));
        expect(snapshotCrashDiagnostics(caught)).toEqual({});
      }
    } finally {
      await dispose(target);
    }
  });

  // Patching this real cursor's iterator makes fake-indexeddb emit a genuine continuation request error.
  // The successful first request distinguishes iteration observation from an open-only catch.
  // Dexie reconstructs UnknownError, so the public error and its native inner are pinned separately.
  it.each(owners)('labels a request error after a real $table cursor has opened', async ({ table, owner }) => {
    const target = database();
    const failure = new Error('iteration request failure');
    failure.name = 'UnknownError';
    let openSucceeded = false;
    let requestErrorSeen = false;
    const original = IDBObjectStore.prototype.openCursor;
    const spy = jest.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (
      this: IDBObjectStore,
      range,
      direction
    ) {
      const request = original.call(this, range, direction);
      if (this.transaction.db.name === target.name && this.name === table) {
        request.addEventListener(
          'success',
          () => {
            const cursor: unknown = request.result;
            if (cursor === null || typeof cursor !== 'object') return;
            openSucceeded = true;
            Object.defineProperty(cursor, '_iterate', {
              configurable: true,
              value: () => {
                throw failure;
              }
            });
          },
          { once: true }
        );
        request.addEventListener('error', () => {
          requestErrorSeen = request.error === failure;
        });
      }
      return request;
    });
    try {
      await seed(target, table);
      const caught = await rejection(() =>
        target
          .table(table)
          .filter(() => true)
          .toArray()
      );
      expect(openSucceeded).toBe(true);
      expect(requestErrorSeen).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toMatchObject({ name: 'UnknownError', inner: failure });
      expect(snapshotCrashDiagnostics(caught)).toMatchObject(pair(owner, 'cursor_iteration'));
    } finally {
      spy.mockRestore();
      await dispose(target);
    }
  });

  // next() dynamically reuses start(), while exhaustion installs a different start().
  // Restoring the observed method after either transition changes the cursor protocol.
  it.each(owners)('preserves $table cursor identity, next, early stop and exhaustion', async ({ table }) => {
    for (const instrumented of [false, true]) {
      const target = database(instrumented);
      let originalCursor: DBCoreCursor | null = null;
      let startReceiver: unknown;
      let startCallback: unknown;
      let unchangedMethods: unknown[] = [];
      target.use({
        stack: 'dbcore',
        name: 'cursor-identity-observer',
        level: 10.5,
        create: down => ({
          ...down,
          table: name => {
            const original = down.table(name);
            if (name !== table) return original;
            return {
              ...original,
              openCursor: request =>
                original.openCursor(request).then(cursor => {
                  originalCursor = cursor;
                  if (cursor !== null) {
                    unchangedMethods = [
                      cursor.next,
                      cursor.stop,
                      cursor.fail,
                      cursor.continue,
                      cursor.continuePrimaryKey,
                      cursor.advance
                    ];
                    const start = cursor.start;
                    cursor.start = function (callback) {
                      startReceiver = this;
                      startCallback = callback;
                      return start.call(this, callback);
                    };
                  }
                  return cursor;
                })
            };
          }
        })
      });
      try {
        await seed(target, table);
        await target.transaction('r', table, async () => {
          const cursor = await target.core.table(table).openCursor(cursorRequest(target, table));
          expect(cursor).toBe(originalCursor);
          if (cursor === null) throw new Error('Seeded cursor was empty');
          expect([
            cursor.next,
            cursor.stop,
            cursor.fail,
            cursor.continue,
            cursor.continuePrimaryKey,
            cursor.advance
          ]).toEqual(unchangedMethods);
          expect(cursor.key).toBe('a');
          expect(await cursor.next()).toBe(cursor);
          expect(cursor.key).toBe('b');
          const stopValue = { stopped: true };
          const visitor = () => cursor.stop(stopValue);
          expect(await cursor.start(visitor)).toBe(stopValue);
          expect(startReceiver).toBe(cursor);
          expect(startCallback).toBe(visitor);
          expect(() => cursor.continue()).toThrow('Cursor not stopped');

          const full = await target.core.table(table).openCursor(cursorRequest(target, table));
          if (full === null) throw new Error('Seeded cursor was empty');
          const keys: unknown[] = [];
          await full.start(() => {
            keys.push(full.key);
            full.continue();
          });
          expect(keys).toEqual(['a', 'b', 'c']);
          expect(full.done).toBe(true);
          const exhaustedStart = full.start;
          expect(() => full.start(() => undefined)).toThrow('Cursor behind last entry');
          expect(full.start).toBe(exhaustedStart);
          expect(() => full.next()).toThrow('Cursor behind last entry');
        });
        await target.table(table).clear();
        await target.transaction('r', table, async () => {
          expect(await target.core.table(table).openCursor(cursorRequest(target, table))).toBeNull();
        });
      } finally {
        await dispose(target);
      }
    }
  });

  // Each failure is caught before the transaction finishes, so no detached observer
  // may replace its identity or leave an abandoned rejection behind.
  it.each(
    owners.flatMap(owner => ['visitor', 'continuation', 'fail', 'start', 'rejection'].map(kind => ({ ...owner, kind })))
  )('preserves and labels $table cursor $kind errors', async ({ table, owner, kind }) => {
    const target = database();
    const failure = Object.freeze(new Error(`cursor ${kind}`));
    let observedCursor: DBCoreCursor | null = null;
    let dataReads = 0;
    target.use({
      stack: 'dbcore',
      name: 'cursor-error-control',
      level: 10.5,
      create: down => ({
        ...down,
        table: name => {
          const original = down.table(name);
          if (name !== table) return original;
          return {
            ...original,
            openCursor: request =>
              original.openCursor(request).then(cursor => {
                observedCursor = cursor;
                if (cursor !== null && (kind === 'start' || kind === 'rejection')) {
                  // These hostile accessors catch a wrapper that spreads or examines storage data.
                  const unread = () => {
                    dataReads++;
                    throw failure;
                  };
                  for (const property of ['key', 'primaryKey', 'value']) {
                    Object.defineProperty(cursor, property, {
                      configurable: true,
                      get: unread
                    });
                  }
                  cursor.start = () => {
                    if (kind === 'start') throw failure;
                    return Dexie.Promise.reject(failure);
                  };
                }
                return cursor;
              })
          };
        }
      })
    });
    try {
      await seed(target, table);
      await target.transaction('r', table, async () => {
        const cursor = await target.core.table(table).openCursor(cursorRequest(target, table));
        expect(cursor).toBe(observedCursor);
        if (cursor === null) throw new Error('Seeded cursor was empty');
        const caught = await rejection(() =>
          cursor.start(() => {
            if (kind === 'visitor') throw failure;
            if (kind === 'continuation')
              cursor.continue = () => {
                throw failure;
              };
            if (kind === 'fail') cursor.fail(failure);
            else cursor.continue();
          })
        );
        expect(caught).toBe(failure);
        expect(dataReads).toBe(0);
        expect(snapshotCrashDiagnostics(caught)).toEqual(pair(owner, 'cursor_iteration'));
      });
    } finally {
      await dispose(target);
    }
  });

  // DBCore resolves partial failures; rejecting its response would suppress Dexie's
  // own aggregation and change which otherwise successful rows are committed.
  it.each(owners)(
    'annotates resolved $table mutation failures and returns the identical response',
    async ({ table, owner }) => {
      const target = database();
      let originalResponse: DBCoreMutateResponse | undefined;
      let originalResults: unknown;
      let originalFailureMap: unknown;
      let originalFailures: Error[] = [];
      target.use({
        stack: 'dbcore',
        name: 'mutation-response-observer',
        level: 10.5,
        create: down => ({
          ...down,
          table: name => {
            const original = down.table(name);
            if (name !== table) return original;
            return {
              ...original,
              mutate: request =>
                original.mutate(request).then(response => {
                  originalResponse = response;
                  originalResults = response.results;
                  originalFailureMap = response.failures;
                  originalFailures = Object.values(response.failures);
                  return response;
                })
            };
          }
        })
      });
      try {
        await seed(target, table);
        const response = await target.transaction('rw', table, tx =>
          target.core.table(table).mutate({ type: 'add', trans: tx.idbtrans, values: [row('a'), row('d'), row('b')] })
        );
        expect(response).toBe(originalResponse);
        expect(response.results).toBe(originalResults);
        expect(response.failures).toBe(originalFailureMap);
        Object.values(response.failures).forEach((failure, index) => expect(failure).toBe(originalFailures[index]));
        expect(response.numFailures).toBe(2);
        expect(Object.keys(response.failures)).toEqual(['0', '2']);
        expect(response.results).toEqual([undefined, 'd', undefined]);
        expect(await target.table(table).count()).toBe(4);
        for (const failure of Object.values(response.failures)) {
          expect(failure.name).toBe('ConstraintError');
          expect(snapshotCrashDiagnostics(failure)).toEqual(pair(owner, 'mutate'));
        }
      } finally {
        await dispose(target);
      }
    }
  );

  // The uninstrumented control pins Dexie's public reconstruction, including primary
  // key-changing modify failures, partial bulk commits and explicitly consumed errors.
  it.each(owners)(
    'preserves $table scalar, BulkError and ModifyError public semantics and rollback',
    async ({ table, owner }) => {
      const outcomes: unknown[] = [];
      const ownedFailures: unknown[] = [];
      for (const instrumented of [false, true]) {
        const target = database(instrumented);
        try {
          await seed(target, table);
          const scalar = await rejection(() => target.table(table).add(row('a')));
          const bulk = await rejection(() => target.table(table).bulkAdd([row('a'), row('d'), row('b')]));
          const keyPath = table === Table.Transactions ? 'id' : 'accountId';
          const modify = await rejection(() =>
            target
              .table(table)
              .where(keyPath)
              .anyOf('a', 'c')
              .modify({ [keyPath]: 'b' })
          );
          expect(scalar).toBeInstanceOf(Dexie.ConstraintError);
          expect(bulk).toBeInstanceOf(Dexie.BulkError);
          expect(modify).toBeInstanceOf(Dexie.ModifyError);
          if (
            !(scalar instanceof Dexie.ConstraintError) ||
            !(bulk instanceof Dexie.BulkError) ||
            !(modify instanceof Dexie.ModifyError)
          ) {
            throw new Error('Unexpected public mutation error');
          }
          expect(scalar.inner).toMatchObject({ name: 'ConstraintError' });
          expect(bulk.failures.map(error => error.name)).toEqual(['ConstraintError', 'ConstraintError']);
          expect(bulk.failuresByPos[0]).toBe(bulk.failures[0]);
          expect(bulk.failuresByPos[2]).toBe(bulk.failures[1]);
          expect(modify.successCount).toBe(1);
          expect(modify.failedKeys).toEqual([]);
          const rollback = await rejection(() =>
            target.transaction('rw', table, async () => {
              await target.table(table).add(row('rolled-back'));
              await target.table(table).bulkAdd([row('a'), row('also-rolled-back')]);
            })
          );
          expect(rollback).toBeInstanceOf(Dexie.BulkError);
          expect(await target.table(table).get('rolled-back')).toBeUndefined();
          expect(await target.table(table).get('also-rolled-back')).toBeUndefined();
          let consumed = false;
          await target.transaction('rw', table, async () => {
            await target.table(table).add(row('consumed-success'));
            await target
              .table(table)
              .add(row('a'))
              .catch(() => {
                consumed = true;
              });
          });
          expect(consumed).toBe(true);
          expect(await target.table(table).get('consumed-success')).toEqual(row('consumed-success'));
          outcomes.push({
            scalar: scalar.name,
            inner: scalar.inner.name,
            bulk: bulk.name,
            failures: bulk.failures.map(error => error.name),
            modify: modify.name,
            modifyFailures: modify.failures.map((error: unknown) => (error instanceof Error ? error.name : error)),
            successCount: modify.successCount,
            failedKeys: modify.failedKeys,
            rows: await target.table(table).toArray()
          });
          if (instrumented) {
            for (const error of [scalar, bulk, modify, rollback]) {
              ownedFailures.push(error);
            }
          }
        } finally {
          await dispose(target);
        }
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      for (const error of ownedFailures) expect(snapshotCrashDiagnostics(error)).toEqual(pair(owner, 'mutate'));
    }
  );

  // Failure entries are the only storage-bearing mutation response fields needed.
  // Hostile request/result accessors fail before a diagnostic assertion can hide a leak.
  it.each(owners)(
    'does not read $table mutation keys, rows or successful results for diagnostics',
    async ({ table, owner }) => {
      const target = database();
      const failure = Object.freeze(new Error('mutation entry'));
      let forbiddenReads = 0;
      function forbidden(): never {
        forbiddenReads++;
        throw new Error('Storage contents were inspected');
      }
      const response: DBCoreMutateResponse = {
        numFailures: 1,
        failures: { 0: failure },
        get lastResult() {
          return forbidden();
        },
        get results() {
          return forbidden();
        }
      };
      target.use({
        stack: 'dbcore',
        name: 'mutation-content-trap',
        level: 10.5,
        create: down => ({
          ...down,
          table: name => {
            const original = down.table(name);
            return name === table ? { ...original, mutate: () => Dexie.Promise.resolve(response) } : original;
          }
        })
      });
      try {
        await target.open();
        const request: Parameters<DBCoreTable['mutate']>[0] = {
          type: 'put',
          trans: target.core.transaction([table], 'readwrite'),
          get keys() {
            return forbidden();
          },
          get values() {
            return forbidden();
          }
        };
        expect(await target.core.table(table).mutate(request)).toBe(response);
        expect(forbiddenReads).toBe(0);
        expect(snapshotCrashDiagnostics(failure)).toEqual(pair(owner, 'mutate'));
      } finally {
        await dispose(target);
      }
    }
  );

  // Validation throws before the backend insert. An observer placed below that check
  // would miss it; using a creating hook would instead add replacement reads.
  it('labels insertion validation without adding storage reads or writing a partial batch', async () => {
    const target = database();
    const reads: string[] = [];
    target.use({
      stack: 'dbcore',
      name: 'insertion-read-observer',
      level: 1,
      create: down => ({
        ...down,
        table: name => {
          const original = down.table(name);
          return {
            ...original,
            get: request => {
              reads.push('get');
              return original.get(request);
            },
            getMany: request => {
              reads.push('getMany');
              return original.getMany(request);
            },
            query: request => {
              reads.push('query');
              return original.query(request);
            },
            count: request => {
              reads.push('count');
              return original.count(request);
            },
            openCursor: request => {
              reads.push('cursor');
              return original.openCursor(request);
            }
          };
        }
      })
    });
    try {
      await target.open();
      const table = target.table<Record<string, unknown>, string>(Table.Transactions);
      const invalid = { id: 'unplaceable', accountId: 'a', status: 0 };
      const failure = await rejection(() => table.add(invalid));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: 'transaction unplaceable has an unplaceable initiatedAt' });
      expect(reads).toEqual([]);
      const bulk = await rejection(() => table.bulkAdd([row('valid'), invalid]));
      expect(reads).toEqual([]);
      await table.add(row('inserted'));
      await table.bulkAdd([row('second'), row('third')]);
      expect(reads).toEqual([]);
      expect(await table.get('unplaceable')).toBeUndefined();
      expect(await table.get('valid')).toBeUndefined();
      for (const error of [failure, bulk]) {
        expect(snapshotCrashDiagnostics(error)).toEqual(pair('wallet_transactions', 'mutate'));
      }
    } finally {
      await dispose(target);
    }
  });

  // Store lists belong to transaction creation, before an individual table request
  // exists. Ambiguous lists must stay database-owned rather than pick the first store.
  it.each([
    { stores: [Table.Transactions], owner: 'wallet_transactions' },
    { stores: [Table.SpendingLimits], owner: 'wallet_limits' },
    { stores: [Table.Transactions, Table.SpendingLimits], owner: 'wallet_database' },
    { stores: [], owner: 'wallet_database' },
    { stores: ['unknown'], owner: 'wallet_database' }
  ])(
    'labels transaction creation for $stores after open and preserves backend arguments',
    async ({ stores, owner }) => {
      const target = database();
      const originalTransaction = IDBDatabase.prototype.transaction;
      const failure = Object.freeze(new Error('backend transaction creation'));
      let failCreation = false;
      let backendTransaction: IDBTransaction | undefined;
      let backendReceiver: unknown;
      let backendArguments: unknown[] = [];
      // DBCore binds this method during open, so the observer is installed before opening.
      const transactionSpy = jest.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        names,
        mode,
        config
      ) {
        if (this.name === target.name) {
          backendReceiver = this;
          backendArguments = [names, mode, config];
          if (failCreation) throw failure;
        }
        const result = originalTransaction.call(this, names, mode, config);
        if (this.name === target.name) backendTransaction = result;
        return result;
      });
      try {
        await target.open();
        const backend = target.backendDB();
        const options: NonNullable<Parameters<DBCore['transaction']>[2]> = { durability: 'relaxed' };
        const successful = target.core.transaction([Table.Transactions], 'readonly');
        expect(successful).toBe(backendTransaction);
        failCreation = true;
        const caught = await rejection(() => target.core.transaction(stores, 'readwrite', options));
        expect(caught).toBe(failure);
        expect(backendReceiver).toBe(backend);
        expect(backendArguments).toEqual([stores, 'readwrite', options]);
        expect(snapshotCrashDiagnostics(caught)).toEqual({ storageOwner: owner, storageOperation: 'transaction' });
      } finally {
        transactionSpy.mockRestore();
        await dispose(target);
      }
    }
  );

  // An implicit open is reconstructed again as DatabaseClosedError by Dexie.
  // Observing only the caller's table request would overwrite the open provenance.
  it.each(['explicit', 'implicit'])(
    'labels an %s open failure without affecting another instance or globals',
    async mode => {
      const target = database();
      const control = database(false);
      const factory = Dexie.dependencies.indexedDB;
      if (factory === undefined) throw new Error('fake-indexeddb is unavailable');
      const originalOpen = factory.open;
      const prototypeOpen = Dexie.prototype.open;
      const prototypeTransaction = Dexie.prototype.transaction;
      const rejectionMapper: unknown = Reflect.get(Dexie.Promise, 'rejectionMapper');
      const failure = new Error('backend open failure');
      failure.name = 'UnknownError';
      const spy = jest.spyOn(factory, 'open').mockImplementation(function (this: IDBFactory, name, version) {
        if (name === target.name) throw failure;
        return originalOpen.call(this, name, version);
      });
      try {
        const caught = await rejection(() =>
          mode === 'explicit' ? target.open() : target.table(Table.Transactions).get('a')
        );
        const expectedClass = mode === 'explicit' ? Dexie.UnknownError : Dexie.DatabaseClosedError;
        const expectedInner = mode === 'explicit' ? failure : { name: 'UnknownError', inner: failure };
        expect(caught).toBeInstanceOf(expectedClass);
        expect(caught).toMatchObject({ inner: expectedInner });
        expect(await control.open()).toBe(control);
        expect(Dexie.prototype.open).toBe(prototypeOpen);
        expect(Dexie.prototype.transaction).toBe(prototypeTransaction);
        expect(Reflect.get(Dexie.Promise, 'rejectionMapper')).toBe(rejectionMapper);
        expect(snapshotCrashDiagnostics(caught)).toEqual(pair('wallet_database', 'open'));
        expect(snapshotCrashDiagnostics(new Error('unrelated'))).toEqual({});
      } finally {
        spy.mockRestore();
        await dispose(target);
        await dispose(control);
      }
    }
  );

  // Closing explicitly disables auto-open. Diagnostics must not manufacture an
  // observed open failure when Dexie refuses the call without trying to open.
  it('preserves explicit, concurrent, implicit, reopen and upgrade behavior', async () => {
    for (const instrumented of [false, true]) {
      const target = database(instrumented);
      try {
        const [first, second] = await Promise.all([target.open(), target.open()]);
        expect(first).toBe(target);
        expect(second).toBe(target);
        target.close();
        expect(await target.open()).toBe(target);
        target.close();
        await expect(target.table(Table.Transactions).get('missing')).rejects.toBeInstanceOf(Dexie.DatabaseClosedError);
        const closed = await rejection(() => target.table(Table.Transactions).get('missing'));
        expect(snapshotCrashDiagnostics(closed)).toEqual({});
        await target.open();
        await target.table(Table.Transactions).add(row('kept'));
        target.close();
        let upgrades = 0;
        target
          .version(3.2)
          .stores({ [Table.Transactions]: TRANSACTIONS_V2_STORE })
          .upgrade(async tx => {
            upgrades++;
            await tx.table(Table.Transactions).add(row('upgraded'));
          });
        expect(await target.open()).toBe(target);
        expect(upgrades).toBe(1);
        expect(await target.table(Table.Transactions).count()).toBe(2);
      } finally {
        await dispose(target);
      }
    }
    const implicit = database();
    try {
      expect(await implicit.table(Table.Transactions).get('missing')).toBeUndefined();
      expect(implicit.isOpen()).toBe(true);
    } finally {
      await dispose(implicit);
    }
  });

  // This pre-annotation is a preservation fixture, not the positive open-boundary
  // proof: an upgrade's known failing table is more precise than its enclosing open.
  it('retains a table-owned rejection escaping a failed upgrade', async () => {
    const target = database();
    const failure = Object.freeze(new Error('upgrade mutation'));
    annotateCrash(failure, pair('wallet_limits', 'mutate'));
    try {
      await target.open();
      target.close();
      target
        .version(3.2)
        .stores({ [Table.SpendingLimits]: SPENDING_LIMITS_V19_STORE })
        .upgrade(() => {
          throw failure;
        });
      const caught = await rejection(() => target.open());
      expect(caught).toBe(failure);
      expect(snapshotCrashDiagnostics(caught)).toEqual(pair('wallet_limits', 'mutate'));
    } finally {
      await dispose(target);
    }
  });
});

describe('bounded transaction history', () => {
  const historyRow = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
    id,
    type: 'send',
    accountId: 'acc-1',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'SEND',
    faucetId: 'f1',
    ...overrides
  });

  // The legacy full read sorts by `(completedAt || initiatedAt)` and keeps primary-key order on ties.
  const legacyHistoryOrder = (rows: readonly ITransaction[], includeFailed: boolean): ITransaction[] =>
    rows
      .filter(tx => {
        const statusMatches =
          tx.status === ITransactionStatus.Completed ||
          (includeFailed && (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Unconfirmed));
        if (!statusMatches || !compareAccountIds(tx.accountId, 'acc-1')) return false;
        return (
          tx.faucetId === 'f1' ||
          (tx.type === 'swap' && tx.extraInputs?.requestedFaucetId === 'f1') ||
          tx.assetTotals?.some(total => total.faucetId === 'f1') === true
        );
      })
      .sort(
        (a, b) =>
          (a.completedAt || a.initiatedAt) - (b.completedAt || b.initiatedAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );

  it('merges the completedAt and initiatedAt indexes in the legacy order', async () => {
    const name = `history-index-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolated = createSchemaFor(name);
    const rows = [
      historyRow('neg', { completedAt: -5, initiatedAt: 100 }),
      historyRow('miss', { initiatedAt: 10 }),
      historyRow('zero-a', {
        type: 'consume',
        faucetId: 'other',
        initiatedAt: 10,
        completedAt: 0,
        assetTotals: [{ faucetId: 'f1', amount: 1n }]
      }),
      historyRow('zero-b', {
        type: 'swap',
        faucetId: 'f2',
        initiatedAt: 10,
        completedAt: 0,
        extraInputs: { requestedFaucetId: 'f1' }
      }),
      historyRow('fail', { status: ITransactionStatus.Failed, initiatedAt: 1, completedAt: 15 }),
      historyRow('fall-20', { initiatedAt: 20, completedAt: 0 }),
      historyRow('prim', { initiatedAt: 1, completedAt: 20 }),
      historyRow('tie-a', { initiatedAt: 3, completedAt: 20 }),
      historyRow('tie-b', { initiatedAt: 50, completedAt: 20 }),
      historyRow('unconf', {
        status: ITransactionStatus.Unconfirmed,
        accountId: 'acc-1_tag',
        initiatedAt: 30,
        completedAt: 30
      }),
      historyRow('other-acct', { accountId: 'acc-2', initiatedAt: 1, completedAt: 1 }),
      historyRow('other-tok', { faucetId: 'f2', initiatedAt: 12, completedAt: 12 }),
      historyRow('queued', { status: ITransactionStatus.Queued, initiatedAt: 16, completedAt: 16 }),
      historyRow('newer-wrong', { faucetId: 'f2', initiatedAt: 90, completedAt: 90 }),
      historyRow('newer-other', { accountId: 'acc-2', initiatedAt: 100, completedAt: 100 })
    ];
    try {
      await isolated.open();
      const table = isolated.table<ITransaction, string>(Table.Transactions);
      expect(table.schema.idxByName.completedAt).toBeDefined();
      expect(table.schema.idxByName.initiatedAt).toBeDefined();
      await table.bulkAdd(rows);
      const legacy = legacyHistoryOrder(rows, true).map(tx => tx.id);
      expect(legacy).toEqual([
        'neg',
        'miss',
        'zero-a',
        'zero-b',
        'fail',
        'fall-20',
        'prim',
        'tie-a',
        'tie-b',
        'unconf'
      ]);

      const openCursor = jest.spyOn(table.core, 'openCursor');
      const request = { accountId: 'acc-1', tokenId: 'f1', includeFailed: true };
      const newest = await getCompletedTransactionsPage({ ...request, fromEnd: true, limit: 3 }, table);
      const older = await getCompletedTransactionsPage({ ...request, limit: 3, cursor: newest.nextCursor }, table);
      const rest = await getCompletedTransactionsPage({ ...request, limit: 10, cursor: older.nextCursor }, table);
      const seen = [...newest.transactions, ...older.transactions, ...rest.transactions].map(tx => tx.id);

      expect(newest.transactions.map(tx => tx.id)).toEqual(['unconf', 'tie-b', 'tie-a']);
      expect(newest.rawCount).toBe(3);
      expect(newest.hasMore).toBe(true);
      expect(newest.nextCursor).toEqual({
        effectiveTimestamp: 20,
        transactionId: 'tie-a',
        status: ITransactionStatus.Completed,
        initiatedAt: 3
      });
      expect(older.transactions.map(tx => tx.id)).toEqual(['prim', 'fall-20', 'fail']);
      expect(older.nextCursor).toEqual({
        effectiveTimestamp: 15,
        transactionId: 'fail',
        status: ITransactionStatus.Failed,
        initiatedAt: 1
      });
      expect(rest.hasMore).toBe(false);
      expect(rest.rawCount).toBe(4);
      expect([...seen].reverse()).toEqual(legacy);

      const completedOnly = await getCompletedTransactionsPage(
        { accountId: 'acc-1', tokenId: 'f1', includeFailed: false, fromEnd: true, limit: 20 },
        table
      );
      expect(completedOnly.transactions.map(tx => tx.id)).toEqual(
        legacyHistoryOrder(rows, false)
          .map(tx => tx.id)
          .reverse()
      );
      expect(completedOnly.hasMore).toBe(false);

      const names = openCursor.mock.calls
        .map(call => call[0].query.index.name)
        .filter((name): name is string => typeof name === 'string');
      expect(names).toContain('completedAt');
      expect(names).toContain('initiatedAt');
      expect(names.every(name => name === 'completedAt' || name === 'initiatedAt')).toBe(true);
    } finally {
      isolated.close();
      await Dexie.delete(name);
    }
  });
});
