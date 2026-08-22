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

/**
 * `$bigint$`, `$bigint$$`, … — the escaped forms of real data that happens to
 * have the tag's exact shape.
 *
 * The tag is a reserved word in a namespace the wallet does not control: rows
 * carry `extraInputs`, which holds objects a dApp had a hand in. An object that
 * is literally `{"$bigint": "…"}` would come back from a round-trip as a BigInt
 * rather than as itself — and when its string is not a number, `BigInt()` throws
 * and takes the whole import down with it, from data a dApp chose. Escaping by
 * appending a `$` on the way out and stripping one on the way back in is
 * reversible at every nesting level, so no object can be mistaken for a tag.
 */
const ESCAPED_BIGINT_TAG = /^\$bigint\$+$/;

/**
 * Only a canonical decimal integer is a tag this code wrote — `toString()` on a
 * BigInt produces nothing else. Anything else under the key is foreign data that
 * merely borrowed the name, and is left exactly as it is rather than fed to
 * `BigInt()` to throw.
 */
const CANONICAL_BIGINT = /^-?(0|[1-9]\d*)$/;

/** The object's only own key, or undefined if it does not have exactly one. */
const soleKeyOf = (value: object): string | undefined => {
  if (Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
};

// Requires the tag to be the object's ONLY key. A tagged BigInt this code wrote
// never has siblings, so anything that does is real data that merely resembles
// the tag — and collapsing it to a BigInt would silently discard every other
// field on it.
const isTaggedBigInt = (value: object): value is TaggedBigInt => {
  if (soleKeyOf(value) !== BIGINT_TAG) return false;
  const tagged: unknown = Reflect.get(value, BIGINT_TAG);
  return typeof tagged === 'string' && CANONICAL_BIGINT.test(tagged);
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

/**
 * These are cryptographic request/result blobs. A byte that did not survive the
 * file intact is not a cosmetic defect — it is a different blob, and nothing
 * downstream re-checks it, so the only place the damage can still be noticed is
 * here. `Uint8Array` silently truncates whatever it is handed (`999` stores as
 * `231`, `-1` as `255`, a string as `0`), which is exactly the wrong behaviour
 * for a value whose whole purpose is to be exact.
 */
const isByteValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;

const bytesFromArray = (value: unknown[], key: string): Uint8Array => {
  if (!value.every(isByteValue)) throw new Error(`importDb: ${key} contains a value that is not a byte`);
  return Uint8Array.from(value);
};

/**
 * `{"0":1,"1":2}` — what `JSON.stringify` makes of a `Uint8Array`, and so the
 * legacy on-disk shape for `resultBytes`.
 *
 * The indices have to be dense and cover exactly `0…n-1`. The previous decoder
 * sized the array by key COUNT and then read indices `0…count-1`, so a gap made
 * it read past the keys the file actually had: `{"0":1,"2":3}` restored as
 * `[1,0]`, inventing a zero and dropping the byte at 2 without a word. `{}` is
 * legitimate and stays legitimate — an empty `Uint8Array` serializes to exactly
 * that.
 */
const bytesFromIndexKeyed = (value: object, key: string): Uint8Array => {
  const entries = Object.entries(value);
  const bytes = new Uint8Array(entries.length);
  const seen = new Set<number>();
  for (const [index, entry] of entries) {
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= entries.length || seen.has(position)) {
      throw new Error(`importDb: ${key} is not a dense byte sequence`);
    }
    if (!isByteValue(entry)) throw new Error(`importDb: ${key} contains a value that is not a byte`);
    seen.add(position);
    bytes[position] = entry;
  }
  return bytes;
};

const toSerializable = (value: unknown, _key?: string, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new Error('exportDb: transaction row nested too deeply');
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(entry => toSerializable(entry, undefined, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const mapped = mapValues(value, (entry, key) => toSerializable(entry, key, depth + 1));
    const sole = soleKeyOf(mapped);
    // Real data wearing the tag's shape, escaped so the import walk gives it
    // back rather than reading it as a number this code wrote.
    if (sole !== undefined && (sole === BIGINT_TAG || ESCAPED_BIGINT_TAG.test(sole))) {
      return { [`${sole}$`]: mapped[sole] };
    }
    return mapped;
  }
  return value;
};

const fromSerializable = (value: unknown, key?: string, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new Error('importDb: dump nested too deeply');
  const isByteField = key !== undefined && BYTE_FIELDS.has(key);
  if (Array.isArray(value)) {
    // Legacy dumps stored byte arrays untagged, so they are restored by name.
    if (isByteField) return bytesFromArray(value, key);
    return value.map(entry => fromSerializable(entry, undefined, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    if (isTaggedBigInt(value)) return BigInt(value[BIGINT_TAG]);
    if (isByteField) return bytesFromIndexKeyed(value, key);
    const sole = soleKeyOf(value);
    if (sole !== undefined && ESCAPED_BIGINT_TAG.test(sole)) {
      return { [sole.slice(0, -1)]: fromSerializable(Reflect.get(value, sole), undefined, depth + 1) };
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
