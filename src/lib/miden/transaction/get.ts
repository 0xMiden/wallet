import { PswapLineageState } from '@miden-sdk/miden-sdk/lazy';
import Dexie, { type DBCoreKeyRange, type Table, type Transaction as DexieTransaction } from 'dexie';

import {
  type ChunkReadOptions,
  countIndexEntriesUpTo,
  DEFAULT_READ_CHUNK_SIZE,
  equalIndexSpec,
  hasTransactionIndex,
  RANGE_ANY,
  RANGE_BOUND,
  readTransactionIndexChunks,
  statusIndexSpecs,
  statusTypeIndexSpecs,
  type TransactionIndexRangeSpec,
  yieldToEventLoop
} from 'lib/miden/db/index-query';
import * as Repo from 'lib/miden/repo';

import { findAdoptableShortfallRow } from './rotation-funding';
import { COMPLETED_HOLD_GRACE_SEC, isNoteHoldingRow } from './verdict-rules';
import { compareAccountIds } from '../activity/utils';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ITransaction, ITransactionStatus, Transaction } from '../db/types';
import { isSyncFused } from '../front/sync-fuse';
import { sameWalletAccountId } from '../sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';

/**
 * Token-scoped history filter. A row belongs to a token view whenever it moved
 * that token, which is not always the faucet it is filed under:
 *
 * - A swap is filed under the offered `faucetId` but also delivers the requested
 *   faucet, and the consume that settles that delivery is suppressed in history
 *   (the swap row is the order's single trace) — so without the requested-side
 *   match the received funds would appear in no row of that token's history.
 * - A batch claim is filed under its FIRST note's faucet while sweeping up every
 *   other faucet in `assetTotals`. Same argument: a claim of 20 A and 10 B is
 *   filed under A, so B's history would never show the 10 B arriving.
 */
const matchesTokenId = (tx: ITransaction, tokenId: string): boolean =>
  tx.faucetId === tokenId ||
  (tx.type === 'swap' && tx.extraInputs?.requestedFaucetId === tokenId) ||
  tx.assetTotals?.some(total => total.faucetId === tokenId) === true;

const readByStatusIndex = async (
  statuses: readonly ITransactionStatus[],
  filterRow: (row: ITransaction) => boolean = () => true,
  options?: ChunkReadOptions
): Promise<ITransaction[]> =>
  readTransactionIndexChunks(Repo.transactions, statusIndexSpecs(statuses), filterRow, options);

export const hasQueuedTransactions = async () =>
  (await countIndexEntriesUpTo(
    Repo.transactions,
    'status',
    equalIndexSpec('status', ITransactionStatus.Queued).range,
    1
  )) > 0;

export const getUncompletedTransactions = async (address: string, tokenId?: string) => {
  const statuses = [ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction];
  return await getTransactionsInStatuses(statuses, address, tokenId);
};

const getTransactionsInStatuses = async (statuses: ITransactionStatus[], accountId: string, tokenId?: string) => {
  const txs = await readByStatusIndex(
    statuses,
    tx => compareAccountIds(tx.accountId, accountId) && (!tokenId || matchesTokenId(tx, tokenId))
  );
  // Same tie-break as the processing loop's picker, for the same reason and so the two
  // agree: `initiatedAt` is whole seconds, so rows queued in the same second tie and a
  // stable sort falls back to Dexie's primary-key order over random `uuid()`s. Without
  // this, the queue a caller reads here could be ordered differently from the order the
  // loop will actually process.
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt || (tx1.queuedSeq ?? 0) - (tx2.queuedSeq ?? 0));

  return txs;
};

