import { useEffect, useRef } from 'react';

import { isSyncFused, noteNonEvictionSyncFailure, noteSyncSuccess, noteSyncWatchdogEviction } from './sync-fuse';
import { isSyncWatchdogEviction } from '../sdk/wasm-client-poison';
import {
  getSwapOrderSchedule,
  useSwapOrderTrackingStore,
  type SwapOrderPollEntry,
  type SwapOrderSchedule
} from '../swap/order-tracking-store';
import type { SwapOrderTracking } from '../transaction/get';

const BASE_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;
const MAX_UNRESOLVED_POLLS = 20;

/**
 * Watch live order lineages at the app root using one snapshot per due batch.
 * A payback consume can precede reclaim, so only filled/reclaimed lineage stops
 * tracking permanently. Missing orders back off until the detail page requests a retry.
 */
export function SwapOrderTrackingManager(): null {
  const running = useRef(false);

  useEffect(() => {
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current || isSyncFused('swap-order-tracking')) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      running.current = true;
      try {
        const candidates = await findPollableOrders();
        const now = Date.now();
        const due = candidates.filter(({ schedule }) => schedule.nextAt <= now);
        if (disposed || due.length === 0) return;
        const { trackSwapOrders } = await import('../transaction/get');
        if (disposed || isSyncFused('swap-order-tracking')) return;

        let tracking: Map<string, SwapOrderTracking> | null;
        try {
          tracking = await trackSwapOrders();
        } catch (err) {
          if (isSyncWatchdogEviction(err)) noteSyncWatchdogEviction('swap-order-tracking');
          else noteNonEvictionSyncFailure('swap-order-tracking');
          console.error('[swap-order-tracking] failed to track orders', err);
          if (!disposed) publishSnapshot(due, new Map());
          return;
        }
        if (disposed || tracking === null) return;
        publishSnapshot(due, tracking);
        noteSyncSuccess('swap-order-tracking');
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

async function findPollableOrders(): Promise<PollableOrder[]> {
  const Repo = await import('lib/miden/repo');
  const swaps = await Repo.transactions
    .filter(tx => tx.type === 'swap' && tx.restoredFromBackup !== true && tx.extraInputs?.orderId != null)
    .toArray();

  const pollable = new Map<string, PollableOrder>();
  for (const tx of swaps) {
    if (tx.type !== 'swap' || tx.extraInputs?.orderId == null) continue;
    const orderId = String(tx.extraInputs.orderId);
    const schedule = getSwapOrderSchedule(orderId);
    if (schedule.terminal || schedule.gaveUp) continue;
    pollable.set(orderId, { orderId, schedule });
  }
  return [...pollable.values()];
}

function backOff(orderId: string, schedule: SwapOrderSchedule): void {
  schedule.unresolved += 1;
  if (schedule.unresolved >= MAX_UNRESOLVED_POLLS) {
    schedule.gaveUp = true;
    console.warn('[swap-order-tracking] gave up tracking order', orderId, { attempts: schedule.unresolved });
  } else {
    schedule.nextAt = Date.now() + Math.min(BASE_INTERVAL_MS * 2 ** (schedule.unresolved - 1), MAX_INTERVAL_MS);
  }
}

function publishSnapshot(orders: PollableOrder[], tracking: ReadonlyMap<string, SwapOrderTracking>): void {
  const previous = useSwapOrderTrackingStore.getState().entries;
  const updates: Record<string, SwapOrderPollEntry> = {};
  for (const { orderId, schedule } of orders) {
    const result = tracking.get(orderId);
    updates[orderId] = { tracking: result ?? previous[orderId]?.tracking ?? null, loading: false };
    if (!result) {
      backOff(orderId, schedule);
    } else if (result.state === 'active') {
      schedule.unresolved = 0;
      schedule.nextAt = Date.now() + BASE_INTERVAL_MS;
    } else {
      schedule.terminal = true;
    }
  }
  useSwapOrderTrackingStore.setState(state => ({ entries: { ...state.entries, ...updates } }));
}
