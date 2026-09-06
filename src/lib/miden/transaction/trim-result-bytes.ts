import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { WAIT_FOR_TX_TIMEOUT } from './bridge-provider';

export { WAIT_FOR_TX_TIMEOUT };

/**
 * Reclaims the `resultBytes` blob from long-finished transaction rows.
 *
 * `resultBytes` is the serialized `TransactionResult`, ~237 KB per transaction. It is written
 * at completion and read exactly once, by `waitForTransactionCompletion` in `helper.ts`. Nothing
 * trims it, so the store grows forever: a wallet measured after 456 transactions held 108 MB, of
 * which 99.83% was this field, and cold-start time tracked that growth (0.44 s → 2.3 s, p90 11.2 s).
 *
 * Two constraints shape this, and both rule out the obvious "null it the moment the row completes":
 *
 *  1. `waitForTransactionCompletion` IS the public dApp API (`window.miden.waitForTransaction`).
 *     It observes the row until it reads `Completed` and only THEN deserializes `resultBytes`, so
 *     clearing the field in the same write would race it and answer "Transaction completed without
 *     a transaction result". The retention window below is what keeps that read safe.
 *  2. Nothing else needs a carve-out: every other caller of `waitForTransactionCompletion` reads
 *     `outputNoteIds` off the row afterwards, which this never touches.
 *
 * Trimming opportunistically rather than in a migration is deliberate: a schema migration would
 * rewrite up to 108 MB inside the IndexedDB `versionchange` transaction during `db.open()`, on the
 * critical path of every wallet open, with an unopenable database if it were interrupted. This
 * reclaims the same bytes with no schema change and no one-way step. It also reaches rows that
 * already exist, which is the other thing a forward-only fix would miss.
 */
export const RESULT_BYTES_RETENTION_MS = 10 * 60 * 1000;

/**
 * The window MUST stay strictly greater than the awaiting caller's own timeout. That inequality is
 * the whole reason no reader can be raced: `waitForTransactionCompletion` gives up after
 * `WAIT_FOR_TX_TIMEOUT` and its callers then read only `outputNoteIds`, which this never touches.
 *
 * There used to be a type-based carve-out here for `earn-deposit` and epoch `bridged-send`,
 * on the theory that their callers consume the result after completion. They do not: both
 * (`epoch/earn-note.ts`, `epoch/miden-note.ts`) await that same helper and then re-read
 * `outputNoteIds`. The carve-out had no upper bound, so those rows kept ~237 KB forever — the
 * unbounded growth this module exists to stop, in the population most likely to hit it.
 */
/**
 * The rows whose `resultBytes` can be released. Pure, so the policy is testable without a store.
 *
 * `completedAt` is whole SECONDS (see the sort in `get.ts`), while `now` is epoch ms — hence the
 * divide rather than a bare subtraction.
 */
const isTerminal = (tx: ITransaction): boolean =>
  tx.status === ITransactionStatus.Completed || tx.status === ITransactionStatus.Failed;

const isTrimmable = (tx: ITransaction, cutoffSeconds: number): boolean => {
  // BOTH terminal states, not just Completed. `waitForTransactionCompletion` answers a Failed row
  // from `tx.error` and never touches its bytes, and two paths do leave bytes on a Failed row:
  // the replace-hot-key failure branch writes `resultBytes` as it marks the row Failed, and
  // `markBridgedSendFailed` demotes an already-Completed Epoch row without clearing them. Both
  // stamp `completedAt`, so the index reaches them — a Completed-only rule pinned them forever.
  if (!isTerminal(tx)) return false;
  if (!tx.resultBytes) return false;
  // No `?? initiatedAt` fallback: the only production path here is `where('completedAt')`, and
  // IndexedDB omits records whose index key is undefined, so a row without one is unreachable.
  return tx.completedAt != null && tx.completedAt <= cutoffSeconds;
};

export const selectRowsToTrim = (rows: readonly ITransaction[], now: number): ITransaction[] => {
  const cutoffSeconds = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);
  return rows.filter(tx => isTrimmable(tx, cutoffSeconds));
};

