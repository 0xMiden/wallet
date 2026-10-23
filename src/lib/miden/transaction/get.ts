import { PswapLineageState } from '@miden-sdk/miden-sdk/lazy';
import type { Table } from 'dexie';

import * as Repo from 'lib/miden/repo';

import { findAdoptableShortfallRow } from './rotation-funding';
import { isNoteHoldingRow } from './verdict-rules';
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

export const hasQueuedTransactions = async () => {
  const tx = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  return tx.length > 0;
};

export const getUncompletedTransactions = async (address: string, tokenId?: string) => {
  const statuses = [ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction];
  return await getTransactionsInStatuses(statuses, address, tokenId);
};

const getTransactionsInStatuses = async (statuses: ITransactionStatus[], accountId: string, tokenId?: string) => {
  let txs = await Repo.transactions.filter(rec => statuses.includes(rec.status)).toArray();
  // Same tie-break as the processing loop's picker, for the same reason and so the two
  // agree: `initiatedAt` is whole seconds, so rows queued in the same second tie and a
  // stable sort falls back to Dexie's primary-key order over random `uuid()`s. Without
  // this, the queue a caller reads here could be ordered differently from the order the
  // loop will actually process.
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt || (tx1.queuedSeq ?? 0) - (tx2.queuedSeq ?? 0));
  txs = txs.filter(tx => compareAccountIds(tx.accountId, accountId));
  if (tokenId) {
    txs = txs.filter(tx => matchesTokenId(tx, tokenId));
  }

  return txs;
};

export const getTransactionsInProgress = async (): Promise<Transaction[]> => {
  const txs = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.GeneratingTransaction).toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

export const getAllUncompletedTransactions = async () => {
  const txs = await Repo.transactions
    .filter(rec => rec.status === ITransactionStatus.GeneratingTransaction || rec.status === ITransactionStatus.Queued)
    .toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

/**
 * True when the account's everyday-key rotation waits for funds (#805), so the rotation gate shows its funding panel:
 * `findAdoptableShortfallRow` finds the row the gate adopts.
 */
export const isRotationAwaitingFunding = async (accountPublicKey: string): Promise<boolean> =>
  (await findAdoptableShortfallRow(accountPublicKey)) !== undefined;

export const getFailedTransactions = async () => {
  const transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Failed).toArray();
  transactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return transactions;
};

/** Rows waiting for the node's verdict on an unknown submit outcome (#1081). */
export const getUnconfirmedTransactions = async () => {
  const transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Unconfirmed).toArray();
  transactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return transactions;
};

/**
 * Page boundary. `effectiveTimestamp` is `(completedAt || initiatedAt)`.
 * `status` and `initiatedAt` resume inside an equal timestamp in unlimited order:
 * Completed, then Failed, then Unconfirmed. A cursor with no `status` keeps the id comparison.
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

/** Oldest-first rank inside one effective timestamp: the unlimited concatenation order. */
const historyStatusRank = (status: ITransactionStatus | undefined): number => {
  if (status === ITransactionStatus.Completed) return 0;
  if (status === ITransactionStatus.Failed) return 1;
  if (status === ITransactionStatus.Unconfirmed) return 2;
  return 3;
};

/**
 * Oldest-first order of unlimited `getCompletedTransactions`. Negative when `a` is older.
 * Equal timestamps follow Completed, then Failed, then Unconfirmed; Failed and Unconfirmed
 * break ties by `initiatedAt`, then id. Completed, and a cursor with no `status`, break ties by id.
 */
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
  if (initiated !== 0) return initiated;
  return compareHistoryId(a.transactionId, b.transactionId);
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
  compareCompletedHistory(historyCursorOf(a), historyCursorOf(b)) < 0;

const historyPrefers = (row: ITransaction, other: ITransaction, direction: HistoryDirection): boolean =>
  direction === 'asc' ? earlierHistoryRow(row, other) : earlierHistoryRow(other, row);

