import Dexie, { Transaction } from 'dexie';

import { ITransaction, ITransactionStatus } from './db/types';

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

// Requires the tag to be the object's ONLY key. A tagged BigInt this code wrote
// never has siblings, so anything that does is real data that merely resembles
// the tag — and collapsing it to a BigInt would silently discard every other
// field on it.
const isTaggedBigInt = (value: object): value is TaggedBigInt => {
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === BIGINT_TAG && typeof Reflect.get(value, BIGINT_TAG) === 'string';
};

/**
 * Byte fields stay plain number arrays, which is the shape the previous format
 * emitted for `requestBytes` — so a file written by an older build still imports.
 * `resultBytes` rode the untouched rest-spread back then, and `JSON.stringify`
 * turns a `Uint8Array` into `{"0":1,"1":2}` rather than an array, so the legacy
 * shape for that one is an index-keyed object.
 */
const BYTE_FIELDS = new Set(['requestBytes', 'resultBytes']);

/**
 * A transaction row nests two or three levels. The bound exists so a malformed
 * file fails here, in the pure mapping step, instead of surviving the walk to
 * become a partial write — and so a hostile dump cannot recurse the walker into
 * a stack overflow. `importDb` replaces the table atomically, so a failure at
 * either point costs the user nothing; failing early just keeps the reason close
 * to the cause.
 */
const MAX_WALK_DEPTH = 64;

// `{}` counts: an empty `Uint8Array` is exactly what the old format serialized to
// an empty object, so rejecting it would restore `resultBytes` as a plain object
// where the type promises bytes. Only ever consulted for known byte fields.
const isIndexKeyedBytes = (value: object): boolean =>
  Object.entries(value).every(([key, entry]) => String(Number(key)) === key && typeof entry === 'number') &&
  !isTaggedBigInt(value);

const toSerializable = (value: unknown, _key?: string, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new Error('exportDb: transaction row nested too deeply');
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(entry => toSerializable(entry, undefined, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return mapValues(value, (entry, key) => toSerializable(entry, key, depth + 1));
  }
  return value;
};

const fromSerializable = (value: unknown, key?: string, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new Error('importDb: dump nested too deeply');
  const isByteField = key !== undefined && BYTE_FIELDS.has(key);
  if (Array.isArray(value)) {
    // Legacy dumps stored byte arrays untagged, so they are restored by name.
    if (isByteField) return new Uint8Array(value);
    return value.map(entry => fromSerializable(entry, undefined, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    if (isTaggedBigInt(value)) return BigInt(value[BIGINT_TAG]);
    if (isByteField && isIndexKeyedBytes(value)) {
      return new Uint8Array(Object.keys(value).length).map((_, index) => Number(Reflect.get(value, String(index))));
    }
    return mapValues(value, (entry, entryKey) => fromSerializable(entry, entryKey, depth + 1));
  }
  return value;
};

function mapValues(source: object, transform: (value: unknown, key: string) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, transform(value, key)]));
}

/** `number` is accepted because the pre-tag importer coerced it through `BigInt`. */
const isBigIntSource = (value: unknown): value is string | number | bigint =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';

const IMPORTED_UNFINISHED_REASON = 'Not restored — a backup carries history, not pending work';

/**
 * Land every imported row in a terminal state, flagged as restored.
 *
 * A backup is a record of what HAPPENED. A row restored as `Queued` is not a
 * record, it is a work item: `safeGenerateTransactionsLoop` picks up any queued
 * row it finds, with no check on where the row came from, and drives it through
 * the signer — so a hostile or tampered backup could otherwise have the wallet
 * sign and broadcast a send the user never authorised, with no confirmation
 * step. Even an honest backup's queued row is stale by restore time and would
 * only fail against chain state that has moved on.
 *
 * `GeneratingTransaction` gets the same treatment: it is the other non-terminal
 * status, and the loop's in-progress check would stall on it forever.
 *
 * `Failed` alone is NOT enough. `isRequeueableTransaction` offers a one-tap
 * Retry on any failed send/consume/swap/bridged-send/execute, and that requeue
 * re-signs the row's original recipient and amount with no confirmation — so
 * stopping at `Failed` would just move the unattended signature one tap away.
 * `restoredFromBackup` is the durable marker that keeps the row inert; every
 * row in the dump carries it, not only the ones neutralized here, so a restored
 * *completed* row is also identifiable as unverified local data rather than
 * something this wallet witnessed on chain.
 *
 * The terminal shape has to match `cancelTransaction`'s, because failing a row
 * moves it onto the completed-history path: `getCompletedTransactions` includes
 * failed rows, and that path reads `completedAt` as the row's timestamp with no
 * fallback — a missing one becomes an invalid `Date` and throws while grouping
 * history by day, taking down the whole activity list.
 */
const neutralizeUnfinishedTransaction = <T extends object>(tx: T): T => {
  // Spread FIRST, literal second: reversing these two would let a dump supply
  // its own `restoredFromBackup: false` and disable the whole gate.
  const restored = { ...tx, restoredFromBackup: true };
  const status = Reflect.get(tx, 'status');
  // An allow-list of the terminal statuses, not a deny-list of the running ones.
  // A dump is free to carry `status: 99`, or the string `"0"`, or no status at
  // all; every consumer compares with `===`, so such a row is invisible in every
  // history view while still occupying its id — and a deny-list would wave it
  // through unstamped. Anything not recognisably terminal is treated as unfinished.
  if (status === ITransactionStatus.Completed || status === ITransactionStatus.Failed) {
    return restored;
  }
  const initiatedAt = Reflect.get(tx, 'initiatedAt');
  return {
    ...restored,
    status: ITransactionStatus.Failed,
    error: IMPORTED_UNFINISHED_REASON,
    // `displayIcon`/`displayMessage` are re-derived for failed rows when history
    // renders, so only the fields history reads straight off the row are set here.
    completedAt: typeof initiatedAt === 'number' ? initiatedAt : Math.floor(Date.now() / 1000)
  };
};

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
      const imported = {
        ...rest,
        ...(isBigIntSource(amount) && { amount: BigInt(amount) })
      };
      return neutralizeUnfinishedTransaction(imported);
    });

    // Replace in ONE transaction rather than `db.delete()` + `bulkAdd`. Deleting
    // first commits the destruction before a single row is written, so anything
    // `bulkAdd` rejects on — a dump with duplicate ids, a storage quota, a key
    // the schema will not accept — leaves the user with no history and nothing
    // to restore from. Inside a transaction Dexie rolls the `clear` back with
    // the failed add, so a bad dump costs the user nothing.
    //
    // `clear()` covers what `db.delete()` did: `transactions` is the only live
    // table (`transactionRequests` was dropped in v1.1), and the rows are
    // written into the current schema either way.
    await db.transaction('rw', transactions, async () => {
      await transactions.clear();
      await transactions.bulkAdd(transactionsToImport);
    });
  }
}
