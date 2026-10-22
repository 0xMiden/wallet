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
});

describe('usePaybackClaimState', () => {
  it('follows every push of the live read, so a claim that lands clears the stuck state (F-006)', () => {
    const { result } = renderHook(() => usePaybackClaimState(swap));
    expect(mockGetPaybackClaimState).toHaveBeenCalledWith(swap);
    expect(result.current).toBeNull();

    act(() => mockObservers[0].next({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' }));
    expect(result.current).toEqual({ stuck: true, failedClaimId: 'claim-1', reason: 'fee' });

    act(() => mockObservers[0].next({ stuck: false }));
    expect(result.current).toEqual({ stuck: false });
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