const onHistorySide = (
  tx: ITransaction,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): boolean => {
  if (bound === null) return true;
  const order = compareCompletedHistory(historyCursorOf(tx), bound);
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

const alignCompletedSource = async (
  source: HistorySource,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): Promise<void> => {
  retireDoneCursor(source);
  while (source.cursor !== null && !source.cursor.done) {
    const row = source.cursor.value;
    if (inHistoryStream(source, row) && onHistorySide(row, direction, bound)) return;
    source.cursor = await source.cursor.next();
  }
  source.cursor = null;
};

const alignFallbackSource = async (
  source: HistorySource,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  rivalTime: number | null
): Promise<void> => {
  retireDoneCursor(source);
  while (source.cursor !== null && !source.cursor.done) {
    const row = source.cursor.value;
    if (!onHistorySide(row, direction, bound)) {
      source.cursor = await source.cursor.next();
      continue;
    }
    if (!hasRecordedCompletion(row)) return;
    if (rivalTime !== null && !fallbackCouldPrecedeRival(row.initiatedAt, rivalTime, direction)) return;
    source.cursor = await source.cursor.next();
  }
  source.cursor = null;
};

const historyIndexKey = (tx: ITransaction, indexName: 'completedAt' | 'initiatedAt'): number | undefined => {
  const value = indexName === 'completedAt' ? tx.completedAt : tx.initiatedAt;
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
};

/** The effective time the next group must emit. Heads already sit on this side of `bound`. */
const extremeHistoryTime = (
  sources: readonly HistorySource[],
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): number | null => {
  let groupTime: number | null = null;
  for (const source of sources) {
    const row = historyCandidate(source, direction, bound);
    if (row === null) continue;
    const time = effectiveHistoryTimestamp(row);
    if (groupTime === null || (direction === 'asc' ? time < groupTime : time > groupTime)) groupTime = time;
  }
  return groupTime;
};

/**
 * Every on-side row of this stream at `groupTime`. The index yields `(timestamp, id)`, so the
 * caller sorts the union. The cursor stops on the first row of the next index key.
 */
const takeTimestampGroup = async (
  source: HistorySource,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null,
  groupTime: number
): Promise<ITransaction[]> => {
  const head = historyCandidate(source, direction, bound);
  if (head === null || effectiveHistoryTimestamp(head) !== groupTime) return [];
  const indexName = source.stream === 'fallback' ? 'initiatedAt' : 'completedAt';
  const taken: ITransaction[] = [];
  while (source.cursor !== null && !source.cursor.done) {
    const row = source.cursor.value;
    const key = historyIndexKey(row, indexName);
    if (key !== groupTime && (taken.length > 0 || effectiveHistoryTimestamp(row) !== groupTime)) break;
    if (
      inHistoryStream(source, row) &&
      onHistorySide(row, direction, bound) &&
      effectiveHistoryTimestamp(row) === groupTime
    ) {
      taken.push(row);
    }
    source.cursor = await source.cursor.next();
  }
  retireDoneCursor(source);
  return taken;
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
  buffered: ITransaction[]
): Promise<ITransaction | null> => {
  const ready = buffered.shift();
  if (ready !== undefined) return ready;
  const positive = sources[0];
  const negative = sources[1];
  const fallback = sources[2];
  if (positive === undefined || negative === undefined || fallback === undefined) return null;
  await alignCompletedSource(positive, direction, bound);
  await alignCompletedSource(negative, direction, bound);
  const rival = pickHistorySource([positive, negative], direction, bound);
  await alignFallbackSource(fallback, direction, bound, rival === null ? null : effectiveHistoryTimestamp(rival.row));
  const groupTime = extremeHistoryTime(sources, direction, bound);
  if (groupTime === null) return null;
  const grouped: ITransaction[] = [];
  for (const source of sources) {
    grouped.push(...(await takeTimestampGroup(source, direction, bound, groupTime)));
  }
  if (grouped.length === 0) return null;
  grouped.sort((a, b) =>
    direction === 'asc'
      ? compareCompletedHistory(historyCursorOf(a), historyCursorOf(b))
      : compareCompletedHistory(historyCursorOf(b), historyCursorOf(a))
  );
  buffered.push(...grouped);
  return buffered.shift() ?? null;
};

const positiveIndexBound = (direction: HistoryDirection, bound: CompletedHistoryCursor | null) => {
  if (direction === 'desc' && bound !== null && bound.effectiveTimestamp <= 0) return null;
  if (bound === null || direction === 'asc') {
    if (direction === 'asc' && bound !== null && bound.effectiveTimestamp > 0) {
      return { lower: bound.effectiveTimestamp, lowerOpen: false };
    }
    return { lower: 0, lowerOpen: true };
  }
  return { lower: 0, lowerOpen: true, upper: bound.effectiveTimestamp, upperOpen: false };
};

const negativeIndexBound = (direction: HistoryDirection, bound: CompletedHistoryCursor | null) => {
  if (direction === 'asc') {
    if (bound === null) return { upper: 0, upperOpen: true };
    if (bound.effectiveTimestamp >= 0) return null;
    return { lower: bound.effectiveTimestamp, lowerOpen: false, upper: 0, upperOpen: true };
  }
  if (bound !== null && bound.effectiveTimestamp < 0) return { upper: bound.effectiveTimestamp, upperOpen: false };
  return { upper: 0, upperOpen: true };
};

const fallbackIndexBound = (direction: HistoryDirection, bound: CompletedHistoryCursor | null) => {
  if (bound === null) return undefined;
  if (direction === 'desc') return { upper: bound.effectiveTimestamp, upperOpen: false };
  return { lower: bound.effectiveTimestamp, lowerOpen: false };
};

const openHistorySources = async (
  table: Table<ITransaction, string>,
  direction: HistoryDirection,
  bound: CompletedHistoryCursor | null
): Promise<HistorySource[]> => {
  const reverse = direction === 'desc';
  const positiveBound = positiveIndexBound(direction, bound);
  const negativeBound = negativeIndexBound(direction, bound);
  const positive =
    positiveBound === null ? null : await Repo.openTransactionIndexCursor(table, 'completedAt', reverse, positiveBound);
  const negative =
    negativeBound === null ? null : await Repo.openTransactionIndexCursor(table, 'completedAt', reverse, negativeBound);
  const fallback = await Repo.openTransactionIndexCursor(
    table,
    'initiatedAt',
    reverse,
    fallbackIndexBound(direction, bound)
  );
  return [
    { stream: 'positive', cursor: positive },
    { stream: 'negative', cursor: negative },
    { stream: 'fallback', cursor: fallback }
  ];
};

/**
 * Bounded history. Unlimited reads stay on `filter().toArray()`. A page walks `completedAt` for
 * nonzero completions and `initiatedAt` for the rest. Each effective timestamp is buffered from
 * all three streams and emitted in the unlimited order, and the walk stops once `limit` matches
 * (plus one, when the caller needs `hasMore`) have passed the account, token and status predicates.
 */
const readBoundedHistory = async (read: BoundedHistoryRead): Promise<{ rows: ITransaction[]; hasMore: boolean }> =>
  read.table.db.transaction('r', read.table, async () => {
    const sources = await openHistorySources(read.table, read.direction, read.bound);
    const buffered: ITransaction[] = [];
    const rows: ITransaction[] = [];
    let skipped = read.offset;
    for (;;) {
      const row = await pullHistoryRow(sources, read.direction, read.bound, buffered);
      if (row === null) return { rows, hasMore: false };
      if (!completedHistoryRowMatches(row, read.accountId, read.tokenId, read.includeFailed)) continue;
      if (skipped > 0) {
        skipped -= 1;
        continue;
      }
      if (rows.length === read.limit) return { rows, hasMore: true };
      rows.push(row);
      if (!read.probe && rows.length === read.limit) return { rows, hasMore: false };
    }
  });

export const getCompletedTransactionsPage = async (
  request: CompletedTransactionsPageRequest,
  table: Table<ITransaction, string> = Repo.transactions
): Promise<CompletedTransactionsPage> => {
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
  tokenId?: string,
  fromEnd?: boolean
) => {
  // No page size: callers of the full list keep the single scan. A limit is what makes the read bounded.
  if (limit === undefined) {
    let transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Completed).toArray();
    if (includeFailed) {
      transactions = transactions.concat(await getFailedTransactions(), await getUnconfirmedTransactions());
    }
    transactions.sort((tx1, tx2) => (tx1.completedAt || tx1.initiatedAt) - (tx2.completedAt || tx2.initiatedAt));
    // Compare ignoring note tag suffix since stored vs queried account IDs may differ
    transactions = transactions.filter(tx => compareAccountIds(tx.accountId, accountId));
    if (tokenId) {
      transactions = transactions.filter(tx => matchesTokenId(tx, tokenId));
    }
    if (fromEnd) return transactions;
    return offset === undefined ? transactions : transactions.slice(offset);
  }
  const read = await readBoundedHistory({
    accountId,
    tokenId,
    includeFailed,
    direction: fromEnd ? 'desc' : 'asc',
    offset: fromEnd ? 0 : (offset ?? 0),
    limit,
    bound: null,
    probe: false,
    table: Repo.transactions
  });
  // The newest page is collected newest-first and returned oldest-first, matching the full sort's tail.
  return fromEnd ? read.rows.slice().reverse() : read.rows;
};

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
  const rows = await Repo.transactions.filter(tx => isNoteHoldingRow(tx, nowSec)).toArray();
  const holding = rows.filter(tx => sameWalletAccountId(tx.accountId, address));
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
  faucetId?: string;
  completedAt?: number;
}

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
    const transaction = {
      id: tx.id,
      transactionId: tx.transactionId,
      noteIds,
      amount: partiallyAttributed ? undefined : tx.amount,
      faucetId: tx.faucetId,
      completedAt: tx.completedAt
    };
    const isReclaim = tx.extraInputs?.swapSettleKind === 'reclaim';
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