export const getTransactionsInProgress = async (): Promise<Transaction[]> => {
  const txs = await readByStatusIndex([ITransactionStatus.GeneratingTransaction]);
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

export const getAllUncompletedTransactions = async () => {
  const txs = await readByStatusIndex([ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction]);
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

/**
 * True when the account's everyday-key rotation waits for funds (#805), so the rotation gate shows its funding panel:
 * `findAdoptableShortfallRow` finds the row the gate adopts.
 */
export const isRotationAwaitingFunding = async (accountPublicKey: string, rotationRequest?: string): Promise<boolean> =>
  (await findAdoptableShortfallRow(accountPublicKey, rotationRequest)) !== undefined;

/**
 * True when the encrypted backup restored at least one row of this account from another device, so
 * the backup, not the Guardian, is the record of this account's history. A Guardian-recovered receipt
 * carries `restoredFromBackup` too, with `recovered`, and is excluded: it is the Guardian pass's own
 * (possibly partial) work, not the backup's.
 */
export const hasRestoredTransactionsOf = async (accountPublicKey: string): Promise<boolean> => {
  const matches = await readTransactionIndexChunks(
    Repo.transactions,
    [{ indexName: 'id', range: { type: RANGE_ANY, lower: undefined, upper: undefined } }],
    tx =>
      tx.restoredFromBackup === true && tx.recovered !== true && sameWalletAccountId(tx.accountId, accountPublicKey),
    { limit: 1 }
  );
  return matches.length > 0;
};

export const getFailedTransactions = async () => {
  const transactions = await readByStatusIndex([ITransactionStatus.Failed]);
  transactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return transactions;
};

/** Rows waiting for the node's verdict on an unknown submit outcome (#1081). */
export const getUnconfirmedTransactions = async () => {
  const transactions = await readByStatusIndex([ITransactionStatus.Unconfirmed]);
  transactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return transactions;
};

/**
 * Page boundary. `effectiveTimestamp` is `(completedAt || initiatedAt)`; `transactionId`
 * breaks ties so a page can resume within a timestamp without buffering its full group.
 */
export interface CompletedHistoryCursor {
  effectiveTimestamp: number;
  transactionId: string;
  status?: ITransactionStatus;
  initiatedAt?: number;
}

export interface CompletedTransactionsPageRequest {
  accountId: string;
  limit: number;
  includeFailed?: boolean;
  tokenId?: string;
  /** Newest page. Ignores `cursor`, the same way the unpaged refresh ignores its offset. */
  fromEnd?: boolean;
  /** Rows strictly older than this key. The newest page leaves it empty. */
  cursor?: CompletedHistoryCursor | null;
}

export interface CompletedTransactionsPage {
  /** Newest first, so the last row is the older boundary. */
  transactions: ITransaction[];
  /** Raw matches in `transactions`, before linked-consume suppression. */
  rawCount: number;
  hasMore: boolean;
  nextCursor: CompletedHistoryCursor | null;
}

type HistoryDirection = 'asc' | 'desc';

type OpenedHistoryCursor = NonNullable<Awaited<ReturnType<typeof Repo.openTransactionIndexCursor>>>;

interface HistorySource {
  stream: 'positive' | 'negative' | 'fallback';
  cursor: OpenedHistoryCursor | null;
}

interface BoundedHistoryRead {
  accountId: string;
  tokenId?: string;
  includeFailed: boolean;
  direction: HistoryDirection;
  offset: number;
  limit: number;
  bound: CompletedHistoryCursor | null;
  probe: boolean;
  table: Table<ITransaction, string>;
}

const effectiveHistoryTimestamp = (tx: ITransaction): number => tx.completedAt || tx.initiatedAt;

export const historyCursorOf = (tx: ITransaction): CompletedHistoryCursor => ({
  effectiveTimestamp: effectiveHistoryTimestamp(tx),
  transactionId: tx.id,
  status: tx.status,
  initiatedAt: tx.initiatedAt
});

const compareHistoryId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Page cursors use ids to resume within equal timestamps without buffering the bucket. */
export const comparePageHistory = (a: CompletedHistoryCursor, b: CompletedHistoryCursor): number => {
  const time = a.effectiveTimestamp - b.effectiveTimestamp;
  if (time !== 0) return time;
  return compareHistoryId(a.transactionId, b.transactionId);
};

const historyStatusRank = (status: ITransactionStatus): number => {
  if (status === ITransactionStatus.Completed) return 0;
  if (status === ITransactionStatus.Failed) return 1;
  if (status === ITransactionStatus.Unconfirmed) return 2;
  return 3;
};

/** Oldest-first display order, preserving status and initiation ties from the history feed. */
export const compareCompletedHistory = (a: CompletedHistoryCursor, b: CompletedHistoryCursor): number => {
  const time = a.effectiveTimestamp - b.effectiveTimestamp;
  if (time !== 0) return time;
  if (a.transactionId === b.transactionId) return 0;
  if (a.status === undefined || b.status === undefined || a.initiatedAt === undefined || b.initiatedAt === undefined) {
    return compareHistoryId(a.transactionId, b.transactionId);
  }
  const rank = historyStatusRank(a.status) - historyStatusRank(b.status);
  if (rank !== 0) return rank;
  if (a.status !== ITransactionStatus.Failed && a.status !== ITransactionStatus.Unconfirmed) {
    return compareHistoryId(a.transactionId, b.transactionId);
  }
  const initiated = a.initiatedAt - b.initiatedAt;
  return initiated !== 0 ? initiated : compareHistoryId(a.transactionId, b.transactionId);
};

const hasRecordedCompletion = (tx: ITransaction): boolean => Boolean(tx.completedAt);

const isPositiveCompletion = (tx: ITransaction): boolean => {
  const completedAt = tx.completedAt;
  return typeof completedAt === 'number' && completedAt > 0;
};

const isNegativeCompletion = (tx: ITransaction): boolean => {
  const completedAt = tx.completedAt;
  return typeof completedAt === 'number' && completedAt < 0;
};

const earlierHistoryRow = (a: ITransaction, b: ITransaction): boolean =>
  comparePageHistory(historyCursorOf(a), historyCursorOf(b)) < 0;

const historyPrefers = (row: ITransaction, other: ITransaction, direction: HistoryDirection): boolean =>
  direction === 'asc' ? earlierHistoryRow(row, other) : earlierHistoryRow(other, row);

const onHistorySide = (
  tx: ITransaction,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): boolean => {
  if (bound === null) return true;
  const order = comparePageHistory(historyCursorOf(tx), bound);
  if (order === 0) return false;
  return direction === 'asc' ? order > 0 : order < 0;
};

const completedHistoryRowMatches = (
  tx: ITransaction,
  accountId: string,
  tokenId: string | undefined,
  includeFailed: boolean
): boolean => {
  const statusMatches =
    tx.status === ITransactionStatus.Completed ||
    (includeFailed && (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Unconfirmed));
  if (!statusMatches) return false;
  if (!compareAccountIds(tx.accountId, accountId)) return false;
  if (tokenId && !matchesTokenId(tx, tokenId)) return false;
  return true;
};

const inHistoryStream = (source: HistorySource, tx: ITransaction): boolean => {
  if (source.stream === 'positive') return isPositiveCompletion(tx);
  if (source.stream === 'negative') return isNegativeCompletion(tx);
  return !hasRecordedCompletion(tx);
};

const historyCandidate = (
  source: HistorySource,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): ITransaction | null => {
  const cursor = source.cursor;
  if (cursor === null || cursor.done) return null;
  const row = cursor.value;
  if (!onHistorySide(row, direction, bound) || !inHistoryStream(source, row)) return null;
  return row;
};

/**
 * A fallback row's effective time is its `initiatedAt`. Once that key is strictly older than the
 * rival completed head, every later fallback row is too, so the cursor stays put instead of
 * walking the rest of the index to skip rows the completed stream already owns.
 */
const fallbackCouldPrecedeRival = (initiatedAt: number, rivalTime: number, direction: HistoryDirection): boolean =>
  direction === 'desc' ? initiatedAt >= rivalTime : initiatedAt <= rivalTime;

const retireDoneCursor = (source: HistorySource): void => {
  if (source.cursor !== null && source.cursor.done) source.cursor = null;
};

const HISTORY_CHUNK_STEPS = DEFAULT_READ_CHUNK_SIZE;

const canPruneHistoryStreams = (table: Table<ITransaction, string>): boolean =>
  hasTransactionIndex('status', table) &&
  hasTransactionIndex('[status+completedAt]', table) &&
  hasTransactionIndex('completedAt', table);

interface HistoryStreamState {
  positiveExhausted: boolean;
  negativeExhausted: boolean;
  fallbackExhausted: boolean;
  positiveResumeAt?: Repo.HistoryIndexPosition;
  negativeResumeAt?: Repo.HistoryIndexPosition;
  fallbackResumeAt?: Repo.HistoryIndexPosition;
}

const alignCompletedSource = async (
  source: HistorySource,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  canStep: () => boolean,
  onStep: () => void
): Promise<boolean> => {
  retireDoneCursor(source);
  while (source.cursor !== null && !source.cursor.done) {
    const row = source.cursor.value;
    if (inHistoryStream(source, row) && onHistorySide(row, direction, bound)) return true;
    if (!canStep()) return false;
    onStep();
    source.cursor = await source.cursor.next();
  }
  source.cursor = null;
  return true;
};

const alignFallbackSource = async (
  source: HistorySource,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  rivalTime: number | null,
  canStep: () => boolean,
  onStep: () => void
): Promise<boolean> => {
  retireDoneCursor(source);
  while (source.cursor !== null && !source.cursor.done) {
    const row = source.cursor.value;
    if (!onHistorySide(row, direction, bound)) {
      if (!canStep()) return false;
      onStep();
      source.cursor = await source.cursor.next();
      continue;
    }
    if (!hasRecordedCompletion(row)) return true;
    if (rivalTime !== null && !fallbackCouldPrecedeRival(row.initiatedAt, rivalTime, direction)) return true;
    if (!canStep()) return false;
    onStep();
    source.cursor = await source.cursor.next();
  }
  source.cursor = null;
  return true;
};

const pickHistorySource = (
  sources: readonly HistorySource[],
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): { source: HistorySource; row: ITransaction } | null => {
  let picked: { source: HistorySource; row: ITransaction } | null = null;
  for (const source of sources) {
    const row = historyCandidate(source, direction, bound);
    if (row === null) continue;
    if (picked === null || historyPrefers(row, picked.row, direction)) picked = { source, row };
  }
  return picked;
};

const pullHistoryRow = async (
  sources: HistorySource[],
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  canStep: () => boolean,
  onStep: () => void
): Promise<{ row: ITransaction | null; paused: boolean }> => {
  const positive = sources[0];
  const negative = sources[1];
  const fallback = sources[2];
  if (positive === undefined || negative === undefined || fallback === undefined) return { row: null, paused: false };
  if (!(await alignCompletedSource(positive, direction, bound, canStep, onStep))) return { row: null, paused: true };
  if (!(await alignCompletedSource(negative, direction, bound, canStep, onStep))) return { row: null, paused: true };
  const rival = pickHistorySource([positive, negative], direction, bound);
  const alignedFallback = await alignFallbackSource(
    fallback,
    direction,
    bound,
    rival === null ? null : effectiveHistoryTimestamp(rival.row),
    canStep,
    onStep
  );
  if (!alignedFallback) return { row: null, paused: true };
  const picked = pickHistorySource(sources, direction, bound);
  if (picked === null) return { row: null, paused: false };
  const cursor = picked.source.cursor;
  if (cursor !== null) {
    onStep();
    picked.source.cursor = await cursor.next();
    retireDoneCursor(picked.source);
  }
  return { row: picked.row, paused: false };
};

const positiveIndexBound = (
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  resumeAt?: Repo.HistoryIndexPosition
): Repo.HistoryIndexBound | null => {
  if (direction === 'desc' && bound !== null && bound.effectiveTimestamp <= 0) return null;
  const resume = resumeAt
    ? { resumeAt }
    : bound !== null && bound.effectiveTimestamp > 0
      ? { resumeAfter: { key: bound.effectiveTimestamp, primaryKey: bound.transactionId } }
      : {};
  if (bound === null || direction === 'asc') {
    if (direction === 'asc' && bound !== null && bound.effectiveTimestamp > 0) {
      return { lower: bound.effectiveTimestamp, lowerOpen: false, ...resume };
    }
    return { lower: 0, lowerOpen: true, ...resume };
  }
  return { lower: 0, lowerOpen: true, upper: bound.effectiveTimestamp, upperOpen: false, ...resume };
};

const negativeIndexBound = (
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  resumeAt?: Repo.HistoryIndexPosition
): Repo.HistoryIndexBound | null => {
  const resume = resumeAt
    ? { resumeAt }
    : bound !== null && bound.effectiveTimestamp < 0
      ? { resumeAfter: { key: bound.effectiveTimestamp, primaryKey: bound.transactionId } }
      : {};
  if (direction === 'asc') {
    if (bound === null) return { upper: 0, upperOpen: true, ...resume };
    if (bound.effectiveTimestamp >= 0) return null;
    return { lower: bound.effectiveTimestamp, lowerOpen: false, upper: 0, upperOpen: true, ...resume };
  }
  if (bound !== null && bound.effectiveTimestamp < 0) {
    return { upper: bound.effectiveTimestamp, upperOpen: false, ...resume };
  }
  return { upper: 0, upperOpen: true, ...resume };
};

const fallbackIndexBound = (
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  resumeAt?: Repo.HistoryIndexPosition
): Repo.HistoryIndexBound | undefined => {
  const resume = resumeAt
    ? { resumeAt }
    : bound !== null
      ? { resumeAfter: { key: bound.effectiveTimestamp, primaryKey: bound.transactionId } }
      : {};
  if (bound === null) return resumeAt ? resume : undefined;
  if (direction === 'desc') return { upper: bound.effectiveTimestamp, upperOpen: false, ...resume };
  return { lower: bound.effectiveTimestamp, lowerOpen: false, ...resume };
};

const openHistorySources = async (
  table: Table<ITransaction, string>,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  state: HistoryStreamState
): Promise<HistorySource[]> => {
  const reverse = direction === 'desc';
  const positiveBound = state.positiveExhausted ? null : positiveIndexBound(direction, bound, state.positiveResumeAt);
  const negativeBound = state.negativeExhausted ? null : negativeIndexBound(direction, bound, state.negativeResumeAt);
  const fallbackBound = state.fallbackExhausted ? null : fallbackIndexBound(direction, bound, state.fallbackResumeAt);
  const positive =
    positiveBound === null ? null : await Repo.openTransactionIndexCursor(table, 'completedAt', reverse, positiveBound);
  const negative =
    negativeBound === null ? null : await Repo.openTransactionIndexCursor(table, 'completedAt', reverse, negativeBound);
  const fallback = state.fallbackExhausted
    ? null
    : await Repo.openTransactionIndexCursor(table, 'initiatedAt', reverse, fallbackBound ?? undefined);
  return [
    { stream: 'positive', cursor: positive },
    { stream: 'negative', cursor: negative },
    { stream: 'fallback', cursor: fallback }
  ];
};

const saveMergeStreamPositions = (sources: readonly HistorySource[], state: HistoryStreamState): void => {
  const pos = sources[0]?.cursor;
  if (pos === undefined || pos === null || pos.done || pos.value.completedAt === undefined) {
    state.positiveExhausted = true;
    state.positiveResumeAt = undefined;
  } else {
    state.positiveResumeAt = { key: pos.value.completedAt, primaryKey: pos.value.id };
  }
  const neg = sources[1]?.cursor;
  if (neg === undefined || neg === null || neg.done || neg.value.completedAt === undefined) {
    state.negativeExhausted = true;
    state.negativeResumeAt = undefined;
  } else {
    state.negativeResumeAt = { key: neg.value.completedAt, primaryKey: neg.value.id };
  }
  const fall = sources[2]?.cursor;
  if (fall === undefined || fall === null || fall.done) {
    state.fallbackExhausted = true;
    state.fallbackResumeAt = undefined;
  } else {
    state.fallbackResumeAt = { key: fall.value.initiatedAt, primaryKey: fall.value.id };
  }
};

interface HistoryStreamCacheEntry {
  negativeExhausted: boolean;
  fallbackExhausted: boolean;
  missingEpoch: number;
  negativeCompletedEpoch: number;
  removalEpoch: number;
}

interface HistoryStreamCachePair {
  false?: HistoryStreamCacheEntry;
  true?: HistoryStreamCacheEntry;
}

const historyStreamCache = new WeakMap<Table<ITransaction, string>, HistoryStreamCachePair>();

const missingEpochFor = (epochs: Repo.TransactionHistoryEpochs, includeFailed: boolean): number =>
  includeFailed ? epochs.terminalMissingEpoch : epochs.completedMissingEpoch;

const isInReadwriteTransaction = (): boolean => {
  let tx: DexieTransaction | null = Dexie.currentTransaction;
  while (tx !== null) {
    if (tx.mode === 'readwrite') return true;
    tx = tx.parent ?? null;
  }
  return false;
};

const detectActiveHistoryStreams = async (read: BoundedHistoryRead, state: HistoryStreamState): Promise<void> => {
  if (!canPruneHistoryStreams(read.table)) return;
  const includeFailed = read.includeFailed;
  const cacheKey = includeFailed ? 'true' : 'false';
  const inReadwriteTx = isInReadwriteTransaction();
  const epochs =
    typeof Repo.getTransactionHistoryEpochs === 'function' && read.table.db
      ? Repo.getTransactionHistoryEpochs(read.table.db)
      : undefined;

  if (!inReadwriteTx && epochs !== undefined) {
    const cached = historyStreamCache.get(read.table)?.[cacheKey];
    if (cached !== undefined) {
      const negativeValid = cached.negativeExhausted
        ? cached.negativeCompletedEpoch === epochs.negativeCompletedEpoch
        : cached.removalEpoch === epochs.removalEpoch;
      const fallbackValid = cached.fallbackExhausted
        ? cached.missingEpoch === missingEpochFor(epochs, includeFailed)
        : cached.removalEpoch === epochs.removalEpoch;
      if (negativeValid && fallbackValid) {
        if (cached.negativeExhausted) state.negativeExhausted = true;
        if (cached.fallbackExhausted) state.fallbackExhausted = true;
        return;
      }
    }
  }

  const startWriteSeq = epochs?.writeSeq;
  const statuses = includeFailed
    ? [ITransactionStatus.Failed, ITransactionStatus.Unconfirmed, ITransactionStatus.Completed]
    : [ITransactionStatus.Completed];
  let needsFallback = false;
  let needChunkedCompletedCheck = false;

  await read.table.db.transaction('r', read.table, async () => {
    const negativeCount = await countIndexEntriesUpTo(
      read.table,
      'completedAt',
      { type: RANGE_BOUND, lower: undefined, upper: 0, lowerOpen: false, upperOpen: true },
      1
    );
    if (negativeCount === 0) state.negativeExhausted = true;

    for (const status of statuses) {
      const statusRange = equalIndexSpec('status', status).range;
      const boundedTotal = await countIndexEntriesUpTo(read.table, 'status', statusRange, DEFAULT_READ_CHUNK_SIZE);
      if (boundedTotal === 0) continue;
      const zeroCompleted = await countIndexEntriesUpTo(
        read.table,
        '[status+completedAt]',
        equalIndexSpec('[status+completedAt]', [status, 0]).range,
        1
      );
      if (zeroCompleted > 0) {
        needsFallback = true;
        break;
      }
      if (boundedTotal < DEFAULT_READ_CHUNK_SIZE) {
        const numericRange: DBCoreKeyRange = {
          type: RANGE_BOUND,
          lower: [status, Number.NEGATIVE_INFINITY],
          upper: [status, Number.POSITIVE_INFINITY],
          lowerOpen: false,
          upperOpen: false
        };
        const withNumericCompleted = await countIndexEntriesUpTo(
          read.table,
          '[status+completedAt]',
          numericRange,
          DEFAULT_READ_CHUNK_SIZE
        );
        if (boundedTotal > withNumericCompleted) {
          needsFallback = true;
          break;
        }
        continue;
      }
      if (status !== ITransactionStatus.Completed) {
        needsFallback = true;
        break;
      }
      needChunkedCompletedCheck = true;
    }
  });

  if (!needsFallback && needChunkedCompletedCheck) {
    const statusRange = equalIndexSpec('status', ITransactionStatus.Completed).range;
    const numericRange: DBCoreKeyRange = {
      type: RANGE_BOUND,
      lower: [ITransactionStatus.Completed, Number.NEGATIVE_INFINITY],
      upper: [ITransactionStatus.Completed, Number.POSITIVE_INFINITY],
      lowerOpen: false,
      upperOpen: false
    };
    const total = await countIndexEntriesUpTo(read.table, 'status', statusRange);
    const withNumericCompleted = await countIndexEntriesUpTo(read.table, '[status+completedAt]', numericRange);
    const totalAfter = await countIndexEntriesUpTo(read.table, 'status', statusRange);
    if (
      (epochs !== undefined && epochs.writeSeq !== startWriteSeq) ||
      totalAfter !== total ||
      total > withNumericCompleted
    ) {
      needsFallback = true;
    }
  }
  if (!needsFallback) state.fallbackExhausted = true;

  if (!inReadwriteTx && epochs !== undefined && epochs.writeSeq === startWriteSeq) {
    const pair = historyStreamCache.get(read.table) ?? {};
    pair[cacheKey] = {
      negativeExhausted: state.negativeExhausted,
      fallbackExhausted: state.fallbackExhausted,
      missingEpoch: missingEpochFor(epochs, includeFailed),
      negativeCompletedEpoch: epochs.negativeCompletedEpoch,
      removalEpoch: epochs.removalEpoch
    };
    historyStreamCache.set(read.table, pair);
  }
};

/**
 * Bounded history. Unlimited reads stay on `filter().toArray()`. A page walks `completedAt` for
 * nonzero completions and `initiatedAt` for the rest. Their heads merge by
 * `(effectiveTimestamp, transactionId)`, so only one row per index is held while the walk stops
 * after `limit` matches (plus one when the caller needs `hasMore`).
 *
 * When invoked outside an outer Dexie transaction on a real Dexie table, each chunk scans at most
 * `HISTORY_CHUNK_STEPS` rows inside its own short `readonly` transaction and yields one macrotask
 * between chunks so background `readwrite` writes commit promptly.
 */
const readBoundedHistory = async (read: BoundedHistoryRead): Promise<{ rows: ITransaction[]; hasMore: boolean }> => {
  const rows: ITransaction[] = [];
  let skipped = read.offset;
  const outerTx = Dexie.currentTransaction;
  const chunkable = outerTx === null && typeof read.table.schema?.idxByName === 'object';
  const state: HistoryStreamState = {
    positiveExhausted: false,
    negativeExhausted: false,
    fallbackExhausted: false
  };

  const runChunk = async (): Promise<{ done: boolean; hasMore: boolean }> => {
    const sources = await openHistorySources(read.table, read.direction, read.bound, state);
    let stepsLeft = chunkable ? HISTORY_CHUNK_STEPS : Number.MAX_SAFE_INTEGER;
    const canStep = () => !chunkable || stepsLeft > 0;
    const onStep = () => {
      stepsLeft -= 1;
    };

    for (;;) {
      if (chunkable && stepsLeft <= 0) {
        saveMergeStreamPositions(sources, state);
        return { done: false, hasMore: false };
      }
      const { row, paused } = await pullHistoryRow(sources, read.direction, read.bound, canStep, onStep);
      if (paused) {
        saveMergeStreamPositions(sources, state);
        return { done: false, hasMore: false };
      }
      if (row === null) return { done: true, hasMore: false };
      if (!completedHistoryRowMatches(row, read.accountId, read.tokenId, read.includeFailed)) continue;
      if (skipped > 0) {
        skipped -= 1;
        continue;
      }
      if (rows.length === read.limit) return { done: true, hasMore: true };
      rows.push(row);
      if (!read.probe && rows.length === read.limit) return { done: true, hasMore: false };
    }
  };

  if (outerTx !== null || !chunkable) {
    const result = await read.table.db.transaction('r', read.table, async () => {
      await detectActiveHistoryStreams(read, state);
      return runChunk();
    });
    return { rows, hasMore: result.hasMore };
  }

  await detectActiveHistoryStreams(read, state);
  for (;;) {
    const result = await read.table.db.transaction('r', read.table, runChunk);
    if (result.done) return { rows, hasMore: result.hasMore };
    await yieldToEventLoop();
  }
};

export const getCompletedTransactionsPage = async (
  request: CompletedTransactionsPageRequest,
  table: Table<ITransaction, string> = Repo.transactions
): Promise<CompletedTransactionsPage> => {
  if (!Number.isFinite(request.limit) || !Number.isInteger(request.limit) || request.limit <= 0) {
    throw new RangeError('Page limit must be a finite positive integer');
  }
  const read = await readBoundedHistory({
    accountId: request.accountId,
    tokenId: request.tokenId,
    includeFailed: request.includeFailed === true,
    direction: 'desc',
    offset: 0,
    limit: request.limit,
    bound: request.fromEnd === true ? null : (request.cursor ?? null),
    probe: true,
    table
  });
  const oldest = read.rows[read.rows.length - 1];
  return {
    transactions: read.rows,
    rawCount: read.rows.length,
    hasMore: read.hasMore,
    nextCursor:
      oldest !== undefined ? historyCursorOf(oldest) : request.fromEnd === true ? null : (request.cursor ?? null)
  };
};

export const getCompletedTransactions = async (
  accountId: string,
  offset?: number,
  limit?: number,
  includeFailed: boolean = false,
  tokenId?: string
) => {
  // No page size: callers of the full list keep the single scan. A limit is what makes the read bounded.
  if (limit === undefined) {
    let transactions = await readByStatusIndex([ITransactionStatus.Completed]);
    if (includeFailed) {
      transactions = transactions.concat(await getFailedTransactions(), await getUnconfirmedTransactions());
    }
    transactions.sort((tx1, tx2) => compareCompletedHistory(historyCursorOf(tx1), historyCursorOf(tx2)));
    // Compare ignoring note tag suffix since stored vs queried account IDs may differ
    transactions = transactions.filter(tx => compareAccountIds(tx.accountId, accountId));
    if (tokenId) {
      transactions = transactions.filter(tx => matchesTokenId(tx, tokenId));
    }
    return offset === undefined ? transactions : transactions.slice(offset);
  }
  const read = await readBoundedHistory({
    accountId,
    tokenId,
    includeFailed,
    direction: 'asc',
    offset: offset ?? 0,
    limit,
    bound: null,
    probe: false,
    table: Repo.transactions
  });
  return read.rows;
};

const NOTE_HOLDING_STATUS_TYPES: ReadonlyArray<readonly [ITransactionStatus, ITransaction['type']]> = [
  [ITransactionStatus.Queued, 'consume'],
  [ITransactionStatus.Queued, 'execute'],
  [ITransactionStatus.GeneratingTransaction, 'consume'],
  [ITransactionStatus.GeneratingTransaction, 'execute'],
  [ITransactionStatus.Unconfirmed, 'consume'],
  [ITransactionStatus.Unconfirmed, 'execute'],
  [ITransactionStatus.Failed, 'consume'],
  [ITransactionStatus.Failed, 'execute']
];

/**
 * The rows holding their notes for `address` (#1081, `isNoteHoldingRow`): claims and dApp transactions that are live
 * or that the reconciler can still judge, and dApp transactions that completed within a grace window, each holding
 * `heldNoteIdsOf` it. Auto-consume leaves these notes out and the claim dedup refuses them: a second consume would
 * race the holder for the note, and one of the two would fail.
 * Matched with `sameWalletAccountId` because a dApp's rows store the bare address and the wallet's own the composite
 * form.
 */
export const getNoteHoldingTransactions = async (address: string): Promise<ITransaction[]> => {
  const nowSec = Math.floor(Date.now() / 1000);

  const matchesAccountAndHoldsNotes = (tx: ITransaction): boolean =>
    sameWalletAccountId(tx.accountId, address) && isNoteHoldingRow(tx, nowSec);

  const liveAndVerdictRows = await readTransactionIndexChunks(
    Repo.transactions,
    statusTypeIndexSpecs(NOTE_HOLDING_STATUS_TYPES),
    matchesAccountAndHoldsNotes
  );

  const minCompletedAt = nowSec - COMPLETED_HOLD_GRACE_SEC;
  const recentCompletedSpec: TransactionIndexRangeSpec = {
    indexName: '[status+completedAt]',
    range: {
      type: RANGE_BOUND,
      lower: [ITransactionStatus.Completed, minCompletedAt],
      upper: [ITransactionStatus.Completed, Number.POSITIVE_INFINITY],
      lowerOpen: true,
      upperOpen: false
    }
  };
  let recentSpecToScan: TransactionIndexRangeSpec | null = recentCompletedSpec;
  if (hasTransactionIndex('[status+completedAt]', Repo.transactions)) {
    const recentCompletedCount = await countIndexEntriesUpTo(
      Repo.transactions,
      recentCompletedSpec.indexName,
      recentCompletedSpec.range
    );
    if (recentCompletedCount === 0) {
      recentSpecToScan = null;
    } else if (
      recentCompletedCount > DEFAULT_READ_CHUNK_SIZE &&
      hasTransactionIndex('heldNoteIds', Repo.transactions)
    ) {
      const heldNoteIdsSpec: TransactionIndexRangeSpec = {
        indexName: 'heldNoteIds',
        range: {
          type: RANGE_BOUND,
          lower: '',
          upper: Dexie.maxKey,
          lowerOpen: false,
          upperOpen: true
        }
      };
      const heldEntryCount = await countIndexEntriesUpTo(
        Repo.transactions,
        heldNoteIdsSpec.indexName,
        heldNoteIdsSpec.range,
        recentCompletedCount
      );
      if (heldEntryCount === 0) {
        recentSpecToScan = null;
      } else if (heldEntryCount < recentCompletedCount) {
        recentSpecToScan = heldNoteIdsSpec;
      }
    }
  }
  const recentHeldRows =
    recentSpecToScan === null
      ? []
      : await readTransactionIndexChunks(Repo.transactions, [recentSpecToScan], matchesAccountAndHoldsNotes);

  const byId = new Map<string, ITransaction>();
  for (const tx of liveAndVerdictRows) byId.set(tx.id, tx);
  for (const tx of recentHeldRows) byId.set(tx.id, tx);
  const holding = [...byId.values()];
  holding.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt || (tx1.queuedSeq ?? 0) - (tx2.queuedSeq ?? 0));
  return holding;
};

export const getTransactionById = async (id: string) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (!tx) throw new Error('Transaction not found');
  return tx;
};

