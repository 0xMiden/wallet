import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

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
 *  1. `waitForTransactionCompletion` IS the public dApp API (`window.miden.waitForTransaction`),
 *     and it reads `resultBytes` on the FIRST liveQuery emission carrying `Completed`. So the
 *     window is not protection against a race; it is a TTL on that API, and clearing the field at
 *     completion would have made that TTL zero.
 *
 *     The TTL has an exact half and an approximate half.
 *
 *     EXACT, and pinned by a test: a row becomes selectable at
 *     `(completedAt + RESULT_BYTES_RETENTION_MS / 1000 + 1) * 1000`. `completedAt` is whole seconds
 *     and the cutoff floors, so `completedAt < floor((now - RETENTION) / 1000)` cannot be true until
 *     the first whole second after the window. Writers floor `Date.now()` into that stamp, so measured
 *     from the real completion the slack past the window is anywhere from 1 ms to 1 s.
 *
 *     APPROXIMATE: "the caller subscribed inside the window" is not itself a guarantee. dexie
 *     defers liveQuery's first read with `setTimeout(doQuery, 0)`, so subscribing does not snapshot
 *     the row. A subscriber that starts inside the window but whose first read is delayed past the
 *     boundary can still find the blob gone, and with a slack that can be a millisecond, only a
 *     subscription that starts well inside the window is safe from that.
 *  2. No type needs a carve-out. The in-repo callers all block on that helper immediately after
 *     initiating, so they read far inside the window - `epoch/earn-note.ts` and
 *     `epoch/miden-note.ts` then re-read `outputNoteIds` (never touched here), and
 *     `agglayer/b2agg/index.ts` uses the wait's own `txHash`.
 *
 * Trimming opportunistically rather than in a migration is deliberate: a schema migration would
 * rewrite up to 108 MB inside the IndexedDB `versionchange` transaction during `db.open()`, on the
 * critical path of every wallet open, with an unopenable database if it were interrupted. This
 * reclaims the same bytes with no schema change and no one-way step. It also reaches rows that
 * already exist, which is the other thing a forward-only fix would miss.
 */
export const RESULT_BYTES_RETENTION_MS = 10 * 60 * 1000;

const isTerminal = (tx: ITransaction): boolean =>
  tx.status === ITransactionStatus.Completed || tx.status === ITransactionStatus.Failed;

/**
 * The rows whose `resultBytes` can be released.
 *
 * `completedAt` is whole SECONDS (see the sort in `get.ts`), while `now` is epoch ms - hence the
 * divide where the cutoff is computed, rather than a bare subtraction.
 */
const isTrimmable = (tx: ITransaction, cutoffSeconds: number): boolean => {
  // BOTH terminal states, not just Completed. `waitForTransactionCompletion` answers a Failed row
  // from `tx.error` and never touches its bytes, and two paths do leave bytes on a Failed row:
  // the replace-hot-key failure branch writes `resultBytes` as it marks the row Failed, and
  // `markBridgedSendFailed` demotes an already-Completed Epoch row without clearing them. The
  // index reaches both, by different routes: the first stamps `completedAt` as it fails, and the
  // demoted row keeps the one its earlier Completed write left - `markBridgedSendFailed` stamps
  // none. A Completed-only rule would pin both forever.
  if (!isTerminal(tx)) return false;
  if (!tx.resultBytes) return false;
  // No `?? initiatedAt` fallback: the only production path here is `where('completedAt')`, and
  // IndexedDB omits records whose index key is undefined, so a row without one is unreachable.
  // `<`, matching the query's `.below()` (upper-open) exactly, so the predicate and the query are
  // one rule.
  return tx.completedAt != null && tx.completedAt < cutoffSeconds;
};

/**
 * Rows a single pass may trim. Bounds ELIGIBLE rows, not index entries - see `runTrimPass`, where
 * that distinction is the function's whole correctness.
 */
export const TRIM_BATCH_SIZE = 200;

