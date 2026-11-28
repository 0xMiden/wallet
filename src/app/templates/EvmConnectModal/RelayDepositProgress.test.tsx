import { act, renderHook } from '@testing-library/react';

import type { RelayJobRef } from 'lib/evm-relay/types';
import type { ITransaction } from 'lib/miden/db/types';

import { hasOpenRelayJob, relayDepositProgressOf, useOpenRelayJob } from './RelayDepositProgress';

const JOB: RelayJobRef = { chainId: 1, id: `0x${'ab'.repeat(32)}`, deadline: 1 };

let mockNext: ((row: ITransaction | undefined) => void) | undefined;
let mockError: ((error: unknown) => void) | undefined;
const mockUnsubscribe = jest.fn();
jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (
    _query: unknown,
    observer: { next: (row: ITransaction | undefined) => void; error: (error: unknown) => void }
  ) => {
    mockNext = observer.next;
    mockError = observer.error;
    return mockUnsubscribe;
  }
}));

/** A row as the read gives it: only `extraInputs` matters here. */
const rowWith = (extraInputs: Record<string, unknown>): ITransaction => {
  const row: ITransaction = Object.create(null);
  return Object.assign(row, { id: 'tx', extraInputs });
};

describe('relayDepositProgressOf', () => {
  it.each([
    [undefined, { kind: 'processing', step: 0 }],
    ['submitting', { kind: 'processing', step: 1 }],
    ['delivering', { kind: 'processing', step: 1 }],
    ['ready', { kind: 'processing', step: 2 }],
    ['received', { kind: 'success' }],
    ['failed', { kind: 'failed' }]
  ] satisfies [Parameters<typeof relayDepositProgressOf>[0], ReturnType<typeof relayDepositProgressOf>][])(
    'reads %s',
    (phase, expected) => {
      expect(relayDepositProgressOf(phase)).toEqual(expected);
    }
  );
});

describe('hasOpenRelayJob', () => {
  it('is true only for a relay job in a phase that is not final', () => {
    expect(hasOpenRelayJob({ phase: 'submitting', relayJob: JOB })).toBe(true);
    expect(hasOpenRelayJob({ phase: 'delivering', relayJob: JOB })).toBe(true);
    expect(hasOpenRelayJob({ phase: 'failed', relayJob: JOB })).toBe(false);
    expect(hasOpenRelayJob({ phase: 'received', relayJob: JOB })).toBe(false);
    expect(hasOpenRelayJob({ phase: 'submitting' })).toBe(false);
  });
});

describe('useOpenRelayJob', () => {
  beforeEach(() => {
    mockNext = undefined;
    mockError = undefined;
    jest.clearAllMocks();
  });

  it('reads nothing without a row id', () => {
    const { result } = renderHook(() => useOpenRelayJob(null));
    expect(result.current).toBe(false);
    expect(mockNext).toBeUndefined();
  });

  it('follows the row, and keeps the last answer when a read fails', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useOpenRelayJob('tx'));
    act(() => mockNext?.(rowWith({ phase: 'submitting', relayJob: JOB })));
    expect(result.current).toBe(true);
    act(() => mockError?.(new Error('read failed')));
    expect(result.current).toBe(true);
    act(() => mockNext?.(rowWith({ phase: 'failed', relayJob: JOB })));
    expect(result.current).toBe(false);
    act(() => mockNext?.(undefined));
    expect(result.current).toBe(false);
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