/** One completed consume transaction belonging to a swap-order settlement. */
export interface SwapSettlementTransaction {
  /** Local wallet transaction id, always available. */
  id: string;
  /** Submitted Miden transaction id, available after completion. */
  transactionId?: string;
  noteIds: string[];
  amount?: bigint;
  /**
   * The sum of what settlement recorded for each note of this claim (`swapPaybackAmounts`), in base units of the
   * requested token. Set only when each note that this claim owns has a recorded amount, so the sum counts paybacks
   * of this order and nothing else.
   */
  paybackAmount?: bigint;
  faucetId?: string;
  completedAt?: number;
}

/** The sum of the recorded payback amounts of `noteIds`. Undefined when one note has no valid recorded amount. */
const recordedPaybackAmount = (
  noteIds: readonly string[],
  recorded: Record<string, string> | undefined
): bigint | undefined => {
  if (recorded === undefined || noteIds.length === 0) return undefined;
  let total = 0n;
  for (const noteId of noteIds) {
    const amount = recorded[noteId];
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return undefined;
    total += BigInt(amount);
  }
  return total;
};

/** Notes a swap order settled, grouped by how the settlement consume claimed them. */
export interface SwapSettlementNotes {
  /** Payback notes claimed on a fill — the requested funds arriving. */
  settled: string[];
  /** Remainder notes reclaimed after expiry — the unfilled tip coming back. */
  reclaimed: string[];
  /** Completed payback-consume transactions, used by the swap receipt. */
  settledTransactions: SwapSettlementTransaction[];
  /** Completed reclaim-consume transactions, used by the swap receipt. */
  reclaimedTransactions: SwapSettlementTransaction[];
}

