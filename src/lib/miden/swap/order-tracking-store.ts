import { create } from 'zustand';

import type { SwapOrderTracking } from 'lib/miden/transaction/get';

/**
 * Session-scoped store of live PSWAP order-lineage tracking, keyed by
 * `String(orderId)`. Written by the app-root `SwapOrderTrackingManager`
 * (which owns the actual `trackOrderId` polling and its backoff), read by the
 * history detail page. Deliberately in-memory only: the tracking card is
 * display-only and the list derives its swap status from the Dexie-persisted
 * `settledAt`/`reclaimedAt` stamps instead.
 */
export interface SwapOrderPollEntry {
  /** Last poll result; null = polled but the order isn't trackable (yet). */
  tracking: SwapOrderTracking | null;
  /** True while a poll for this order is in flight. */
  loading: boolean;
}

interface SwapOrderTrackingState {
  entries: Record<string, SwapOrderPollEntry>;
}

interface SwapOrderTrackingActions {
  setEntry(orderId: string, entry: SwapOrderPollEntry): void;
  /**
   * Revive a given-up (or backed-off) order so the manager re-polls it soon —
   * called by the detail page on mount, preserving the old "reopening the page
   * restarts the poll" behavior. No-op for terminally resolved orders.
   */
  requestRefresh(orderId: string): void;
}

export type SwapOrderTrackingStore = SwapOrderTrackingState & SwapOrderTrackingActions;

/**
 * Per-order scheduler bookkeeping, deliberately OUT of the store (none of it is
 * rendered; mirrors the deposit-bridge store's module-local poll state). Shared
 * between `requestRefresh` and the manager's tick.
 */
export interface SwapOrderSchedule {
  /** Consecutive polls that returned null / threw. */
  unresolved: number;
  /** Epoch ms before which the manager must not poll this order again. */
  nextAt: number;
  /** Backoff budget exhausted — parked until a `requestRefresh`. */
  gaveUp: boolean;
  /** Lineage reached filled/reclaimed (or settlement landed) — never poll again. */
  terminal: boolean;
}

const schedules = new Map<string, SwapOrderSchedule>();

export function getSwapOrderSchedule(orderId: string): SwapOrderSchedule {
  let schedule = schedules.get(orderId);
  if (!schedule) {
    schedule = { unresolved: 0, nextAt: 0, gaveUp: false, terminal: false };
    schedules.set(orderId, schedule);
  }
  return schedule;
}

export function clearSwapOrderSchedulesForTests(): void {
  schedules.clear();
}

export const useSwapOrderTrackingStore = create<SwapOrderTrackingStore>(set => ({
  entries: {},

  setEntry(orderId, entry) {
    set(state => ({ entries: { ...state.entries, [orderId]: entry } }));
  },

  requestRefresh(orderId) {
    const schedule = getSwapOrderSchedule(orderId);
    if (schedule.terminal) return;
    schedule.unresolved = 0;
    schedule.nextAt = 0;
    schedule.gaveUp = false;
  }
}));
