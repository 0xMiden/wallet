import { ITransaction, ITransactionStatus } from './db/types';
import { exportDb, importDb, transactions, Table } from './repo';
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
    expect(restored).toEqual(original);
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
      ['a non-number', { requestBytes: [1, 'two', 3] }],
      ['a value above 255, index-keyed', { resultBytes: { '0': 9, '1': 300 } }]
    ])('is rejected rather than truncated: %s', async (_label, fields) => {
      await expect(importDb(dumpWith(fields))).rejects.toThrow(/is not a byte/);
    });

    // The old decoder sized the array by key COUNT and then read 0…count-1, so a
    // gap made it read a key the file did not have: this restored as [1, 0],
    // inventing a zero and dropping the byte at index 2 without a word.
    it.each([
      ['a gap', { resultBytes: { '0': 1, '2': 3 } }],
      ['an index past the end', { resultBytes: { '0': 1, '5': 3 } }],
      ['a negative index', { resultBytes: { '0': 1, '-1': 3 } }],
      ['a non-numeric key', { resultBytes: { '0': 1, x: 3 } }]
    ])('is rejected rather than silently reshaped: %s', async (_label, fields) => {
      await expect(importDb(dumpWith(fields))).rejects.toThrow(/dense byte sequence/);
    });

    // An empty Uint8Array serializes to exactly this, so it has to stay valid.
    it('accepts an empty index-keyed object as an empty byte array', async () => {
      await importDb(dumpWith({ resultBytes: {} }));
      expect((await transactions.toArray())[0]!.resultBytes).toEqual(new Uint8Array([]));
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

  it('restores row statuses verbatim', async () => {
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
  });
});
