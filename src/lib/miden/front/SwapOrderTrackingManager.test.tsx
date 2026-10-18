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
const mockTrackRecoveredSwapOrders = jest.fn();
jest.mock('../swap/recovered-order-tracking', () => ({
  trackRecoveredSwapOrders: (...args: unknown[]) => mockTrackRecoveredSwapOrders(...args)
}));

interface RowExtraInputs {
  orderId?: string | bigint;
  swapOrderTxId?: string;
  swapSettleKind?: 'settled' | 'reclaimed';
  expiresAt?: number;
  requestedAmount?: bigint;
  autoConsume?: boolean;
  settledAt?: number;
  lineageClosedAt?: number;
}

interface Row {
  id: string;
  type: string;
  status: number;
  restoredFromBackup?: boolean;
  recovered?: boolean;
  accountId?: string;
  amount?: bigint;
  outputNoteIds?: string[];
  recovery?: { outputNotes: Array<{ id: string; swap?: { orderId: string; requestedAsset?: unknown } }> };
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

// A Guardian-recovered order: this device's SDK never tracked it, so only the node can say it is open (#1487).
const recoveredRow = (orderId: string, extraInputs: RowExtraInputs = {}): Row => ({
  id: `recovered-${orderId}`,
  type: 'swap',
  status: COMPLETED,
  accountId: 'account',
  amount: 70n,
  outputNoteIds: [`note-${orderId}`],
  restoredFromBackup: true,
  recovered: true,
  recovery: {
    outputNotes: [{ id: `note-${orderId}`, swap: { orderId, requestedAsset: { faucetId: 'requested', amount: '30' } } }]
  },
  extraInputs: { orderId, requestedAmount: 30n, autoConsume: false, ...extraInputs }
});

const recoveredTracking = (orderId: string): SwapOrderTracking => ({
  orderId,
  state: 'active',
  currentDepth: 0,
  remainingOffered: 70n,
  remainingRequested: 30n
});

const openOnNode = (orderId: string) => new Map([[orderId, { kind: 'open', tracking: recoveredTracking(orderId) }]]);

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
    mockTrackRecoveredSwapOrders.mockResolvedValue(new Map());
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

