import React from 'react';

import { render, act } from '@testing-library/react';

import type { SwapOrderTracking } from '../transaction/get';

import { SwapOrderTrackingManager } from './SwapOrderTrackingManager';
import {
  clearSwapOrderSchedulesForTests,
  getSwapOrderSchedule,
  useSwapOrderTrackingStore
} from '../swap/order-tracking-store';

const mockTrackOrderId = jest.fn();
jest.mock('../transaction/get', () => ({
  trackOrderId: (orderId: string | bigint) => mockTrackOrderId(orderId)
}));

interface RowExtraInputs {
  orderId?: string | bigint;
  swapOrderTxId?: string;
}

interface Row {
  id: string;
  type: string;
  status: number;
  restoredFromBackup?: boolean;
  extraInputs?: RowExtraInputs;
}
let mockRows: Row[] = [];
jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (tx: Row) => boolean) => ({
      toArray: async () => mockRows.filter(predicate),
      each: async (callback: (tx: Row) => void) => {
        mockRows.filter(predicate).forEach(callback);
      }
    })
  }
}));

const COMPLETED = 2;

const swapRow = (orderId: bigint, id = 'swap-1'): Row => ({
  id,
  type: 'swap',
  status: COMPLETED,
  extraInputs: { orderId }
});

const settlementConsume = (swapOrderTxId: string): Row => ({
  id: `consume-${swapOrderTxId}`,
  type: 'consume',
  status: COMPLETED,
  extraInputs: { swapOrderTxId }
});

const activeTracking = (orderId: string): SwapOrderTracking => ({
  orderId,
  state: 'active',
  currentDepth: 1,
  remainingOffered: 0n,
  remainingRequested: 700n
});

/** Advance the manager's interval and drain the async tick. */
const step = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
};

/** Drain the immediate mount tick. */
const settleMount = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
};

describe('SwapOrderTrackingManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    clearSwapOrderSchedulesForTests();
    useSwapOrderTrackingStore.setState({ entries: {} });
    mockRows = [];
    mockTrackOrderId.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('polls nothing when no swap row carries an orderId', async () => {
    mockRows = [{ id: 'tx-1', type: 'send', status: COMPLETED }, swapRow(0n, 'swap-no-order')];
    mockRows[1]!.extraInputs = {};
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackOrderId).not.toHaveBeenCalled();
  });

  it('publishes an active order to the store and keeps a steady 2s watch', async () => {
    mockRows = [swapRow(9n)];
    mockTrackOrderId.mockResolvedValue(activeTracking('9'));
    render(<SwapOrderTrackingManager />);
    await settleMount();

    expect(mockTrackOrderId).toHaveBeenCalledWith('9');
    expect(useSwapOrderTrackingStore.getState().entries['9']).toEqual({
      tracking: activeTracking('9'),
      loading: false
    });

    await step(2000);
    expect(mockTrackOrderId).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the lineage reaches a terminal state', async () => {
    mockRows = [swapRow(9n)];
    mockTrackOrderId.mockResolvedValue({ ...activeTracking('9'), state: 'filled' });
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(getSwapOrderSchedule('9').terminal).toBe(true);

    await step(2000);
    await step(2000);
    expect(mockTrackOrderId).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially on unresolved polls and gives up after the cap', async () => {
    mockRows = [swapRow(3n)];
    mockTrackOrderId.mockResolvedValue(null);
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackOrderId).toHaveBeenCalledTimes(1);

    // Second poll only becomes due after the 2s backoff, not immediately.
    await step(1000);
    expect(mockTrackOrderId).toHaveBeenCalledTimes(1);
    await step(1000);
    expect(mockTrackOrderId).toHaveBeenCalledTimes(2);

    // Drive far past every backoff window: exactly 20 attempts, then parked.
    for (let i = 0; i < 30; i += 1) await step(30_000);
    expect(mockTrackOrderId).toHaveBeenCalledTimes(20);
    expect(getSwapOrderSchedule('3').gaveUp).toBe(true);
    expect(useSwapOrderTrackingStore.getState().entries['3']).toEqual({ tracking: null, loading: false });
  });

  it('treats a thrown poll like an unresolved one and keeps the last tracking', async () => {
    mockRows = [swapRow(11n)];
    mockTrackOrderId.mockResolvedValueOnce(activeTracking('11')).mockRejectedValueOnce(new Error('lineage exploded'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(2000);

    expect(errorSpy).toHaveBeenCalled();
    expect(useSwapOrderTrackingStore.getState().entries['11']).toEqual({
      tracking: activeTracking('11'),
      loading: false
    });
    expect(getSwapOrderSchedule('11').unresolved).toBe(1);
    errorSpy.mockRestore();
  });

  it('marks an order terminal without polling when a settlement consume already landed', async () => {
    mockRows = [swapRow(42n, 'swap-settled'), settlementConsume('swap-settled')];
    render(<SwapOrderTrackingManager />);
    await settleMount();

    expect(mockTrackOrderId).not.toHaveBeenCalled();
    expect(getSwapOrderSchedule('42').terminal).toBe(true);
  });

  it('does not poll an order restored from a backup', async () => {
    mockRows = [{ ...swapRow(42n), restoredFromBackup: true }];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackOrderId).not.toHaveBeenCalled();
  });

  it('requestRefresh revives a given-up order so the next tick re-polls it', async () => {
    mockRows = [swapRow(5n)];
    const schedule = getSwapOrderSchedule('5');
    schedule.gaveUp = true;
    schedule.unresolved = 20;
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackOrderId).not.toHaveBeenCalled();

    act(() => useSwapOrderTrackingStore.getState().requestRefresh('5'));
    await step(2000);
    expect(mockTrackOrderId).toHaveBeenCalledWith('5');
  });

  it('does not tick while the document is hidden', async () => {
    const hiddenSpy = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mockRows = [swapRow(9n)];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackOrderId).not.toHaveBeenCalled();
    hiddenSpy.mockRestore();
  });
});