const isCompletedSettlementConsume = (tx: ITransaction): boolean =>
  tx.type === 'consume' && tx.status === ITransactionStatus.Completed;

/**
 * Sort, note attribution and settle/reclaim split for one order's consume rows.
 * The caller has already kept only completed consumes of that order. The claimed
 * set lives here, so it never spans two orders.
 */
const settlementNotesFromConsumes = (consumes: ITransaction[]): SwapSettlementNotes => {
  const settled = new Set<string>();
  const reclaimed = new Set<string>();
  const settledTransactions: SwapSettlementTransaction[] = [];
  const reclaimedTransactions: SwapSettlementTransaction[] = [];
  // The receipt numbers fill rows by position, so the order has to be the order
  // they settled in — the Dexie scan yields rows by uuid, which would number a
  // multi-fill order arbitrarily and renumber it when a later fill lands. A row
  // without a completion stamp sorts last rather than first.
  // `completedAt` is a one-second local stamp and auto-consume settles batches
  // within a single tick, so ties are the common case rather than the edge. With
  // no tie-break the order fell through to the Dexie scan's primary-key order —
  // row UUIDs — so two fills in the same second were numbered arbitrarily, and
  // differently on every device. Break on the submitted chain id, which every
  // device agrees on.
  consumes.sort(
    (a, b) =>
      (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity) ||
      (a.transactionId ?? a.id).localeCompare(b.transactionId ?? b.id)
  );
  // A note must be attributed to exactly one consume. Two completed rows can
  // name the same note — a broader batch overlapping an earlier claim — and
  // deduplicating only the id sets left the per-transaction arrays disagreeing
  // with them: the receipt drew the note twice, and a caller summing the rows'
  // amounts to infer the fill counted the same funds twice. The sort above is
  // deterministic, so "the earlier consume owns it" is a stable rule. A row
  // whose notes were all claimed earlier is that same claim seen again and is
  // dropped, rather than contributing its amount a second time.
  const claimed = new Set<string>();

  for (const tx of consumes) {
    const rawNoteIds = tx.noteIds ?? (tx.noteId != null ? [tx.noteId] : []);
    const noteIds = rawNoteIds.filter(noteId => !claimed.has(noteId));
    if (rawNoteIds.length > 0 && noteIds.length === 0) continue;
    for (const noteId of noteIds) claimed.add(noteId);

    // `amount` is an aggregate over every note on the row sharing the first
    // note's faucet (see the ConsumeTransaction constructor), so it is only a
    // fact about the row's WHOLE note list. Once part of that list has been
    // attributed to an earlier consume, the aggregate no longer describes what
    // is left, and reporting it anyway overstated the money: rows
    // `[n1] = 400` and `[n1,n2] = 600` were emitted as `[n1] = 400` and
    // `[n2] = 600`, so a caller summing them read 1000 where 600 arrived.
    // There is no per-note breakdown to split it with, so the honest value for
    // a partially attributed row is "unknown".
    const partiallyAttributed = noteIds.length !== rawNoteIds.length;
    const isReclaim = tx.extraInputs?.swapSettleKind === 'reclaim';
    const transaction: SwapSettlementTransaction = {
      id: tx.id,
      transactionId: tx.transactionId,
      noteIds,
      amount: partiallyAttributed ? undefined : tx.amount,
      // A reclaim returns the offered token, so it has no payback amount.
      paybackAmount: isReclaim ? undefined : recordedPaybackAmount(noteIds, tx.extraInputs?.swapPaybackAmounts),
      faucetId: tx.faucetId,
      completedAt: tx.completedAt
    };
    const bucket = isReclaim ? reclaimed : settled;
    for (const noteId of noteIds) bucket.add(noteId);
    if (isReclaim) {
      reclaimedTransactions.push(transaction);
    } else {
      settledTransactions.push(transaction);
    }
  }

  return {
    settled: [...settled],
    reclaimed: [...reclaimed],
    settledTransactions,
    reclaimedTransactions
  };
};

