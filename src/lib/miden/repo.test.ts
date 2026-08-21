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

  // Files written before the BigInt tag existed keep importing: `amount` as a
  // plain string and `requestBytes` as an untagged number array.
  it('imports a legacy dump whose byte array and amount are untagged', async () => {
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
            displayIcon: 'SEND'
          }
        ]
      })
    );

    const imported = await transactions.toArray();
    expect(imported[0]!.amount).toBe(BigInt(42));
    expect(imported[0]!.requestBytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
