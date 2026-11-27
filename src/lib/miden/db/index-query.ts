import Dexie, {
  type DBCoreCursor,
  type DBCoreIndex,
  type DBCoreKeyRange,
  type DBCoreRangeType,
  type Table as TransactionTable,
  type Transaction
} from 'dexie';

import type { ITransaction, ITransactionStatus } from './types';

export const RANGE_EQUAL: DBCoreRangeType = 1;
export const RANGE_BOUND: DBCoreRangeType = 2;
export const RANGE_ANY: DBCoreRangeType = 3;

export const DEFAULT_READ_CHUNK_SIZE = 64;

export function equalIndexSpec(indexName: string, key: unknown, reverse?: boolean): TransactionIndexRangeSpec {
  return {
    indexName,
    range: { type: RANGE_EQUAL, lower: key, upper: key },
    reverse
  };
}

export function statusIndexSpecs(statuses: readonly ITransactionStatus[]): TransactionIndexRangeSpec[] {
  return statuses.map(status => equalIndexSpec('status', status));
}

export function typeIndexSpecs(types: readonly ITransaction['type'][]): TransactionIndexRangeSpec[] {
  return types.map(type => equalIndexSpec('type', type));
}

export function statusTypeIndexSpecs(
  pairs: ReadonlyArray<readonly [ITransactionStatus, ITransaction['type']]>
): TransactionIndexRangeSpec[] {
  return pairs.map(([status, type]) => equalIndexSpec('[status+type]', [status, type]));
}

export interface CursorPosition {
  key: unknown;
  primaryKey: unknown;
}

export interface TransactionIndexRangeSpec {
  indexName: string;
  range: DBCoreKeyRange;
  reverse?: boolean;
}

export interface ChunkReadOptions {
  chunkSize?: number;
  limit?: number;
}

/** Checks whether `table` is a real Dexie table declaring `indexName` (false for stripped test mocks). */
export function hasTransactionIndex(
  indexName: string,
  table: TransactionTable<ITransaction, string> | undefined
): boolean {
  const schema = table?.schema;
  if (!schema) return false;
  return schema.primKey?.name === indexName || schema.idxByName?.[indexName] !== undefined;
}

/** Yields one macrotask turn so queued IndexedDB readwrite transactions can run between read chunks. */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'function') {
    return new Promise<void>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

export function isHistoryIndexRow(value: unknown): value is ITransaction {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || !('status' in value) || !('initiatedAt' in value) || !('accountId' in value)) return false;
  return typeof value.id === 'string';
}

export function historyRowFromCursor(cursor: DBCoreCursor): ITransaction {
  const value: unknown = cursor.value;
  if (!isHistoryIndexRow(value)) throw new Error('history index cursor returned a non-transaction');
  return value;
}

export function compareIdbKeys(a: unknown, b: unknown): number {
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.cmp === 'function') {
    return indexedDB.cmp(a, b);
  }
  return (Dexie as unknown as { cmp: (x: unknown, y: unknown) => number }).cmp(a, b);
}

function isIndexableIdbKey(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return true;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) return value.every(isIndexableIdbKey);
  return false;
}

function readRecordPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function extractIndexKeys(row: ITransaction, indexName: string): unknown[] {
  if (indexName.startsWith('[') && indexName.endsWith(']')) {
    const parts = indexName
      .slice(1, -1)
      .split('+')
      .map(part => readRecordPath(row, part));
    return parts.every(isIndexableIdbKey) ? [parts] : [];
  }
  const value = readRecordPath(row, indexName);
  if (Array.isArray(value)) return value.filter(isIndexableIdbKey);
  return isIndexableIdbKey(value) ? [value] : [];
}