/**
 * Floor between passes once the range is EXHAUSTED or a pass FAILED, measured from when that pass
 * settles. A pass that ended short of the range does not take it, so the next CALL continues the
 * drain: one bounded pass per caller, like `sweepNoteDeliveries`, rather than a loop or a
 * self-scheduled follow-up. A failed pass does take it, because a persistently failing store (an
 * over-quota wallet, which is exactly this module's population) would otherwise re-run the
 * value-loading select at each caller's own cadence.
 *
 * How fast a backlog clears depends on the driver, and on the extension there are two: the
 * `miden-sync` alarm floors the rate at about a pass a minute when nothing is open, but an open
 * popup or side panel drives `SyncRequest` every `SYNC_INTERVAL_MS` (3 s) into the same `doSync`,
 * so the real rate there is ~20x the alarm's. On mobile and desktop a lit #777 fuse pushes the next
 * tick out to `FUSED_SYNC_PROBE_INTERVAL_MS`, and a large backlog then takes tens of minutes.
 *
 * The cost per pass is not small, and it is not bounded by `TRIM_BATCH_SIZE`: the bound is on rows
 * WRITTEN, while the select walks - and deserializes - every already-trimmed row ahead of the next
 * eligible one, because trimming leaves `completedAt` in place. Draining a backlog of N rows
 * therefore costs on the order of N²/(2 * TRIM_BATCH_SIZE) row visits, and once drained, every
 * exhausted pass still walks all N. That is accepted rather than fixed: the cure is an index on a
 * marker the reaper clears, and IndexedDB omits records whose index key is undefined, so every row
 * written before that field existed would be invisible to it - leaving exactly the backlog this
 * module exists to reclaim. Backfilling them is the whole-table rewrite the design avoids.
 *
 * It bounds the cadence within a realm's lifetime, not absolutely: the deadline below is module
 * state, and Chrome destroys the extension service worker when idle, so a fresh worker starts at 0
 * and pays a pass on its first sync.
 */
export const TRIM_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** One tag for every line this module emits. Not exported: nothing outside it logs on its behalf. */
const TRIM_LOG_TAG = '[resultBytesTrim]';

/** The earliest clock reading at which another pass may start. */
let nextTrimAllowedAt = 0;

/**
 * Set while a pass runs. Both drivers fire and forget, so on the extension the `miden-sync` alarm
 * and an open popup's `SyncRequest` can overlap; the later caller skips instead of starting a second
 * sweep over the same rows.
 */
let running = false;

/** Test seam: the throttle is module state, so a suite must be able to rewind it. */
export const __resetTrimThrottleForTests = () => {
  nextTrimAllowedAt = 0;
  running = false;
};

/**
 * The reaper's only entry point, which both drivers call bare. Runs at most one bounded pass and
 * resolves with the number of blobs it released, 0 while another pass runs or before the floor
 * lifts. It reports every outcome itself and never rejects, so a driver has nothing to handle.
 *
 * `clock` is read when the call starts, for the cutoff and the floor check, and again when the pass
 * settles, for the next floor: a pass that outlasts the interval must not leave the floor lifted.
 */
export const runTrimTick = async (clock: () => number = () => Date.now()): Promise<number> => {
  const now = clock();
  if (running || now < nextTrimAllowedAt) return 0;
  running = true;
  try {
    const { trimmed, exhausted } = await runTrimPass(now);
    if (trimmed > 0) console.info(`${TRIM_LOG_TAG} released ${trimmed} result blob(s)`);
    // Exhaustion is REPORTED by the pass, not inferred by the caller from the trimmed count: the
    // in-write `isTrimmable` re-check can decline a row the select chose, so `trimmed` may fall
    // short of a full batch on a pass that did NOT reach the end of the range. Treating that as
    // idle would park the rest of a backlog for the full interval.
    if (exhausted) nextTrimAllowedAt = clock() + TRIM_MIN_INTERVAL_MS;
    return trimmed;
  } catch (err) {
    nextTrimAllowedAt = clock() + TRIM_MIN_INTERVAL_MS;
    console.warn(`${TRIM_LOG_TAG} pass failed:`, err);
    return 0;
  } finally {
    running = false;
  }
};

