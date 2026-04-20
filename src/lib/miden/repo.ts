import Dexie, { Transaction } from 'dexie';

import { ITransaction } from './db/types';

export enum Table {
  Transactions = 'transactions'
}

export const db = new Dexie('TridentMain');

db.version(1)
  .stores({
    transactionRequests: indexes('id', 'accountId', 'initiatedAt', 'completedAt')
  })
  .upgrade(async (tx: Transaction) => {
    await tx.db.table<any, string>('transactionRequests').clear();
  });

db.version(1.1)
  .stores({
    [Table.Transactions]: indexes('id', 'accountId', 'transactionId', 'initiatedAt', 'completedAt'),
    transactionRequests: null
  })
  .upgrade(async (tx: Transaction) => {
    await tx.db.table<any, string>('transactionRequests').clear();
    await tx.db.table<ITransaction, string>(Table.Transactions).clear();
  });

db.version(1.2).stores({
  [Table.Transactions]: indexes('id', 'accountId', 'transactionId', 'initiatedAt', 'completedAt', 'noteId')
});

export const transactions = db.table<ITransaction, string>(Table.Transactions);

function indexes(...items: string[]) {
  return items.join(',');
}

export async function exportDb(): Promise<string> {
  const dump: { [tableName: string]: any[] } = {};
  await db.transaction('r', transactions, async () => {
    const rawTransactions = await transactions.toArray();
    const serializableTransactions = rawTransactions.map(tx => {
      const { amount, requestBytes, ...rest } = tx;
      return {
        ...rest,
        ...(amount !== undefined && { amount: amount.toString() }),
        ...(requestBytes !== undefined && { requestBytes: Array.from(requestBytes) })
      };
    });
    dump[Table.Transactions] = serializableTransactions;
  });
  return JSON.stringify(dump);
}

export async function importDb(dump: string): Promise<void> {
  const data = JSON.parse(dump);

  if (data[Table.Transactions]) {
    const transactionsToImport = data[Table.Transactions].map((tx: any) => {
      const { amount, requestBytes, ...rest } = tx;
      return {
        ...rest,
        ...(amount !== undefined && { amount: BigInt(amount) }),
        ...(requestBytes !== undefined && { requestBytes: new Uint8Array(requestBytes) })
      };
    });

    await db.delete();
    await db.open();
    await db.transaction('rw', transactions, async () => {
      await transactions.bulkAdd(transactionsToImport);
    });
  }
}