function keyMatchesRange(key: unknown, range: DBCoreKeyRange): boolean {
  if (range.type === RANGE_ANY) return true;
  if (range.type === RANGE_EQUAL) {
    if (!isIndexableIdbKey(range.lower)) return false;
    return compareIdbKeys(key, range.lower) === 0;
  }
  if (range.type === RANGE_BOUND) {
    if (range.lower !== undefined) {
      if (!isIndexableIdbKey(range.lower)) return false;
      const cmpLower = compareIdbKeys(key, range.lower);
      if (range.lowerOpen ? cmpLower <= 0 : cmpLower < 0) return false;
    }
    if (range.upper !== undefined) {
      if (!isIndexableIdbKey(range.upper)) return false;
      const cmpUpper = compareIdbKeys(key, range.upper);
      if (range.upperOpen ? cmpUpper >= 0 : cmpUpper > 0) return false;
    }
    return true;
  }
  return false;
}

function matchesIndexSpec(row: ITransaction, spec: TransactionIndexRangeSpec): boolean {
  return extractIndexKeys(row, spec.indexName).some(key => keyMatchesRange(key, spec.range));
}

async function readMockSpecMatches(
  table: TransactionTable<ITransaction, string>,
  predicate: (row: ITransaction) => boolean,
  limit?: number
): Promise<ITransaction[]> {
  if (limit !== undefined && limit <= 0) return [];
  const cap = limit !== undefined && Number.isFinite(limit) ? Math.max(0, limit) : undefined;
  let matches: ITransaction[];
  if (typeof table.filter === 'function') {
    const collection = table.filter(predicate);
    if (typeof collection?.toArray === 'function') {
      matches = await collection.toArray();
    } else if (cap === 1 && typeof collection?.first === 'function') {
      const first = await collection.first();
      return first === undefined ? [] : [first];
    } else {
      return [];
    }
  } else if (typeof table.toArray === 'function') {
    matches = (await table.toArray()).filter(predicate);
  } else {
    return [];
  }
  return cap !== undefined ? matches.slice(0, cap) : matches;
}

function compareCursorKeyAndPk(keyA: unknown, pkA: unknown, keyB: unknown, pkB: unknown): number {
  const keyOrder = compareIdbKeys(keyA, keyB);
  if (keyOrder !== 0) return keyOrder;
  return compareIdbKeys(pkA, pkB);
}

function isBeforeTarget(cursor: DBCoreCursor, target: CursorPosition, reverse: boolean, inclusive: boolean): boolean {
  const cmp = compareCursorKeyAndPk(cursor.key, cursor.primaryKey, target.key, target.primaryKey);
  if (cmp === 0) return !inclusive;
  return reverse ? cmp > 0 : cmp < 0;
}

/**
 * Advances `cursor` to `target` using O(log N) `continuePrimaryKey` when available and strictly
 * before `target` (falling back to `continue()` if equal and `!inclusive`, or if unsupported).
 */
export function advanceCursorToTarget(
  cursor: DBCoreCursor,
  target: CursorPosition,
  reverse: boolean,
  inclusive: boolean,
  allowContinuePrimaryKey = true
): Promise<boolean> {
  if (!isBeforeTarget(cursor, target, reverse, inclusive)) return Promise.resolve(true);
  let sought = false;
  return cursor
    .start(() => {
      if (cursor.done) return;
      const cmp = compareCursorKeyAndPk(cursor.key, cursor.primaryKey, target.key, target.primaryKey);
      const strictlyBefore = reverse ? cmp > 0 : cmp < 0;
      if (strictlyBefore && !sought) {
        if (allowContinuePrimaryKey && typeof cursor.continuePrimaryKey === 'function') {
          sought = true;
          cursor.continuePrimaryKey(target.key, target.primaryKey);
          return;
        }
        const keyOrder = compareIdbKeys(cursor.key, target.key);
        if (reverse ? keyOrder > 0 : keyOrder < 0) {
          sought = true;
          cursor.continue(target.key);
          return;
        }
      }
      if (strictlyBefore || (!inclusive && cmp === 0)) {
        cursor.continue();
        return;
      }
      cursor.stop();
    })
    .then(() => cursor.done !== true);
}

function resolveCoreIndex(table: TransactionTable<ITransaction, string>, indexName: string): DBCoreIndex {
  if (indexName === table.core.schema.primaryKey.name) return table.core.schema.primaryKey;
  const index = table.core.schema.getIndexByKeyPath(indexName);
  if (index === undefined) throw new Error(`transactions ${indexName} index is missing`);
  return index;
}

