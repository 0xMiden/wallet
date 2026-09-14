import { create } from 'zustand';

import type { SwapOrderTracking } from 'lib/miden/transaction/get';

/** Session-only lineage results for history details; activity lists use persisted settlement stamps. */
export interface SwapOrderPollEntry {
  /** Last known result, retained when a later read fails or cannot find the order. */
  tracking: SwapOrderTracking | null;
  /** Whether the initial lineage read is still pending. */
  loading: boolean;
}

interface SwapOrderTrackingState {
  entries: Record<string, SwapOrderPollEntry>;
}

interface SwapOrderTrackingActions {
  setEntry(orderId: string, entry: SwapOrderPollEntry): void;
}

export type SwapOrderTrackingStore = SwapOrderTrackingState & SwapOrderTrackingActions;

/** Non-rendered scheduling state survives detail-page and root-manager remounts. */
export interface SwapOrderSchedule {
  /** Consecutive missing or failed reads. */
  unresolved: number;
  /** Earliest permitted poll time in epoch milliseconds. */
  nextAt: number;
  /** Explicit filled or reclaimed lineage was observed. */
  terminal: boolean;
}

const schedules = new Map<string, SwapOrderSchedule>();

export function getSwapOrderSchedule(orderId: string): SwapOrderSchedule {
  let schedule = schedules.get(orderId);
  if (!schedule) {
    schedule = { unresolved: 0, nextAt: 0, terminal: false };
    schedules.set(orderId, schedule);
  }
  return schedule;
}

/** Reopening a detail page revives unresolved orders, but never terminal orders. */
export function requestSwapOrderRefresh(orderId: string): void {
  const schedule = getSwapOrderSchedule(orderId);
  if (schedule.terminal) return;
  schedule.unresolved = 0;
  schedule.nextAt = 0;
}

export function clearSwapOrderSchedulesForTests(): void {
  schedules.clear();
}

export const useSwapOrderTrackingStore = create<SwapOrderTrackingStore>(set => ({
  entries: {},

  setEntry(orderId, entry) {
    set(state => ({ entries: { ...state.entries, [orderId]: entry } }));
  }
}));