/**
 * Note ids and completed-consume metadata belonging to a swap order.
 *
 * Those consume rows are suppressed in the history list (`suppressLinkedConsumes`
 * in `History.tsx`) so the order reads as a single swap row — which would
 * otherwise make their notes invisible. The detail page surfaces them here
 * instead. The receipt also needs each consume's amount, completion time and
 * submitted transaction id, so those fields stay grouped by consume alongside
 * the deduplicated note-id buckets. Rows are linked by
 * `extraInputs.swapOrderTxId`, tagged at queue time by
 * `reconcileSwapOrderNotes`; `swapSettleKind` splits payback claims from expiry
 * reclaims. Only completed consumes count — a queued or failed one has claimed
 * nothing yet.
 */
export const getSwapSettlementNotes = async (swapTxId: string): Promise<SwapSettlementNotes> => {
  const consumes = await Repo.transactions
    .where('extraInputs.swapOrderTxId')
    .equals(swapTxId)
    .filter(isCompletedSettlementConsume)
    .toArray();
  return settlementNotesFromConsumes(consumes);
};

const dedupeSwapOrderIds = (swapTxIds: readonly string[]): string[] => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of swapTxIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

/**
 * Every row indexed by `extraInputs.swapOrderTxId` for these orders.
 * An empty id list does not touch the store. Callers that only need settlement
 * notes still use `getSwapSettlementNotesForOrders`, which keeps completed consumes.
 */
