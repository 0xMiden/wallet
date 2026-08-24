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

// v1.3 — `bridge` → `bridged-send`. Adds an index on the EVM destination so the
// activity-detail claim flow can look a bridged send up by recipient, and
// rewrites legacy `bridge` rows into the richer `BridgedSendTransaction` shape
// (structured `extraInputs` with provider + claim status) so readers only ever
// deal with one discriminator. All legacy rows were Agglayer Miden→EVM bridges.
db.version(1.3)
  .stores({
    [Table.Transactions]: indexes(
      'id',
      'accountId',
      'transactionId',
      'initiatedAt',
      'completedAt',
      'noteId',
      'extraInputs.destinationAddress'
    )
  })
  .upgrade(async (tx: Transaction) => {
    await tx.db
      .table<any, string>(Table.Transactions)
      .toCollection()
      .modify(t => {
        if (t.type !== 'bridge') return;
        const prev = t.extraInputs ?? {};
        t.type = 'bridged-send';
        t.extraInputs = {
          provider: 'agglayer',
          destinationAddress: prev.destinationAddress ?? '',
          destinationNetwork: prev.destinationNetwork ?? 0,
          sourceFaucetId: t.faucetId ?? '',
          // ITransactionStatus.Completed === 2. A completed Miden-side bridge may
          // still need an L1 claim; anything else never reached that point.
          claimStatus: t.status === 2 ? 'pending' : 'not-applicable'
        };
      });
  });

// v1.4 — batch consume. Multi-entry index on `noteIds` so the consume dedup can
// find a note that's part of an in-flight batch row (whose scalar `noteId` only
// holds the first note). Backfills `noteIds = [noteId]` on existing consume rows
// so readers can rely on the array shape going forward.
db.version(1.4)
  .stores({
    [Table.Transactions]: indexes(
      'id',
      'accountId',
      'transactionId',
      'initiatedAt',
      'completedAt',
      'noteId',
      '*noteIds',
      'extraInputs.destinationAddress'
    )
  })
  .upgrade(async (tx: Transaction) => {
    await tx.db
      .table<any, string>(Table.Transactions)
      .toCollection()
      .modify(t => {
        if (t.type === 'consume' && t.noteId && !Array.isArray(t.noteIds)) {
          t.noteIds = [t.noteId];
        }
      });
  });

// v1.5 — private-note delivery sweep. Indexes `noteDelivery` so the sweep can ask
// for the handful of rows that still owe or may owe a delivery instead of scanning
// the whole history every cycle. No upgrade step: Dexie omits records whose index
// key is `undefined`, and `undefined` is exactly the "no relay applies" case (public
// sends, non-relaying types, and every row written before the field existed), so an
// un-backfilled table already yields the correct — empty — result.
db.version(1.5).stores({
  [Table.Transactions]: indexes(
    'id',
    'accountId',
    'transactionId',
    'initiatedAt',
    'completedAt',
    'noteId',
    '*noteIds',
    'noteDelivery',
    'extraInputs.destinationAddress'
  )
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
