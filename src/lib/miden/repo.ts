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

export const transactions = db.table<ITransaction, string>(Table.Transactions);

function indexes(...items: string[]) {
  return items.join(',');
}

/**
 * Marker for a BigInt that survived `JSON.stringify`. Rows carry BigInt in more
 * than one place — the top-level `amount`, `extraInputs.requestedAmount` and
 * `orderId` on a swap, `assetTotals[].amount` on a batch claim — and hand-listing
 * them in both directions has silently broken the export before: any field added
 * later lands in the untouched rest-spread and throws "Do not know how to
 * serialize a BigInt" at `JSON.stringify`, which the export screen reports as
 * success while writing no file. Walk the value instead, so a new BigInt field
 * anywhere on a row costs nothing here.
 */
const BIGINT_TAG = '$bigint';

interface TaggedBigInt {
  [BIGINT_TAG]: string;
}

const isTaggedBigInt = (value: object): value is TaggedBigInt =>
  !Array.isArray(value) && BIGINT_TAG in value && typeof Reflect.get(value, BIGINT_TAG) === 'string';

/**
 * Byte fields stay plain number arrays, which is the shape the previous format
 * emitted for `requestBytes` — so a file written by an older build still imports.
 */
const BYTE_FIELDS = new Set(['requestBytes', 'resultBytes']);

const toSerializable = (value: unknown): unknown => {
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(toSerializable);
  if (typeof value === 'object' && value !== null) return mapValues(value, toSerializable);
  return value;
};

const fromSerializable = (value: unknown, key?: string): unknown => {
  if (Array.isArray(value)) {
    // Legacy dumps stored byte arrays untagged, so they are restored by name.
    if (key !== undefined && BYTE_FIELDS.has(key)) return new Uint8Array(value);
    return value.map(entry => fromSerializable(entry));
  }
  if (typeof value === 'object' && value !== null) {
    if (isTaggedBigInt(value)) return BigInt(value[BIGINT_TAG]);
    return mapValues(value, fromSerializable);
  }
  return value;
};

function mapValues(source: object, transform: (value: unknown, key: string) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, transform(value, key)]));
}

const isBigIntSource = (value: unknown): value is string | bigint =>
  typeof value === 'string' || typeof value === 'bigint';

export async function exportDb(): Promise<string> {
  const dump: { [tableName: string]: unknown[] } = {};
  await db.transaction('r', transactions, async () => {
    const rawTransactions = await transactions.toArray();
    const serializableTransactions = rawTransactions.map(({ amount, ...rest }) => ({
      ...mapValues(rest, toSerializable),
      // `amount` keeps its plain-string shape so files stay readable by builds
      // that predate the tag; `fromSerializable` accepts either form.
      ...(amount !== undefined && { amount: amount.toString() })
    }));
    dump[Table.Transactions] = serializableTransactions;
  });
  return JSON.stringify(dump);
}

export async function importDb(dump: string): Promise<void> {
  const data = JSON.parse(dump);

  if (data[Table.Transactions]) {
    const transactionsToImport = data[Table.Transactions].map((tx: object) => {
      const { amount, ...rest } = mapValues(tx, fromSerializable);
      return {
        ...rest,
        ...(isBigIntSource(amount) && { amount: BigInt(amount) })
      };
    });

    await db.delete();
    await db.open();
    await db.transaction('rw', transactions, async () => {
      await transactions.bulkAdd(transactionsToImport);
    });
  }
}