/**
 * Reads matching rows across one or more index ranges in bounded cursor chunks (`chunkSize`
 * visited rows per `readonly` transaction). Yields one macrotask between chunks when no outer
 * Dexie transaction is active so background `readwrite` writes commit promptly.
 */
function readSpecChunk(
  table: TransactionTable<ITransaction, string>,
  trans: Transaction,
  spec: TransactionIndexRangeSpec,
  resumeFrom: CursorPosition | undefined,
  budget: number,
  maxNewResults: number,
  filterRow: (row: ITransaction) => boolean,
  out: ITransaction[]
): Promise<{ visited: number; exhausted: boolean; resumeAfter: CursorPosition | undefined }> {
  const index = resolveCoreIndex(table, spec.indexName);
  const reverse = spec.reverse === true;
  return table.core
    .openCursor({
      trans: trans.idbtrans,
      values: true,
      reverse,
      query: { index, range: spec.range }
    })
    .then(cursor => {
      if (cursor === null) return { visited: 0, exhausted: true, resumeAfter: undefined };
      const ready =
        resumeFrom !== undefined
          ? advanceCursorToTarget(cursor, resumeFrom, reverse, false, index.isPrimaryKey !== true)
          : Promise.resolve(true);
      return ready.then(alive => {
        if (!alive) return { visited: 0, exhausted: true, resumeAfter: undefined };
        let visited = 0;
        let added = 0;
        let resumeAfter: CursorPosition | undefined;
        return cursor
          .start(() => {
            if (cursor.done) return;
            visited += 1;
            const row = historyRowFromCursor(cursor);
            if (filterRow(row)) {
              out.push(row);
              added += 1;
              if (added >= maxNewResults) {
                cursor.stop();
                return;
              }
            }
            if (visited >= budget) {
              resumeAfter = { key: cursor.key, primaryKey: cursor.primaryKey };
              cursor.stop();
              return;
            }
            cursor.continue();
          })
          .then(() => ({
            visited,
            exhausted: cursor.done === true,
            resumeAfter: cursor.done === true ? undefined : resumeAfter
          }));
      });
    });
}

type ReadonlyTableWithInternalTrans = TransactionTable<ITransaction, string> & {
  _trans?: <T>(mode: 'readonly', fn: (_idbtrans: unknown, trans: Transaction) => Promise<T>) => Promise<T>;
};

/**
 * Runs a single-table readonly chunk on Dexie's internal `_trans` path (`tempTransaction`) so
 * standalone reads match `where()`/`toArray()` and do not deadlock on `DexiePromise.follow`'s
 * `queueMicrotask` scheduler when callers invoke `jest.useFakeTimers()`, falling back to
 * `table.db.transaction` for partial table mocks without `_trans`.
 */
function runReadonlyTableTransaction<T>(
  table: TransactionTable<ITransaction, string>,
  run: (trans: Transaction) => Promise<T>
): Promise<T> {
  const internalTable = table as ReadonlyTableWithInternalTrans;
  if (typeof internalTable._trans === 'function') {
    return internalTable._trans('readonly', (_idbtrans, trans) => run(trans));
  }
  return table.db.transaction('r', table, run);
}

