import { act, renderHook, waitFor } from '@testing-library/react';

import type { IOneClickPhase, ITransaction } from 'lib/miden/db/types';
import { NEAR_TEST_DEADLINE, nearRowFixture, nearTrackingFixture } from 'screens/near-intents-flow/testing';

import {
  nearDepositHomeStateOf,
  nearDepositStageOf,
  readNearDeposits,
  useNearDeposits,
  useNowAtDeadlines
} from './near-pending-deposits';

let mockRows: ITransaction[] = [];
const mockWhere = jest.fn();
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: (index: string) => {
      mockWhere(index);
      return {
        equals: (type: string) => ({
          filter: (keep: (row: ITransaction) => boolean) => ({
            toArray: async () => mockRows.filter(row => row.type === type && keep(row))
          })
        })
      };
    }
  }
}));

type Observer<T> = { next: (value: T) => void; error: (error: unknown) => void };
const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();
let mockFailRead = false;
jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: <T>(query: () => Promise<T>, observer: Observer<T>) => {
    mockSubscribe();
    query().then(
      value => (mockFailRead ? observer.error(new Error('read failed')) : observer.next(value)),
      observer.error
    );
    return mockUnsubscribe;
  }
}));

const DEADLINE = Date.parse(NEAR_TEST_DEADLINE);

beforeEach(() => {
  mockRows = [];
  mockFailRead = false;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('nearDepositStageOf', () => {
  it.each<[IOneClickPhase, string]>([
    ['depositing', 'waiting'],
    ['pending-deposit', 'waiting'],
    ['incomplete-deposit', 'waiting'],
    ['known-deposit-tx', 'seen'],
    ['processing', 'seen'],
    ['arriving', 'seen'],
    ['delivered', 'seen'],
    ['refunded', 'closed'],
    ['failed', 'closed'],
    ['expired', 'closed']
  ])('puts %s in the %s stage', (phase, stage) => {
    expect(nearDepositStageOf(phase)).toBe(stage);
  });
});

describe('nearDepositHomeStateOf', () => {
  it.each<[IOneClickPhase, number, 'waiting' | 'received' | null]>([
    ['depositing', DEADLINE - 1, 'waiting'],
    ['pending-deposit', DEADLINE - 1, 'waiting'],
    ['incomplete-deposit', DEADLINE - 1, 'waiting'],
    ['depositing', DEADLINE, null],
    ['incomplete-deposit', DEADLINE + 1, null],
    ['known-deposit-tx', DEADLINE + 1, 'received'],
    ['processing', DEADLINE + 1, 'received'],
    ['arriving', DEADLINE - 1, null],
    ['delivered', DEADLINE - 1, null],
    ['refunded', DEADLINE - 1, null],
    ['failed', DEADLINE - 1, null],
    ['expired', DEADLINE - 1, null]
  ])('shows %s at %i as %s', (phase, now, state) => {
    expect(nearDepositHomeStateOf(nearTrackingFixture({ phase }), now)).toBe(state);
  });

  it('shows no waiting row without a valid deadline', () => {
    expect(nearDepositHomeStateOf(nearTrackingFixture({ fundingDeadline: 'never' }), 0)).toBeNull();
  });
});

describe('readNearDeposits', () => {
  it('reads the deposits into Miden of the account, newest first, without restored or foreign rows', async () => {
    mockRows = [
      nearRowFixture(nearTrackingFixture(), { id: 'older', initiatedAt: 100 }),
      nearRowFixture(nearTrackingFixture(), { id: 'newer', initiatedAt: 200 }),
      nearRowFixture(nearTrackingFixture(), { id: 'restored', initiatedAt: 300, restoredFromBackup: true }),
      nearRowFixture(nearTrackingFixture(), { id: 'other-account', initiatedAt: 300, accountId: 'mm1other' }),
      nearRowFixture(nearTrackingFixture({ direction: 'miden-to-evm' }), { id: 'send', initiatedAt: 300 }),
      nearRowFixture(undefined, { id: 'epoch', initiatedAt: 300 }),
      nearRowFixture(nearTrackingFixture(), { id: 'swap', initiatedAt: 300, type: 'swap' })
    ];
    const deposits = await readNearDeposits('mm1account');
    expect(mockWhere).toHaveBeenCalledWith('type');
    expect(deposits.map(deposit => [deposit.id, deposit.startedAt])).toEqual([
      ['newer', 200_000],
      ['older', 100_000]
    ]);
  });
});

describe('useNearDeposits', () => {
  it('follows the rows of the account while enabled and keeps the last answer when off', async () => {
    mockRows = [nearRowFixture(nearTrackingFixture())];
    const { result, rerender } = renderHook(({ enabled }) => useNearDeposits('mm1account', enabled), {
      initialProps: { enabled: true }
    });
    await waitFor(() => expect(result.current.map(deposit => deposit.id)).toEqual(['row-1']));
    rerender({ enabled: false });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current).toHaveLength(1);
  });

  it('reads nothing while off or with no account', () => {
    renderHook(() => useNearDeposits('mm1account', false));
    const { result } = renderHook(() => useNearDeposits(undefined, true));
    expect(result.current).toEqual([]);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('keeps the last answer when a read fails', async () => {
    mockFailRead = true;
    const { result } = renderHook(() => useNearDeposits('mm1account', true));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});

describe('useNowAtDeadlines', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(DEADLINE - 10_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves the time on when the next deadline passes, with one timer', () => {
    const { result } = renderHook(() => useNowAtDeadlines([Number.NaN, DEADLINE + 50_000, DEADLINE]));
    expect(result.current).toBe(DEADLINE - 10_000);
    expect(jest.getTimerCount()).toBe(1);
    act(() => {
      jest.advanceTimersByTime(10_001);
    });
    expect(result.current).toBeGreaterThan(DEADLINE);
    act(() => {
      jest.advanceTimersByTime(50_000);
    });
    expect(result.current).toBeGreaterThan(DEADLINE + 50_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sets no timer without a deadline to come', () => {
    renderHook(() => useNowAtDeadlines([DEADLINE - 20_000]));
    expect(jest.getTimerCount()).toBe(0);
  });
});