export const readLinkedSwapOrderRows = async (swapTxIds: readonly string[]): Promise<ITransaction[]> => {
  const ids = dedupeSwapOrderIds(swapTxIds);
  if (ids.length === 0) return [];
  return Repo.transactions.where('extraInputs.swapOrderTxId').anyOf(ids).toArray();
};

/**
 * Settlement notes for orders already loaded. Only completed consumes are kept;
 * each order is sorted and split on its own rows, and an id with none gets the
 * same empty buckets as a direct read.
 */
export const settlementNotesFromLinkedRows = (
  swapTxIds: readonly string[],
  rows: readonly ITransaction[]
): Map<string, SwapSettlementNotes> => {
  const ids = dedupeSwapOrderIds(swapTxIds);
  const notes = new Map<string, SwapSettlementNotes>();
  const rowsByOrder = new Map<string, ITransaction[]>(ids.map(id => [id, []]));
  for (const tx of rows) {
    if (!isCompletedSettlementConsume(tx)) continue;
    const orderId = tx.extraInputs?.swapOrderTxId;
    if (typeof orderId !== 'string') continue;
    rowsByOrder.get(orderId)?.push(tx);
  }
  for (const id of ids) notes.set(id, settlementNotesFromConsumes(rowsByOrder.get(id) ?? []));
  return notes;
};

