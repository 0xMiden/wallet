import { useEffect, useRef } from 'react';

import { isSyncFused, noteProbeFailure, noteSyncSuccess } from './sync-fuse';
import {
  getSwapOrderSchedule,
  useSwapOrderTrackingStore,
  type SwapOrderPollEntry,
  type SwapOrderSchedule
} from '../swap/order-tracking-store';
import { recoveredSwapOrderRef, type RecoveredSwapOrderRef } from '../swap/recovered-order';
import type { RecoveredOrderTracking } from '../swap/recovered-order-tracking';
import type { SwapOrderTracking } from '../transaction/get';

const BASE_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;
// Each check of a recovered order is two node reads, where a lineage check is a local store read.
const RECOVERED_INTERVAL_MS = 30_000;

/**
 * Watch live order lineages at the app root using one snapshot per due batch.
 * A payback consume can precede reclaim, so only filled/reclaimed lineage stops
 * tracking permanently. Missing orders keep checking with bounded backoff.
 * A Guardian-recovered order has no lineage on this device, so its order note
 * is checked on the node instead, outside the lineage read's hold and fuse.
 */
export function SwapOrderTrackingManager(): null {
  const running = useRef(false);

  useEffect(() => {
    let disposed = false;

    const trackLineages = async (due: PollableOrder[]) => {
      if (isSyncFused('swap-order-tracking')) return;
      const { trackSwapOrders } = await import('../transaction/get');
      if (disposed || isSyncFused('swap-order-tracking')) return;

      let tracking: Map<string, SwapOrderTracking> | null;
      try {
        tracking = await trackSwapOrders();
      } catch (err) {
        noteProbeFailure('swap-order-tracking', err);
        console.error('[swap-order-tracking] failed to track orders', err);
        if (!disposed) publishResults(due, new Map(), BASE_INTERVAL_MS);
        return;
      }
      if (disposed || tracking === null) return;
      publishResults(due, lineageResults(tracking), BASE_INTERVAL_MS);
      noteSyncSuccess('swap-order-tracking');
    };

    const trackRecovered = async (due: RecoveredPollableOrder[]) => {
      const { trackRecoveredSwapOrders } = await import('../swap/recovered-order-tracking');
      if (disposed) return;
      let results: Map<string, PollResult>;
      try {
        results = recoveredResults(await trackRecoveredSwapOrders(due.map(order => order.recovered)));
      } catch (err) {
        console.warn('[swap-order-tracking] failed to track recovered orders', err);
        results = new Map();
      }
      if (!disposed) publishResults(due, results, RECOVERED_INTERVAL_MS);
    };

    const tick = async () => {
      if (disposed || running.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      running.current = true;
      try {
        const candidates = await findPollableOrders();
        const now = Date.now();
        const due = candidates.filter(({ schedule }) => schedule.nextAt <= now);
        if (disposed || due.length === 0) return;
        const lineageDue = due.filter(order => order.recovered === undefined);
        const recoveredDue = due.filter((order): order is RecoveredPollableOrder => order.recovered !== undefined);
        if (lineageDue.length > 0) await trackLineages(lineageDue);
        if (!disposed && recoveredDue.length > 0) await trackRecovered(recoveredDue);
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
  /** Set for a Guardian-recovered order, tracked from the node rather than the lineage. */
  recovered?: RecoveredSwapOrderRef;
}

type RecoveredPollableOrder = PollableOrder & { recovered: RecoveredSwapOrderRef };

async function findPollableOrders(): Promise<PollableOrder[]> {
  const Repo = await import('lib/miden/repo');
  const swaps = await Repo.transactions
    .filter(
      tx =>
        tx.type === 'swap' &&
        tx.extraInputs?.orderId != null &&
        (tx.restoredFromBackup !== true || recoveredSwapOrderRef(tx) !== undefined)
    )
    .toArray();

  const pollable = new Map<string, PollableOrder>();
  for (const tx of swaps) {
    if (tx.type !== 'swap' || tx.extraInputs?.orderId == null) continue;
    const orderId = String(tx.extraInputs.orderId);
    const schedule = getSwapOrderSchedule(orderId);
    if (schedule.terminal) continue;
    const recovered = tx.restoredFromBackup === true ? recoveredSwapOrderRef(tx) : undefined;
    // A local row's lineage outranks a recovered record of the same order.
    if (recovered !== undefined && pollable.has(orderId)) continue;
    pollable.set(orderId, { orderId, schedule, recovered });
  }
  return [...pollable.values()];
}

interface PollResult {
  tracking: SwapOrderTracking | null;
  terminal: boolean;
}

const lineageResults = (tracking: ReadonlyMap<string, SwapOrderTracking>): Map<string, PollResult> =>
  new Map(
    [...tracking].map(([orderId, result]) => [orderId, { tracking: result, terminal: result.state !== 'active' }])
  );

const recoveredResults = (results: ReadonlyMap<string, RecoveredOrderTracking>): Map<string, PollResult> =>
  new Map(
    [...results].map(([orderId, result]) => [
      orderId,
      result.kind === 'open' ? { tracking: result.tracking, terminal: false } : { tracking: null, terminal: true }
    ])
  );

function backOff(schedule: SwapOrderSchedule): void {
  schedule.unresolved = Math.min(schedule.unresolved + 1, 5);
  schedule.nextAt = Date.now() + Math.min(BASE_INTERVAL_MS * 2 ** (schedule.unresolved - 1), MAX_INTERVAL_MS);
}

function publishResults(
  orders: PollableOrder[],
  results: ReadonlyMap<string, PollResult>,
  activeIntervalMs: number
): void {
  const previous = useSwapOrderTrackingStore.getState().entries;
  const updates: Record<string, SwapOrderPollEntry> = {};
  for (const { orderId, schedule } of orders) {
    const result = results.get(orderId);
    updates[orderId] = { tracking: result ? result.tracking : (previous[orderId]?.tracking ?? null), loading: false };
    if (!result) {
      backOff(schedule);
    } else if (result.terminal) {
      schedule.terminal = true;
    } else {
      schedule.unresolved = 0;
      schedule.nextAt = Date.now() + activeIntervalMs;
    }
  }
  useSwapOrderTrackingStore.setState(state => ({ entries: { ...state.entries, ...updates } }));
}
