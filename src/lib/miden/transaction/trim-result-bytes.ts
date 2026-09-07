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
 *     The TTL has an exact half and an approximate half, and they are worth separating because
 *     four earlier versions of this comment stated the approximate half as a guarantee.
 *
 *     EXACT, and pinned by a test: a row becomes selectable at
 *     `(completedAt + RESULT_BYTES_RETENTION_MS / 1000 + 1) * 1000`, one second later than the
 *     nominal window. `completedAt` is whole seconds and the cutoff floors, so the comparison
 *     `completedAt < floor((now - RETENTION) / 1000)` cannot be true until the next whole second.
 *
 *     APPROXIMATE: "the caller subscribed inside the window" is not itself a guarantee. dexie
 *     defers liveQuery's first read with `setTimeout(doQuery, 0)`, so subscribing does not snapshot
 *     the row. A subscriber that starts inside the window but whose first read is delayed past the
 *     boundary can still find the blob gone. The second of slack above is what makes that
 *     improbable rather than impossible — it needs the event loop starved for longer than that.
 *  2. No type needs a carve-out. The in-repo callers all block on that helper immediately after
 *     initiating, so they read far inside the window — `epoch/earn-note.ts` and
 *     `epoch/miden-note.ts` then re-read `outputNoteIds` (never touched here), and
 *     `agglayer/b2agg/index.ts` uses the wait's own `txHash`.
 *
 * Trimming opportunistically rather than in a migration is deliberate: a schema migration would
 * rewrite up to 108 MB inside the IndexedDB `versionchange` transaction during `db.open()`, on the
 * critical path of every wallet open, with an unopenable database if it were interrupted. This
 * reclaims the same bytes with no schema change and no one-way step. It also reaches rows that
 * already exist, which is the other thing a forward-only fix would miss.
 *
 * There used to be a type-based carve-out for `earn-deposit` and epoch `bridged-send`, on the
 * theory that their callers consume the result after completion. They do not, and it had no upper
 * bound — so those rows kept ~237 KB forever, which is this module's own bug in the population
 * most likely to hit it.
 *
 * `RESULT_BYTES_RETENTION_MS` is kept comfortably above `WAIT_FOR_TX_TIMEOUT` as a design margin,
 * not as a correctness condition: the timeout bounds how long one wait may LAST, and never when
 * the blob is read.
 */
export const RESULT_BYTES_RETENTION_MS = 10 * 60 * 1000;

const isTerminal = (tx: ITransaction): boolean =>
  tx.status === ITransactionStatus.Completed || tx.status === ITransactionStatus.Failed;

/**
 * The rows whose `resultBytes` can be released.
 *
 * `completedAt` is whole SECONDS (see the sort in `get.ts`), while `now` is epoch ms — hence the
 * divide where the cutoff is computed, rather than a bare subtraction.
 */
const isTrimmable = (tx: ITransaction, cutoffSeconds: number): boolean => {
  // BOTH terminal states, not just Completed. `waitForTransactionCompletion` answers a Failed row
  // from `tx.error` and never touches its bytes, and two paths do leave bytes on a Failed row:
  // the replace-hot-key failure branch writes `resultBytes` as it marks the row Failed, and
  // `markBridgedSendFailed` demotes an already-Completed Epoch row without clearing them. The
  // index reaches both, by different routes: the first stamps `completedAt` as it fails, and the
  // demoted row keeps the one its earlier Completed write left — `markBridgedSendFailed` stamps
  // none. A Completed-only rule pinned both forever.
  if (!isTerminal(tx)) return false;
  if (!tx.resultBytes) return false;
  // No `?? initiatedAt` fallback: the only production path here is `where('completedAt')`, and
  // IndexedDB omits records whose index key is undefined, so a row without one is unreachable.
  // `<`, matching the query's `.below()` (upper-open) exactly. These are ONE rule: a row at
  // precisely the cutoff second used to be trimmable by the predicate and unreachable by the
  // query.
  return tx.completedAt != null && tx.completedAt < cutoffSeconds;
};

/**
 * Rows a single pass may trim. Bounds ELIGIBLE rows, not index entries — see `runTrimPass`, where
 * that distinction is the function's whole correctness.
 */
export const TRIM_BATCH_SIZE = 200;

/**
 * Floor between passes once the range is EXHAUSTED. A pass that ended short of the range does not
 * take it, so the next CALL continues the drain — one bounded pass per caller, like
 * `sweepNoteDeliveries`, rather than a loop or a self-scheduled follow-up.
 *
 * How fast a backlog clears depends on the driver, and on the extension there are two: the
 * `miden-sync` alarm floors the rate at about a pass a minute when nothing is open, but an open
 * popup or side panel drives `SyncRequest` every `SYNC_INTERVAL_MS` (3 s) into the same `doSync`,
 * so the real rate there is ~20x the alarm's. On mobile and desktop a lit #777 fuse pushes the next
 * tick out to `FUSED_SYNC_PROBE_INTERVAL_MS`, and a large backlog then takes tens of minutes.
 *
 * The cost per pass is not small, and it is not bounded by `TRIM_BATCH_SIZE`: the bound is on rows
 * WRITTEN, while the select walks — and deserializes — every already-trimmed row ahead of the next
 * eligible one, because trimming leaves `completedAt` in place. Draining a backlog of N rows
 * therefore costs on the order of N²/(2 * TRIM_BATCH_SIZE) row visits, and once drained, every
 * exhausted pass still walks all N. That is accepted rather than fixed: the cure is an index on a
 * marker the reaper clears, and IndexedDB omits records whose index key is undefined, so every row
 * written before that field existed would be invisible to it — leaving exactly the backlog this
 * module exists to reclaim. Backfilling them is the whole-table rewrite the design avoids.
 *
 * It bounds the cadence within a realm's lifetime, not absolutely: the deadline below is module
 * state, and Chrome destroys the extension service worker when idle, so a fresh worker starts at 0
 * and pays a pass on its first sync.
 */