interface TrimPassResult {
  trimmed: number;
  /** True only when the select reached the end of the range - not when it stopped at a cap. */
  exhausted: boolean;
}

/**
 * Releases `resultBytes` on every eligible row. Returns how many rows were actually trimmed -
 * counted here rather than taken from `modify`'s return, which is dexie's SCANNED-key count. With
 * the filter below the two coincide, so no test can tell them apart; the explicit counter is kept
 * so the contract stays true if the filter is ever moved or removed.
 *
 * `.modify()` rather than read-then-`bulkPut`: the row is re-read inside the write transaction and
 * only this one field is touched. A blind put of a snapshot taken before the write would clobber a
 * concurrent update - `sweepNoteDeliveries` runs outside the processing loop's lock and stamps
 * `noteDelivery`/`relayAttempts` on exactly these Completed rows, so a put would revert a delivered
 * private note to "pending" and spend another relay attempt on it.
 *
 * The bound counts ELIGIBLE rows, not index entries, and that distinction is the whole correctness
 * of this function. Trimming deletes `resultBytes` and leaves `completedAt` alone, so a trimmed row
 * stays in `where('completedAt').below(cutoff)` forever. A bare `.limit()` over that range would
 * re-select the same oldest N rows on every pass (250 eligible rows go 200 trimmed, then 0, then 0,
 * stranding 50 blobs), so the select also carries the predicate as a `.filter()`: dexie runs every
 * filter before the limit's row counter, whatever order they are chained in, so the limit counts
 * only eligible rows.
 *
 * Dropping the limit is NOT the alternative: `Collection.modify` opens ONE write transaction,
 * materializes the whole range with `primaryKeys()`, and recurses its chunks on that same
 * transaction - `modifyChunkSize` bounds mutation size, not transaction lifetime - so an unbounded
 * sweep would hold a write transaction across the entire 108 MB store.
 */
const runTrimPass = async (now: number): Promise<TrimPassResult> => {
  const cutoffSeconds = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);
  const releasedAt = Math.floor(now / 1000);

  // Two steps: the SELECT runs in its own readonly transaction, and only the chosen ids are carried
  // into the write. `.filter()` makes the cursor load and deserialize every row it walks, and
  // `.modify()` alone would do that inside ONE readwrite transaction, which every reader of
  // `transactions` created meanwhile (`useTransactionRow`'s liveQuery among them) would have to wait
  // out. A readonly scan lets those readers run beside it. It does not unblock writers: IndexedDB
  // queues a readwrite transaction behind any earlier overlapping one, readonly included, so a
  // wallet write issued mid-scan waits for the scan either way.
  const ids = await Repo.transactions
    .where('completedAt')
    .below(cutoffSeconds)
    .filter(tx => isTrimmable(tx, cutoffSeconds))
    .limit(TRIM_BATCH_SIZE)
    .primaryKeys();

  // Fewer ids than the cap means the cursor reached the end of the range.
  const exhausted = ids.length < TRIM_BATCH_SIZE;
  if (ids.length === 0) return { trimmed: 0, exhausted: true };

  let trimmed = 0;
  await Repo.transactions
    .where('id')
    .anyOf(ids)
    .modify((tx, ref) => {
      // Re-checked INSIDE the write: the select above ran in a different transaction, so a
      // concurrent writer may have touched the row since. This is also what keeps passes in two
      // realms safe against each other - each keeps its own deadline, so they do not coalesce.
      // `false`, not a bare return - dexie re-puts an unchanged deep clone for any other value.
      if (!isTrimmable(tx, cutoffSeconds)) return false;
      // `delete`, not `ref.value.resultBytes = undefined`. Both release the blob - dexie re-puts
      // whatever the callback leaves, so an assigned `undefined` is written and the bytes go - but
      // `delete` also removes the key, so a trimmed row carries no dead field. `resultReleasedAt`
      // records the release, which is how waitForTransactionCompletion tells an expired result from
      // one that was never stored. The db suite asserts both.
      delete ref.value.resultBytes;
      ref.value.resultReleasedAt = releasedAt;
      trimmed++;
      return undefined;
    });

  return { trimmed, exhausted };
};
