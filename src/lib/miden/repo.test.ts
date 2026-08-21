import { ITransactionStatus } from './db/types';
import { exportDb, importDb, transactions, Table } from './repo';

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

  // Files written before the BigInt tag existed keep importing. `amount` was a
  // plain string and `requestBytes` an untagged number array; `resultBytes` rode
  // the untouched rest-spread, and `JSON.stringify` renders a `Uint8Array` as an
  // index-keyed object rather than an array.
  it('imports a legacy dump whose amount and byte fields are untagged', async () => {
    await importDb(
      JSON.stringify({
        [Table.Transactions]: [
          {
            id: 'legacy-1',
            type: 'send',
            status: ITransactionStatus.Completed,
            accountId: 'acc1',
            initiatedAt: 3,
            amount: '42',
            requestBytes: [1, 2, 3],
            resultBytes: { '0': 9, '1': 8, '2': 7 },
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
    // The row survives as a record -- only its ability to execute is removed.
    expect(restored!.id).toBe('injected');
    expect(restored!.amount).toBe(BigInt(999999));
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
    const restored = new Map((await transactions.toArray()).map(tx => [tx.id, tx.status]));
    expect(restored.get('done')).toBe(ITransactionStatus.Completed);
    expect(restored.get('bad')).toBe(ITransactionStatus.Failed);
  });
});
