import { useEffect, useRef } from 'react';

import { getSwapOrderSchedule, useSwapOrderTrackingStore, type SwapOrderSchedule } from '../swap/order-tracking-store';

/**
 * App-root poller for PSWAP order lineages. The history detail page used to own
 * this poll (`trackOrderId` + exponential backoff), so tracking died with the
 * page; now the manager watches every swap row with a persisted `orderId` and
 * publishes results to `useSwapOrderTrackingStore` for the page to read.
 *
 * Poll semantics are ported verbatim from the old page effect: `trackOrderId`
 * takes the WASM client lock, so an unresolved result (null / error — the order
 * isn't trackable by this client) backs off exponentially and gives up after a
 * cap rather than hammering the lock every 2s forever; a genuinely `active`
 * order resets the backoff and keeps a steady watch; `filled`/`reclaimed` (or a
 * completed settlement consume in Dexie) is terminal. Orders are polled
 * sequentially — at most one lock acquisition per tick — so this never floods
 * the lock alongside `SwapSettlementManager`'s own 3s cycle.
 */
const BASE_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;
const MAX_UNRESOLVED_POLLS = 20;

export function SwapOrderTrackingManager(): null {
  const running = useRef(false);

  useEffect(() => {
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      running.current = true;
      try {
        const candidates = await findPollableOrders();
        const now = Date.now();
        const due = candidates.filter(({ schedule }) => schedule.nextAt <= now);
        for (const { orderId, schedule } of due) {
          if (disposed) return;
          await pollOrder(orderId, schedule);
        }
      } catch (err) {
        console.warn('[swap-order-tracking] tick failed', err);
      } finally {
        running.current = false;
      }
    };

    tick();
    const timer = setInterval(tick, BASE_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}

interface PollableOrder {
  orderId: string;
  schedule: SwapOrderSchedule;
}

/**
 * Cheap Dexie gate: swap rows with a persisted `orderId` that are still worth
 * polling. A completed settlement consume (`extraInputs.swapOrderTxId`, same
 * predicate as `getSwapSettlementNotes`) marks the order terminal even when the
 * lineage poll never resolved — settlement IS the outcome.
 */
async function findPollableOrders(): Promise<PollableOrder[]> {
  const [Repo, { ITransactionStatus }] = await Promise.all([import('lib/miden/repo'), import('lib/miden/db/types')]);

  const swaps = await Repo.transactions
    .filter(tx => tx.type === 'swap' && tx.restoredFromBackup !== true && tx.extraInputs?.orderId != null)
    .toArray();
  if (swaps.length === 0) return [];

  const swapTxIds = new Set(swaps.map(tx => tx.id));
  const settledSwapTxIds = new Set<string>();
  await Repo.transactions
    .filter(
      tx =>
        tx.type === 'consume' &&
        tx.status === ITransactionStatus.Completed &&
        tx.extraInputs?.swapOrderTxId != null &&
        swapTxIds.has(tx.extraInputs.swapOrderTxId)
    )
    .each(tx => {
      if (tx.type === 'consume' && tx.extraInputs?.swapOrderTxId != null) {
        settledSwapTxIds.add(tx.extraInputs.swapOrderTxId);
      }
    });

  const pollable: PollableOrder[] = [];
  for (const tx of swaps) {
    if (tx.type !== 'swap' || tx.extraInputs?.orderId == null) continue;
    const orderId = String(tx.extraInputs.orderId);
    const schedule = getSwapOrderSchedule(orderId);
    if (settledSwapTxIds.has(tx.id)) schedule.terminal = true;
    if (schedule.terminal || schedule.gaveUp) continue;
    pollable.push({ orderId, schedule });
  }
  return pollable;
}

/** One `trackOrderId` round for one order, advancing its backoff schedule. */
async function pollOrder(orderId: string, schedule: SwapOrderSchedule): Promise<void> {
  const { setEntry } = useSwapOrderTrackingStore.getState();
  const previous = useSwapOrderTrackingStore.getState().entries[orderId];
  if (!previous) setEntry(orderId, { tracking: null, loading: true });

  const backOff = () => {
    schedule.unresolved += 1;
    if (schedule.unresolved >= MAX_UNRESOLVED_POLLS) {
      schedule.gaveUp = true;
      console.warn('[swap-order-tracking] gave up tracking order', orderId, {
        attempts: schedule.unresolved
      });
    } else {
      schedule.nextAt = Date.now() + Math.min(BASE_INTERVAL_MS * 2 ** (schedule.unresolved - 1), MAX_INTERVAL_MS);
    }
  };

  try {
    const { trackOrderId } = await import('../transaction/get');
    const result = await trackOrderId(orderId);
    if (result === null) {
      // Not yet trackable / not found — back off and eventually give up.
      setEntry(orderId, { tracking: previous?.tracking ?? null, loading: false });
      backOff();
    } else if (result.state === 'active') {
      setEntry(orderId, { tracking: result, loading: false });
      // Live and resolving; steady watch until a terminal state.
      schedule.unresolved = 0;
      schedule.nextAt = Date.now() + BASE_INTERVAL_MS;
    } else {
      setEntry(orderId, { tracking: result, loading: false });
      // filled / reclaimed → terminal, stop polling.
      schedule.terminal = true;
    }
  } catch (err) {
    console.error('[swap-order-tracking] failed to track order', orderId, err);
    setEntry(orderId, { tracking: previous?.tracking ?? null, loading: false });
    backOff();
  }
}