export const TRIM_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Floor after a FAILED pass — shorter, because a transient failure should be retried soon. Without
 * it a persistently failing store (an over-quota wallet, which is exactly this module's
 * population) would re-run the whole value-loading select at each caller's own cadence, ~3 s.
 */
export const TRIM_FAILURE_RETRY_MS = 30 * 1000;

/** One tag for every line this module emits. Not exported: nothing outside it logs on its behalf. */
const TRIM_LOG_TAG = '[resultBytesTrim]';

/**
 * The earliest `now` at which another pass may start. ONE variable, so each outcome is one
 * assignment and there is no back-dated arithmetic between two floors.
 */
let nextTrimAllowedAt = 0;

/**
 * The pass currently running, so overlapping callers coalesce onto it instead of starting a second
 * sweep. Both drivers fire it and forget, so without this the extension alarm and a UI tick could run
 * two passes at once. Mirrors the in-flight sync coalescing in `sync-manager.ts`.
 */
let inFlight: Promise<number> | null = null;

/** Test seam: the throttle is module state, so a suite must be able to rewind it. */
export const __resetTrimThrottleForTests = () => {
  nextTrimAllowedAt = 0;
  inFlight = null;
};

export const trimCompletedResultBytes = async (now: number = Date.now()): Promise<number> => {
  if (inFlight) return inFlight;
  if (now < nextTrimAllowedAt) return 0;

  const pass = runTrimPass(now);
  // The derived promise is what a concurrent caller adopts, so it must carry the rejection — but
  // when nobody adopts it, an unattached rejected promise is an unhandled rejection. The `catch`
  // below only marks it handled; the real handling is this function's own try/catch, and an
  // adopting caller still sees the rejection through its own await.
  inFlight = pass.then(r => r.trimmed);
  inFlight.catch(() => {});
  try {
    const { trimmed, exhausted } = await pass;
    // Reported here, inside the module, so it is once per PASS. Both drivers fire and forget and
    // each attaches its own handler, so logging at the call sites would repeat one pass's outcome
    // once per overlapping caller.
    if (trimmed > 0) {
      console.info(`${TRIM_LOG_TAG} released ${trimmed} result blob(s)`);
    } else if (!exhausted) {
      // The stall signature, and the reason this log exists: rows were selected and none could be
      // released. That is what the original bug looked like — a full batch selected every pass,
      // every row already trimmed, nothing reclaimed — and it was indistinguishable from a healthy
      // idle tick until this line.
      console.warn(`${TRIM_LOG_TAG} selected rows but released none — the reaper may be stalled`);
    }
    // Exhaustion is REPORTED by the pass, not inferred by the caller from the trimmed count: the
    // in-write `isTrimmable` re-check can decline a row the select chose, so `trimmed` may fall
    // short of a full batch on a pass that did NOT reach the end of the range. Treating that as
    // idle would park the rest of a backlog for the full interval.
    if (exhausted) nextTrimAllowedAt = now + TRIM_MIN_INTERVAL_MS;
    return trimmed;
  } catch (err) {
    // A failure must not be free to retry at the callers' cadence, nor burn the whole interval.
    nextTrimAllowedAt = now + TRIM_FAILURE_RETRY_MS;
    // Logged HERE, not at the call sites, for the same reason the two outcomes above are: only the
    // originating caller reaches this catch — adopters returned at the `inFlight` guard — so one
    // failed pass produces one line. The drivers used to log it themselves, and two overlapping
    // callers then reported the same failure twice.
    console.warn(`${TRIM_LOG_TAG} pass failed:`, err);
    throw err;
  } finally {
    inFlight = null;
  }
};

/**
 * What a driver calls. `trimCompletedResultBytes` still rejects, because the coalescing contract
 * needs an adopting caller to see the failure — but the module has already reported it, so a driver
 * has nothing to add and nothing to handle.
 */
export const runTrimTick = async (): Promise<void> => {
  try {
    await trimCompletedResultBytes();
  } catch {
    // Reported once per pass inside the module.
  }
};

interface TrimPassResult {
  trimmed: number;
  /** True only when the select reached the end of the range — not when it stopped at a cap. */
  exhausted: boolean;
}

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
const runTrimPass = async (now: number): Promise<TrimPassResult> => {
  const cutoffSeconds = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);

  // Two steps, and the split is the point: the SELECT runs in its own readonly transaction, and
  // only the chosen ids are carried into the write.
  //
  // `.modify()` alone opens ONE readwrite transaction and materializes the range inside it, and
  // because `.filter()` forces the cursor to load values, that scan deserializes every row it
  // walks — including the ~237 KB blobs of rows it will skip — while holding a write lock on
  // `transactions`. Nothing awaits this pass any more — both drivers fire and forget — but the
  // wallet's own writes still queue behind a readwrite transaction held open for the whole scan.
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
      // realms safe against each other — each keeps its own deadline, so they do not coalesce.
      // `false`, not a bare return — dexie re-puts an unchanged deep clone for any other value.
      if (!isTrimmable(tx, cutoffSeconds)) return false;
      // `delete`, not `ref.value.resultBytes = undefined`. Both release the blob — dexie re-puts
      // whatever the callback leaves, so an assigned `undefined` is written and the bytes go — but
      // `delete` also removes the key, so a trimmed row carries no dead field. That is the whole
      // difference, and the db suite asserts it rather than leaving it to this comment.
      delete ref.value.resultBytes;
      trimmed++;
      return undefined;
    });

  return { trimmed, exhausted };
};
