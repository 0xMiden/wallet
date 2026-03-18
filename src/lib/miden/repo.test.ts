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
    expect(imported[0].amount).toBe(BigInt(42));
    expect(imported[0].requestBytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
