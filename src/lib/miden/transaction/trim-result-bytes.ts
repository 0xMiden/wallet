import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { bridgeProviderOf } from './retry';

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
 *  2. `earn-deposit` and epoch `bridged-send` rows are completed BEFORE their caller has consumed
 *     the result — that is what `isResultAwaitingRow` in `index.ts` exists for. Those keep it.
 *
 * Trimming opportunistically rather than in a migration is deliberate: a schema migration would
 * rewrite up to 108 MB inside the IndexedDB `versionchange` transaction during `db.open()`, on the
 * critical path of every wallet open, with an unopenable database if it were interrupted. This
 * reclaims the same bytes with no schema change and no one-way step. It also reaches rows that
 * already exist, which is the other thing a forward-only fix would miss.
 */
export const RESULT_BYTES_RETENTION_MS = 10 * 60 * 1000;

/** Bridge providers whose callers read the result back off the finished row. */
const RESULT_AWAITING_BRIDGE_PROVIDER = 'epoch';

const stillNeedsResult = (tx: ITransaction): boolean => {
  if (tx.type === 'earn-deposit') return true;
  if (tx.type === 'bridged-send') return bridgeProviderOf(tx) === RESULT_AWAITING_BRIDGE_PROVIDER;
  return false;
};

/**
 * The rows whose `resultBytes` can be released. Pure, so the policy is testable without a store.
 *
 * `completedAt`/`initiatedAt` are whole SECONDS (see the sort in `get.ts`), while `now` is
 * epoch ms — hence the divide rather than a bare subtraction.
 */
const isTrimmable = (tx: ITransaction, cutoffSeconds: number): boolean => {
  if (tx.status !== ITransactionStatus.Completed) return false;
  if (!tx.resultBytes) return false;
  if (stillNeedsResult(tx)) return false;
  // A row completed by a path that never stamped `completedAt` still ages out, via the
  // timestamp every row has.
  const finishedAt = tx.completedAt ?? tx.initiatedAt;
  return finishedAt != null && finishedAt <= cutoffSeconds;
};

export const selectRowsToTrim = (rows: readonly ITransaction[], now: number): ITransaction[] => {
  const cutoffSeconds = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);
  return rows.filter(tx => isTrimmable(tx, cutoffSeconds));
};

/**
 * Releases `resultBytes` on every eligible row. Returns how many rows were trimmed.
 *
 * `.modify()` rather than read-then-`bulkPut`: the row is re-read inside the write transaction and
 * only this one field is touched. A blind put of a snapshot taken before the write would clobber a
 * concurrent update — `sweepNoteDeliveries` runs outside the processing loop's lock and stamps
 * `noteDelivery`/`relayAttempts` on exactly these Completed rows, so a put would revert a delivered
 * private note to "pending" and spend another relay attempt on it.
 *
 * Bounded per pass so a first sweep over a large store cannot hold the write transaction for long;
 * whatever it does not reach is picked up on the next lap. Driven off the `completedAt` index so
 * the scan does not walk the whole table.
 */
export const TRIM_BATCH_SIZE = 200;

/**
 * Floor between passes. The reaper is called from both the processing loop and the sync tick, and
 * the sync tick is frequent — without this, every tick would walk up to `TRIM_BATCH_SIZE` indexed
 * rows to discover there is nothing to do.
 */
export const TRIM_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastTrimAt = 0;

/** Test seam: the throttle is module state, so a suite must be able to rewind it. */
export const __resetTrimThrottleForTests = () => {
  lastTrimAt = 0;
};

export const trimCompletedResultBytes = async (now: number = Date.now()): Promise<number> => {
  if (now - lastTrimAt < TRIM_MIN_INTERVAL_MS) return 0;
  lastTrimAt = now;

  const cutoffSeconds = Math.floor((now - RESULT_BYTES_RETENTION_MS) / 1000);

  return Repo.transactions
    .where('completedAt')
    .below(cutoffSeconds)
    .limit(TRIM_BATCH_SIZE)
    .modify((tx, ref) => {
      if (!isTrimmable(tx, cutoffSeconds)) return;
      // Delete rather than assign undefined: dexie treats an assigned `undefined` as "no change"
      // in `modify`, so the blob would survive.
      delete ref.value.resultBytes;
    });
};
