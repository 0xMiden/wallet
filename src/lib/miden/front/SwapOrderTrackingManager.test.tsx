import React from 'react';

import { render, act, cleanup } from '@testing-library/react';

import { SwapOrderTrackingManager } from './SwapOrderTrackingManager';
import {
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncSuccess,
  noteSyncWatchdogEviction,
  syncFuseUntilMs
} from './sync-fuse';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';
import {
  clearSwapOrderSchedulesForTests,
  getSwapOrderSchedule,
  requestSwapOrderRefresh,
  useSwapOrderTrackingStore
} from '../swap/order-tracking-store';
import type { SwapOrderTracking } from '../transaction/get';

const mockTrackSwapOrders = jest.fn<Promise<Map<string, SwapOrderTracking> | null>, []>();
jest.mock('../transaction/get', () => ({
  trackSwapOrders: () => mockTrackSwapOrders()
}));

interface RowExtraInputs {
  orderId?: string | bigint;
  swapOrderTxId?: string;
  swapSettleKind?: 'settled' | 'reclaimed';
  expiresAt?: number;
}

interface Row {
  id: string;
  type: string;
  status: number;
  restoredFromBackup?: boolean;
  extraInputs?: RowExtraInputs;
}
let mockRows: Row[] = [];
const mockReadRows = jest.fn<Promise<Row[]>, [(tx: Row) => boolean]>();
jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (tx: Row) => boolean) => ({
      toArray: () => mockReadRows(predicate)
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
  extraInputs: { swapOrderTxId, swapSettleKind: 'settled' }
});

const activeTracking = (orderId: string): SwapOrderTracking => ({
  orderId,
  state: 'active',
  currentDepth: 1,
  remainingOffered: 500n,
  remainingRequested: 700n
});

const snapshot = (...orders: SwapOrderTracking[]): Map<string, SwapOrderTracking> =>
  new Map(orders.map(order => [order.orderId, order]));

const step = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};

