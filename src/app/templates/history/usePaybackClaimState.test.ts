import { act, renderHook } from '@testing-library/react';

import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import { usePaybackClaimState } from './usePaybackClaimState';

type Observer = { next: (value: unknown) => void; error: (error: unknown) => void };
const mockObservers: Observer[] = [];
const mockUnsubscribe = jest.fn();
const mockGetPaybackClaimState = jest.fn();

jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (query: () => unknown, observer: Observer) => {
    query();
    mockObservers.push(observer);
    return mockUnsubscribe;
  }
}));
jest.mock('lib/miden/swap/payback-claim', () => ({
  getPaybackClaimState: (...args: unknown[]) => mockGetPaybackClaimState(...args)
}));

const swap = { id: 'swap-1', type: 'swap', status: ITransactionStatus.Completed } as unknown as ITransaction;

beforeEach(() => {
  mockObservers.length = 0;
  jest.clearAllMocks();
  mockGetPaybackClaimState.mockReset();
});

describe('usePaybackClaimState', () => {
  it('follows every push of the live read, so a claim that lands clears the stuck state (F-006)', () => {
    const { result } = renderHook(() => usePaybackClaimState(swap));
    expect(mockGetPaybackClaimState).toHaveBeenCalledWith(swap);
    expect(result.current).toBeNull();

    act(() => mockObservers[0]!.next({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' }));
    expect(result.current).toEqual({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' });

    act(() => mockObservers[0]!.next({ stuck: false }));
    expect(result.current).toEqual({ stuck: false });
  });

  it('re-reads every minute, since a note hold can expire with no row written (F-008)', async () => {
    jest.useFakeTimers();
    try {
      mockGetPaybackClaimState.mockResolvedValue({ stuck: true, failedClaimId: 'claim-1', reason: 'other' });
      const { result } = renderHook(() => usePaybackClaimState(swap));
      act(() => mockObservers[0]!.next({ stuck: false }));
      expect(result.current).toEqual({ stuck: false });

      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(result.current).toEqual({ stuck: true, failedClaimId: 'claim-1', reason: 'other' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the stuck payout when the same swap is handed a new row object (F-009)', async () => {
    jest.useFakeTimers();
    try {
      mockGetPaybackClaimState.mockResolvedValue({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' });
      const { result, rerender } = renderHook(({ row }) => usePaybackClaimState(row), { initialProps: { row: swap } });
      act(() => mockObservers[0]!.next({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' }));

      const stamped = { ...swap, settledAt: 1 } as ITransaction;
      rerender({ row: stamped });
      expect(result.current).toEqual({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' });
      expect(mockUnsubscribe).not.toHaveBeenCalled();
      expect(mockObservers).toHaveLength(1);

      mockGetPaybackClaimState.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(mockGetPaybackClaimState).toHaveBeenCalledWith(stamped);

      rerender({ row: { ...stamped, status: ITransactionStatus.Failed } as ITransaction });
      expect(result.current).toBeNull();
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

      act(() => mockObservers[1]!.next({ stuck: false }));
      rerender({ row: { ...stamped, id: 'swap-2' } as ITransaction });
      expect(result.current).toBeNull();
      expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  const deferredReads = () => {
    const resolvers: ((value: unknown) => void)[] = [];
    mockGetPaybackClaimState.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvers.push(resolve);
        })
    );
    return resolvers;
  };

  it('does not apply a minute read after the swap id changes (F-012)', async () => {
    jest.useFakeTimers();
    try {
      const resolvers = deferredReads();
      const { result, rerender } = renderHook(({ row }) => usePaybackClaimState(row), { initialProps: { row: swap } });
      act(() => mockObservers[0]!.next({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' }));
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(resolvers).toHaveLength(2);

      rerender({ row: { ...swap, id: 'swap-2' } as ITransaction });
      await act(async () => {
        resolvers[1]!({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' });
        await Promise.resolve();
      });
      expect(result.current).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let a minute read overwrite a live push that landed after it started (F-012)', async () => {
    jest.useFakeTimers();
    try {
      const resolvers = deferredReads();
      const { result } = renderHook(() => usePaybackClaimState(swap));
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      act(() => mockObservers[0]!.next({ stuck: true, failedClaimId: 'claim-2', reason: 'network' }));
      await act(async () => {
        resolvers[1]!({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' });
        await Promise.resolve();
      });
      expect(result.current).toEqual({ stuck: true, failedClaimId: 'claim-2', reason: 'network' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('subscribes to nothing for a row that is not a swap, and unsubscribes on unmount', () => {
    const send = { ...swap, type: 'send' } as ITransaction;
    const { result, rerender, unmount } = renderHook(({ row }) => usePaybackClaimState(row), {
      initialProps: { row: send }
    });
    expect(mockObservers).toHaveLength(0);
    expect(result.current).toBeNull();

    rerender({ row: swap });
    expect(mockObservers).toHaveLength(1);
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