/** Counts index keys in `range` up to `maxCount` without invoking `table.core.count` on large sets. */
export async function countIndexEntriesUpTo(
  table: TransactionTable<ITransaction, string>,
  indexName: string,
  range: DBCoreKeyRange,
  maxCount?: number
): Promise<number> {
  if (maxCount !== undefined && maxCount <= 0) return 0;
  if (!hasTransactionIndex(indexName, table)) {
    const matches = await readMockSpecMatches(table, row => matchesIndexSpec(row, { indexName, range }), maxCount);
    return matches.length;
  }

  const index = resolveCoreIndex(table, indexName);
  const targetLimit = maxCount ?? Infinity;

  if (targetLimit <= DEFAULT_READ_CHUNK_SIZE) {
    const runQuery = (trans: Transaction): Promise<number> =>
      table.core
        .query({
          trans: trans.idbtrans,
          values: false,
          limit: targetLimit,
          query: { index, range }
        })
        .then(res => res.result.length);
    const outerTx = Dexie.currentTransaction;
    return outerTx !== null ? runQuery(outerTx) : runReadonlyTableTransaction(table, runQuery);
  }

  let total = 0;
  let resumeAfter: CursorPosition | undefined;

  const countChunk = (trans: Transaction): Promise<boolean> =>
    table.core
      .openCursor({
        trans: trans.idbtrans,
        values: false,
        reverse: false,
        query: { index, range }
      })
      .then(cursor => {
        if (cursor === null) return true;
        const ready =
          resumeAfter !== undefined
            ? advanceCursorToTarget(cursor, resumeAfter, false, false, index.isPrimaryKey !== true)
            : Promise.resolve(true);
        return ready.then(alive => {
          if (!alive) return true;
          const chunkLimit = Math.min(DEFAULT_READ_CHUNK_SIZE, targetLimit - total);
          let visited = 0;
          let nextResume: CursorPosition | undefined;
          return cursor
            .start(() => {
              if (cursor.done) return;
              visited += 1;
              if (visited >= chunkLimit) {
                nextResume = { key: cursor.key, primaryKey: cursor.primaryKey };
                cursor.stop();
                return;
              }
              cursor.continue();
            })
            .then(() => {
              total += visited;
              if (cursor.done === true || total >= targetLimit) return true;
              resumeAfter = nextResume;
              return false;
            });
        });
      });

  const outerTx = Dexie.currentTransaction;
  if (outerTx !== null) {
    while (!(await countChunk(outerTx))) {
      // Caller owns the active transaction; keep all chunks inside it without yielding.
    }
    return total;
  }

  for (;;) {
    const done = await runReadonlyTableTransaction(table, countChunk);
    if (done) break;
    await yieldToEventLoop();
  }
  return total;
}

export async function readTransactionIndexChunks(
  table: TransactionTable<ITransaction, string>,
  specs: readonly TransactionIndexRangeSpec[],
  filterRow: (row: ITransaction) => boolean,
  options?: ChunkReadOptions
): Promise<ITransaction[]> {
  if (specs.length === 0) return [];
  if (!specs.every(spec => hasTransactionIndex(spec.indexName, table))) {
    return readMockSpecMatches(
      table,
      row => specs.some(spec => matchesIndexSpec(row, spec)) && filterRow(row),
      options?.limit
    );
  }
  const chunkSize = options?.chunkSize ?? DEFAULT_READ_CHUNK_SIZE;
  const maxResults = options?.limit ?? Infinity;
  const results: ITransaction[] = [];
  let specIndex = 0;
  let resumeAfter: CursorPosition | undefined;

  const runChunk = (trans: Transaction): Promise<boolean> => {
    let visited = 0;
    const stepNext = (): Promise<boolean> => {
      if (specIndex >= specs.length || visited >= chunkSize || results.length >= maxResults) {
        return Promise.resolve(specIndex >= specs.length || results.length >= maxResults);
      }
      const spec = specs[specIndex];
      if (spec === undefined) return Promise.resolve(true);
      return readSpecChunk(
        table,
        trans,
        spec,
        resumeAfter,
        chunkSize - visited,
        maxResults - results.length,
        filterRow,
        results
      ).then(step => {
        visited += step.visited;
        if (results.length >= maxResults) return true;
        if (step.exhausted) {
          specIndex += 1;
          resumeAfter = undefined;
          return stepNext();
        }
        resumeAfter = step.resumeAfter;
        if (visited >= chunkSize) return false;
        return stepNext();
      });
    };
    return stepNext();
  };

  const outerTx = Dexie.currentTransaction;
  if (outerTx !== null) {
    while (!(await runChunk(outerTx))) {
      // Caller owns the active transaction; keep all chunks inside it without yielding.
    }
    return results;
  }

  for (;;) {
    const done = await runReadonlyTableTransaction(table, runChunk);
    if (done) break;
    await yieldToEventLoop();
  }
  return results;
}
