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

function keyTypeRank(v: unknown): number {
  if (typeof v === 'number') return 0;
  if (v instanceof Date) return 1;
  if (typeof v === 'string') return 2;
  if (Array.isArray(v)) return 3;
  return 4;
}

function compareIdbKeys(a: unknown, b: unknown): number {
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.cmp === 'function') {
    return indexedDB.cmp(a, b);
  }
  const ra = keyTypeRank(a);
  const rb = keyTypeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const diff = compareIdbKeys(a[i], b[i]);
      if (diff !== 0) return diff;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) {
    const ta = a.getTime();
    const tb = b.getTime();
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return 0;
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

export async function readTransactionIndexChunks(
  table: TransactionTable<ITransaction, string>,
  specs: readonly TransactionIndexRangeSpec[],
  filterRow: (row: ITransaction) => boolean,
  options?: ChunkReadOptions
): Promise<ITransaction[]> {
  if (specs.length === 0) return [];
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
    const done = await table.db.transaction('r', table, runChunk);
    if (done) break;
    await yieldToEventLoop();
  }
  return results;
}