/**
 * Releases `resultBytes` on every eligible row. Returns how many rows were actually trimmed —
 * counted here rather than taken from `modify`'s return, which is dexie's SCANNED-key count. With
 * the filter below the two coincide, so no test can tell them apart; the explicit counter is kept
 * so the contract stays true if the filter is ever moved or removed.
 *
 * `.modify()` rather than read-then-`bulkPut`: the row is re-read inside the write transaction and
 * only this one field is touched. A blind put of a snapshot taken before the write would clobber a
 * concurrent update — `sweepNoteDeliveries` runs outside the processing loop's lock and stamps
 * `noteDelivery`/`relayAttempts` on exactly these Completed rows, so a put would revert a delivered
 * private note to "pending" and spend another relay attempt on it.
 *
 * The bound counts ELIGIBLE rows, not index entries, and that distinction is the whole correctness
 * of this function. Trimming deletes `resultBytes` and leaves `completedAt` alone, so a trimmed row
 * stays in `where('completedAt').below(cutoff)` forever. A bare `.limit()` over that range therefore
 * re-selects the same oldest N rows on every pass — measured: 250 eligible rows went 200 trimmed,
 * then 0, then 0, leaving 50 blobs stranded permanently. `.filter()` ahead of `.limit()` fixes it
 * because dexie's replay filter only decrements on rows that passed the predicate.
 *
 * Dropping the limit is NOT the alternative: `Collection.modify` opens ONE write transaction,
 * materializes the whole range with `primaryKeys()`, and recurses its chunks on that same
 * transaction — `modifyChunkSize` bounds mutation size, not transaction lifetime — so an unbounded
 * sweep would hold a write transaction across the entire 108 MB store.
 */
export const TRIM_BATCH_SIZE = 200;

/**
 * Floor between passes. The reaper is called from both the processing loop and the sync tick, and
 * the sync tick is frequent — without this, every tick would walk up to `TRIM_BATCH_SIZE` indexed
 * rows to discover there is nothing to do.
 */
export const TRIM_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastTrimAt = 0;
/**
 * The pass currently running, so overlapping callers coalesce onto it instead of starting a second
 * sweep. There are three: `generateTransactionsLoop` awaits this, while the extension sync tick and
 * the mobile/desktop idle tick fire it and forget. Stamping `lastTrimAt` up front used to serialize
 * them as a side effect — but that also meant a FAILED pass burned the whole five-minute window, so
 * the stamp moved to the success path and the coalescing had to become explicit. Mirrors the
 * in-flight sync coalescing in `sync-manager.ts`.
 */
let inFlight: Promise<number> | null = null;

/** Test seam: the throttle is module state, so a suite must be able to rewind it. */
export const __resetTrimThrottleForTests = () => {
  lastTrimAt = 0;
  inFlight = null;
};

export const trimCompletedResultBytes = async (now: number = Date.now()): Promise<number> => {
  if (inFlight) return inFlight;
  if (now - lastTrimAt < TRIM_MIN_INTERVAL_MS) return 0;

  const pass = runTrimPass(now);
  inFlight = pass;
  try {
    const trimmed = await pass;
    // Stamped only once the write has settled: a transient failure must be retried on the next
    // lap, not silently deferred for five minutes.
    lastTrimAt = now;
    return trimmed;
  } finally {
    inFlight = null;
  }
};

const runTrimPass = async (now: number): Promise<number> => {
  const cutoffSeconds = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);

  let trimmed = 0;
  await Repo.transactions
    .where('completedAt')
    .below(cutoffSeconds)
    .filter(tx => isTrimmable(tx, cutoffSeconds))
    .limit(TRIM_BATCH_SIZE)
    .modify((tx, ref) => {
      // `false`, not a bare return — dexie re-puts an unchanged deep clone for any other value.
      // The filter above already selected this row, outside the write transaction; this is the
      // re-check that makes the decision inside it.
      if (!isTrimmable(tx, cutoffSeconds)) return false;
      // Delete rather than assign undefined: dexie treats an assigned `undefined` as "no change"
      // in `modify`, so the blob would survive.
      delete ref.value.resultBytes;
      trimmed++;
      return undefined;
    });
  return trimmed;
};