/**
 * Settlement notes for many swap orders, from one read on `extraInputs.swapOrderTxId`.
 *
 * A caller that only needs notes asks for every eligible order at once. `anyOf` is that
 * read; each order is then sorted and split on its own rows. An id with no
 * completed consume gets the same empty buckets as `getSwapSettlementNotes`.
 * An empty id list does not touch the store.
 */
export const getSwapSettlementNotesForOrders = async (
  swapTxIds: readonly string[]
): Promise<Map<string, SwapSettlementNotes>> => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of swapTxIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const notes = new Map<string, SwapSettlementNotes>();
  if (ids.length === 0) return notes;

  const consumes = await Repo.transactions
    .where('extraInputs.swapOrderTxId')
    .anyOf(ids)
    .filter(isCompletedSettlementConsume)
    .toArray();
  const rowsByOrder = new Map<string, ITransaction[]>(ids.map(id => [id, []]));
  for (const tx of consumes) {
    const orderId = tx.extraInputs?.swapOrderTxId;
    if (typeof orderId !== 'string') continue;
    rowsByOrder.get(orderId)?.push(tx);
  }
  for (const id of ids) notes.set(id, settlementNotesFromConsumes(rowsByOrder.get(id) ?? []));
  return notes;
};

/**
 * Lifecycle state of a swap order's PSWAP-note lineage, surfaced to the UI as
 * a stable string so the activity layer doesn't leak the wasm
 * `PswapLineageState` enum into React components:
 *   - active    : still fillable / reclaimable
 *   - filled    : fully filled (terminal)
 *   - reclaimed : reclaimed by the creator (terminal)
 *
 * From a live lineage, 'filled' means FULLY filled. The swap receipt reuses the
 * same values for a locally-inferred state when no lineage is resolvable, where
 * 'filled' is only "this wallet consumed a settlement note" — a weaker claim,
 * since an expiry batch carrying a partial payback is also tagged 'settle'. Any
 * reader of an inferred state must qualify it with the fill amount; see
 * `deriveSwapReceipt`, which is the only place that mixes the two.
 */