const settleMount = async () => step(0);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('SwapOrderTrackingManager', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    clearSwapOrderSchedulesForTests();
    __resetSyncFuseStateForTests();
    useSwapOrderTrackingStore.setState({ entries: {} });
    mockRows = [];
    mockReadRows.mockImplementation(async predicate => mockRows.filter(predicate));
    mockTrackSwapOrders.mockResolvedValue(new Map());
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
    __resetSyncFuseStateForTests();
  });

  it('polls nothing when no swap row carries an orderId', async () => {
    mockRows = [{ id: 'tx-1', type: 'send', status: COMPLETED }, swapRow(0n, 'swap-no-order')];
    mockRows[1]!.extraInputs = {};
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackSwapOrders).not.toHaveBeenCalled();
  });

  it('publishes an active order and keeps a steady 2s watch', async () => {
    mockRows = [swapRow(9n)];
    mockTrackSwapOrders.mockResolvedValue(snapshot(activeTracking('9')));
    render(<SwapOrderTrackingManager />);
    await settleMount();

    expect(useSwapOrderTrackingStore.getState().entries['9']).toEqual({
      tracking: activeTracking('9'),
      loading: false
    });
    await step(1999);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    await step(1);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(2);
  });

  it('publishes two due orders from one snapshot in one store notification', async () => {
    mockRows = [swapRow(9n), swapRow(10n, 'swap-2')];
    const second: SwapOrderTracking = { ...activeTracking('10'), currentDepth: 3, remainingRequested: 111n };
    mockTrackSwapOrders.mockResolvedValue(snapshot(activeTracking('9'), second));
    const unrelated = { tracking: activeTracking('99'), loading: false };
    useSwapOrderTrackingStore.setState({ entries: { '99': unrelated } });
    const listener = jest.fn();
    const unsubscribe = useSwapOrderTrackingStore.subscribe(listener);
    render(<SwapOrderTrackingManager />);
    await settleMount();
    unsubscribe();

    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useSwapOrderTrackingStore.getState().entries).toEqual({
      '9': { tracking: activeTracking('9'), loading: false },
      '10': { tracking: second, loading: false },
      '99': unrelated
    });
  });

  it('counts a duplicated order id only once in a batch', async () => {
    mockRows = [swapRow(9n), swapRow(9n, 'swap-duplicate')];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    expect(getSwapOrderSchedule('9').unresolved).toBe(1);
  });

  it('stops polling once the lineage reaches filled', async () => {
    mockRows = [swapRow(9n)];
    mockTrackSwapOrders.mockResolvedValue(snapshot({ ...activeTracking('9'), state: 'filled' }));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(getSwapOrderSchedule('9').terminal).toBe(true);
    await step(4000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'error'])('backs off 2, 4, 8, 16, then 30 seconds on %s snapshots', async failure => {
    mockRows = [swapRow(3n)];
    if (failure === 'error') mockTrackSwapOrders.mockRejectedValue(new Error('lineage unavailable'));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    let calls = 1;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      await step(delay - 1);
      expect(mockTrackSwapOrders).toHaveBeenCalledTimes(calls);
      await step(1);
      calls += 1;
      expect(mockTrackSwapOrders).toHaveBeenCalledTimes(calls);
    }
  });

  it('parks an unresolved order after 20 attempts', async () => {
    mockRows = [swapRow(3n)];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(600_000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(20);
    expect(getSwapOrderSchedule('3').gaveUp).toBe(true);
    expect(useSwapOrderTrackingStore.getState().entries['3']).toEqual({ tracking: null, loading: false });
  });

  it.each(['missing', 'error'])('preserves prior tracking on a later %s snapshot', async failure => {
    mockRows = [swapRow(11n)];
    mockTrackSwapOrders.mockResolvedValueOnce(snapshot(activeTracking('11')));
    if (failure === 'error') mockTrackSwapOrders.mockRejectedValueOnce(new Error('lineage exploded'));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(2000);

    expect(useSwapOrderTrackingStore.getState().entries['11']).toEqual({
      tracking: activeTracking('11'),
      loading: false
    });
    expect(getSwapOrderSchedule('11').unresolved).toBe(1);
  });

  it('resets unresolved backoff after an active snapshot', async () => {
    mockRows = [swapRow(3n)];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(2000);
    mockTrackSwapOrders.mockResolvedValue(snapshot(activeTracking('3')));
    await step(4000);
    expect(getSwapOrderSchedule('3').unresolved).toBe(0);
    await step(2000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(4);
  });

  it('tracks an expired partial order after payback through remount until its reclaim lineage arrives', async () => {
    const order = swapRow(42n, 'swap-partial');
    order.extraInputs = { orderId: 42n, expiresAt: 1 };
    mockRows = [order, settlementConsume('swap-partial')];
    mockTrackSwapOrders.mockResolvedValue(snapshot(activeTracking('42')));
    const firstMount = render(<SwapOrderTrackingManager />);
    await settleMount();

    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    expect(getSwapOrderSchedule('42').terminal).toBe(false);
    firstMount.unmount();
    render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(2000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(2);

    mockRows.push({
      ...settlementConsume('swap-partial'),
      id: 'consume-reclaim',
      extraInputs: { swapOrderTxId: 'swap-partial', swapSettleKind: 'reclaimed' }
    });
    const reclaimed: SwapOrderTracking = { ...activeTracking('42'), state: 'reclaimed' };
    mockTrackSwapOrders.mockResolvedValue(snapshot(reclaimed));
    await step(2000);
    expect(useSwapOrderTrackingStore.getState().entries['42']).toEqual({ tracking: reclaimed, loading: false });
    expect(getSwapOrderSchedule('42').terminal).toBe(true);
    await step(30_000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(3);
  });

  it('does not poll an order restored from a backup', async () => {
    mockRows = [{ ...swapRow(42n), restoredFromBackup: true }];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackSwapOrders).not.toHaveBeenCalled();
  });

  it('requestSwapOrderRefresh revives a given-up order for the next tick', async () => {
    mockRows = [swapRow(5n)];
    const schedule = getSwapOrderSchedule('5');
    schedule.gaveUp = true;
    schedule.unresolved = 20;
    schedule.nextAt = Date.now() + 30_000;
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackSwapOrders).not.toHaveBeenCalled();
    act(() => requestSwapOrderRefresh('5'));
    await step(2000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    expect(schedule.unresolved).toBe(1);
  });

  it('does not revive terminal orders or notify subscribers for schedule-only refreshes', async () => {
    const schedule = getSwapOrderSchedule('5');
    schedule.terminal = true;
    schedule.nextAt = 5000;
    const listener = jest.fn();
    const unsubscribe = useSwapOrderTrackingStore.subscribe(listener);
    requestSwapOrderRefresh('5');
    unsubscribe();
    expect(schedule).toEqual({ unresolved: 0, nextAt: 5000, gaveUp: false, terminal: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('pauses while hidden and resumes when visible', async () => {
    const hiddenSpy = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mockRows = [swapRow(9n)];
    render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(2000);
    expect(mockTrackSwapOrders).not.toHaveBeenCalled();
    hiddenSpy.mockReturnValue(false);
    await step(2000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
  });

  it('does not overlap a pending snapshot or publish it after unmount', async () => {
    mockRows = [swapRow(9n)];
    const pending = deferred<Map<string, SwapOrderTracking> | null>();
    mockTrackSwapOrders.mockReturnValue(pending.promise);
    const mounted = render(<SwapOrderTrackingManager />);
    await settleMount();
    await step(6000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    mounted.unmount();
    pending.resolve(snapshot(activeTracking('9')));
    await settleMount();
    await step(4000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    expect(useSwapOrderTrackingStore.getState().entries).toEqual({});
  });

  it('does not start a snapshot when the row scan completes after unmount', async () => {
    const pending = deferred<Row[]>();
    mockReadRows.mockReturnValue(pending.promise);
    const mounted = render(<SwapOrderTrackingManager />);
    await settleMount();
    mounted.unmount();
    pending.resolve([swapRow(9n)]);
    await settleMount();
    expect(mockTrackSwapOrders).not.toHaveBeenCalled();
  });

  it('recovers from a failed row scan without spending a poll attempt', async () => {
    mockRows = [swapRow(9n)];
    mockReadRows.mockRejectedValueOnce(new Error('database busy'));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    expect(mockTrackSwapOrders).not.toHaveBeenCalled();
    await step(2000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
    expect(getSwapOrderSchedule('9').unresolved).toBe(1);
  });

  it('fuses after four watchdog evictions and probes again only after its deadline', async () => {
    mockRows = [swapRow(9n)];
    mockTrackSwapOrders.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    for (const delay of [2000, 4000, 8000]) {
      noteSyncSuccess('idle-sync');
      await step(delay);
    }
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(4);
    expect(isSyncFused('swap-order-tracking')).toBe(true);
    const deadline = syncFuseUntilMs('swap-order-tracking');
    noteSyncSuccess('idle-sync');
    await step(1_800_000 - 1);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(4);
    expect(syncFuseUntilMs('swap-order-tracking')).toBe(deadline);
    expect(getSwapOrderSchedule('9').unresolved).toBe(4);

    mockTrackSwapOrders.mockResolvedValue(snapshot(activeTracking('9')));
    await step(1);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(5);
    expect(syncFuseUntilMs('swap-order-tracking')).toBeNull();
    noteSyncWatchdogEviction('swap-order-tracking');
    expect(isSyncFused('swap-order-tracking')).toBe(false);
  });

  it('does not treat a fused in-lock skip as a snapshot or a successful probe', async () => {
    mockRows = [swapRow(9n)];
    const pending = deferred<Map<string, SwapOrderTracking> | null>();
    mockTrackSwapOrders.mockReturnValue(pending.promise);
    render(<SwapOrderTrackingManager />);
    await settleMount();
    for (let i = 0; i < 4; i += 1) noteSyncWatchdogEviction('swap-order-tracking');
    pending.resolve(null);
    await settleMount();
    expect(isSyncFused('swap-order-tracking')).toBe(true);
    expect(getSwapOrderSchedule('9').unresolved).toBe(0);
    expect(useSwapOrderTrackingStore.getState().entries).toEqual({});
  });

  it('clears unlit eviction evidence on ordinary read failures', async () => {
    mockRows = [swapRow(9n)];
    for (let i = 0; i < 3; i += 1) noteSyncWatchdogEviction('swap-order-tracking');
    mockTrackSwapOrders.mockRejectedValue(new Error('offline'));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    noteSyncWatchdogEviction('swap-order-tracking');
    expect(isSyncFused('swap-order-tracking')).toBe(false);
  });
});