  it('keeps polling an unresolved order at the capped interval until terminal lineage arrives', async () => {
    mockRows = [swapRow(3n)];
    const schedule = getSwapOrderSchedule('3');
    schedule.unresolved = 5;
    schedule.nextAt = 0;
    render(<SwapOrderTrackingManager />);
    await settleMount();

    for (let attempt = 1; attempt < 15; attempt++) await step(30_000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(15);
    expect(useSwapOrderTrackingStore.getState().entries['3']).toEqual({ tracking: null, loading: false });

    const filled: SwapOrderTracking = { ...activeTracking('3'), state: 'filled' };
    mockTrackSwapOrders.mockResolvedValue(snapshot(filled));
    await step(30_000);
    expect(mockTrackSwapOrders).toHaveBeenCalledTimes(16);
    expect(useSwapOrderTrackingStore.getState().entries['3']).toEqual({ tracking: filled, loading: false });
    expect(getSwapOrderSchedule('3').terminal).toBe(true);
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

  it('requestSwapOrderRefresh makes a backed-off order due on the next tick', async () => {
    mockRows = [swapRow(5n)];
    const schedule = getSwapOrderSchedule('5');
    schedule.unresolved = 5;
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
    expect(schedule).toEqual({ unresolved: 0, nextAt: 5000, terminal: true });
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

  // A trap abandons the read without learning anything about the node.
  it('keeps unlit eviction evidence on a realm-error eviction', async () => {
    mockRows = [swapRow(9n)];
    for (let i = 0; i < 3; i += 1) noteSyncWatchdogEviction('swap-order-tracking');
    mockTrackSwapOrders.mockRejectedValue(new WasmClientPoisonedError('realm-error'));
    render(<SwapOrderTrackingManager />);
    await settleMount();
    noteSyncWatchdogEviction('swap-order-tracking');
    expect(isSyncFused('swap-order-tracking')).toBe(true);
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
  describe('recovered orders', () => {
    it('tracks an open recovered order from the node, and checks it again every 30 seconds', async () => {
      mockRows = [recoveredRow('7')];
      mockTrackRecoveredSwapOrders.mockResolvedValue(openOnNode('7'));
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledWith([
        {
          txId: 'recovered-7',
          accountId: 'account',
          orderId: '7',
          noteId: 'note-7',
          offeredAmount: 70n,
          requestedAmount: 30n,
          tipNoteId: 'note-7',
          tipDepth: 0,
          tipOfferedAmount: 70n
        }
      ]);
      expect(mockTrackSwapOrders).not.toHaveBeenCalled();
      expect(useSwapOrderTrackingStore.getState().entries['7']).toEqual({
        tracking: recoveredTracking('7'),
        loading: false
      });
      await step(29_999);
      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledTimes(1);
      await step(1);
      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledTimes(2);
    });

    it('stops tracking a recovered order once it closes, and drops its open lineage', async () => {
      mockRows = [recoveredRow('7')];
      mockTrackRecoveredSwapOrders.mockResolvedValueOnce(openOnNode('7'));
      mockTrackRecoveredSwapOrders.mockResolvedValue(new Map([['7', { kind: 'closed' }]]));
      render(<SwapOrderTrackingManager />);
      await settleMount();
      await step(30_000);

      expect(useSwapOrderTrackingStore.getState().entries['7']).toEqual({ tracking: null, loading: false });
      expect(getSwapOrderSchedule('7').terminal).toBe(true);
      await step(60_000);
      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledTimes(2);
    });

    it('backs an unresolved recovered order off like any other, keeping what it last knew', async () => {
      mockRows = [recoveredRow('7')];
      mockTrackRecoveredSwapOrders.mockResolvedValueOnce(openOnNode('7'));
      mockTrackRecoveredSwapOrders.mockResolvedValue(new Map());
      render(<SwapOrderTrackingManager />);
      await settleMount();
      await step(30_000);

      expect(getSwapOrderSchedule('7').unresolved).toBe(1);
      expect(useSwapOrderTrackingStore.getState().entries['7']).toEqual({
        tracking: recoveredTracking('7'),
        loading: false
      });
      await step(2000);
      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledTimes(3);
    });

    it('reads a failed node pass as unresolved', async () => {
      mockRows = [recoveredRow('7')];
      mockTrackRecoveredSwapOrders.mockRejectedValue(new Error('wasm unavailable'));
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(useSwapOrderTrackingStore.getState().entries['7']).toEqual({ tracking: null, loading: false });
      expect(getSwapOrderSchedule('7').unresolved).toBe(1);
    });

    it('reads the lineage, not the node, for an order a local row also carries', async () => {
      mockRows = [recoveredRow('9'), swapRow(9n)];
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);
      expect(mockTrackRecoveredSwapOrders).not.toHaveBeenCalled();
    });

    // The live poll waits on the WASM lock, which a recovered check never takes (#1487).
    it('publishes a recovered order while the live poll is still out, and starts no second live poll', async () => {
      mockRows = [recoveredRow('7'), swapRow(9n)];
      const pending = deferred<Map<string, SwapOrderTracking> | null>();
      mockTrackSwapOrders.mockReturnValue(pending.promise);
      mockTrackRecoveredSwapOrders.mockResolvedValue(openOnNode('7'));
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(useSwapOrderTrackingStore.getState().entries['7']).toEqual({
        tracking: recoveredTracking('7'),
        loading: false
      });
      await step(6000);
      expect(mockTrackSwapOrders).toHaveBeenCalledTimes(1);

      pending.resolve(snapshot(activeTracking('9')));
      await settleMount();
      expect(useSwapOrderTrackingStore.getState().entries['9']).toEqual({
        tracking: activeTracking('9'),
        loading: false
      });
      await step(2000);
      expect(mockTrackSwapOrders).toHaveBeenCalledTimes(2);
    });

    it('keeps the live poll on its 2s watch while a recovered check is out, and starts no second check', async () => {
      mockRows = [recoveredRow('7'), swapRow(9n)];
      const pending = deferred<Map<string, unknown>>();
      mockTrackRecoveredSwapOrders.mockReturnValue(pending.promise);
      mockTrackSwapOrders.mockResolvedValue(snapshot(activeTracking('9')));
      render(<SwapOrderTrackingManager />);
      await settleMount();
      await step(6000);

      expect(mockTrackSwapOrders).toHaveBeenCalledTimes(4);
      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledTimes(1);

      pending.resolve(openOnNode('7'));
      await settleMount();
      expect(useSwapOrderTrackingStore.getState().entries['7']).toEqual({
        tracking: recoveredTracking('7'),
        loading: false
      });
    });

    it('keeps tracking recovered orders from the node while the lineage probe is fused', async () => {
      for (let i = 0; i < 4; i += 1) noteSyncWatchdogEviction('swap-order-tracking');
      mockRows = [recoveredRow('7'), swapRow(9n)];
      mockTrackRecoveredSwapOrders.mockResolvedValue(openOnNode('7'));
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(isSyncFused('swap-order-tracking')).toBe(true);
      expect(mockTrackSwapOrders).not.toHaveBeenCalled();
      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledTimes(1);
    });

    it('does not poll a recovered order its lineage closed settled', async () => {
      mockRows = [recoveredRow('7', { settledAt: 200, lineageClosedAt: 200 })];
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(mockTrackRecoveredSwapOrders).not.toHaveBeenCalled();
      expect(mockTrackSwapOrders).not.toHaveBeenCalled();
    });

    // The pre-fix recovery reconcile stamped it from a linked payout with no lineage read (#1487).
    it('polls a recovered order whose settlement stamp no lineage read recorded', async () => {
      mockRows = [recoveredRow('7', { settledAt: 200 })];
      mockTrackRecoveredSwapOrders.mockResolvedValue(openOnNode('7'));
      render(<SwapOrderTrackingManager />);
      await settleMount();

      expect(mockTrackRecoveredSwapOrders).toHaveBeenCalledWith([
        expect.objectContaining({ txId: 'recovered-7', provisionalClosure: true })
      ]);
    });
  });
});