export type SwapOrderState = 'active' | 'filled' | 'reclaimed';

export interface SwapOrderTracking {
  /** Stable order id shared by every note in the lineage (decimal string). */
  orderId: string;
  state: SwapOrderState;
  /** 0 for the original PSWAP note, +1 per fill round. */
  currentDepth: number;
  /** Offered amount still unfilled on the current tip, in base units. */
  remainingOffered: bigint;
  /** Requested amount still outstanding on the current tip, in base units. */
  remainingRequested: bigint;
}

const pswapStateToOrderState = (state: number): SwapOrderState => {
  switch (state) {
    case PswapLineageState.FullyFilled:
      return 'filled';
    case PswapLineageState.Reclaimed:
      return 'reclaimed';
    default:
      return 'active';
  }
};

/** Read one live lineage snapshot. Null means the queued probe was fused before it acquired the lock. */
export const trackSwapOrders = async (): Promise<Map<string, SwapOrderTracking> | null> => {
  return withWasmClientLock(
    async hold => {
      if (isSyncFused('swap-order-tracking')) return null;
      const lineages = await midenClientProxy.getPswapLineages(() =>
        assertWasmHoldCurrent(hold, 'during swap order tracking')
      );
      return new Map<string, SwapOrderTracking>(
        lineages.map(lineage => [
          lineage.orderId,
          {
            orderId: lineage.orderId,
            state: pswapStateToOrderState(lineage.state),
            currentDepth: lineage.currentDepth,
            remainingOffered: BigInt(lineage.remainingOffered),
            remainingRequested: BigInt(lineage.remainingRequested)
          }
        ])
      );
    },
    { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'swap-order-tracking' }
  );
};
