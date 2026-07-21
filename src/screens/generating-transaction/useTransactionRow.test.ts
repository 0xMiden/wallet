/**
 * Unit tests for `useTransactionRow`.
 *
 * The hook subscribes to a single Dexie transaction row via `liveQuery`. We
 * mock both `dexie` (to capture the observer/query fn and control when
 * next/error fire) and `lib/miden/repo` (so the query never touches a real
 * IndexedDB), then drive every branch:
 *   - the initial `{ row: undefined, loaded: false }` state,
 *   - the query arrow `() => Repo.transactions.where({ id }).first()`,
 *   - `next` with a row, with `null`, and with `undefined` (the `?? undefined`),
 *   - the `error` callback,
 *   - cleanup (`unsubscribe`) on unmount and on `txId` change.
 */

import { act, renderHook } from '@testing-library/react';
import { liveQuery } from 'dexie'; // eslint-disable-line import/order
import * as Repo from 'lib/miden/repo'; // eslint-disable-line import/order

import { useTransactionRow } from './useTransactionRow';

// Shared mock state lives on globalThis so the hoisted `jest.mock` factories
// (which cannot close over ordinary module-scope variables) can reach it at
// call time. Same convention as the sibling transaction liveQuery tests.
const _g = globalThis as any;
_g.__txRowTest = {
  observers: [] as Array<{ next: (v: unknown) => void; error: (e: unknown) => void }>,
  unsubscribes: [] as jest.Mock[],
  queryFns: [] as Array<() => unknown>
};

jest.mock('dexie', () => ({
  liveQuery: jest.fn((queryFn: () => unknown) => {
    const s = (globalThis as any).__txRowTest;
    s.queryFns.push(queryFn);
    return {
      subscribe: (observer: { next: (v: unknown) => void; error: (e: unknown) => void }) => {
        s.observers.push(observer);
        const unsubscribe = jest.fn();
        s.unsubscribes.push(unsubscribe);
        return { unsubscribe };
      }
    };
  })
}));

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((query: { id: string }) => ({
      first: jest.fn(async () => (globalThis as any).__txRowTest.rowById?.[query.id])
    }))
  }
})); // eslint-disable-line import/order

const state = _g.__txRowTest as {
  observers: Array<{ next: (v: unknown) => void; error: (e: unknown) => void }>;
  unsubscribes: jest.Mock[];
  queryFns: Array<() => unknown>;
  rowById?: Record<string, unknown>;
};

/** Latest observer captured by the mocked `liveQuery().subscribe(...)`. */
const lastObserver = () => state.observers[state.observers.length - 1]!;

beforeEach(() => {
  jest.clearAllMocks();
  state.observers.length = 0;
  state.unsubscribes.length = 0;
  state.queryFns.length = 0;
  state.rowById = {};
});

describe('useTransactionRow', () => {
  it('starts in the un-loaded state before any liveQuery result arrives', () => {
    const { result } = renderHook(() => useTransactionRow('tx-1'));

    expect(result.current).toEqual({ row: undefined, loaded: false });
    // The effect ran: exactly one subscription was created.
    expect(liveQuery).toHaveBeenCalledTimes(1);
    expect(state.observers).toHaveLength(1);
  });

  it('passes a query fn that reads the row by id from the repo', async () => {
    const row = { id: 'tx-1', status: 'Queued' };
    state.rowById = { 'tx-1': row };

    renderHook(() => useTransactionRow('tx-1'));

    // Invoke the captured query arrow the way Dexie would, and assert it
    // targets the right row. This covers the `() => Repo.transactions...` line.
    const queried = await state.queryFns[0]!();

    expect(Repo.transactions.where).toHaveBeenCalledWith({ id: 'tx-1' });
    expect(queried).toBe(row);
  });

  it('exposes the row and marks loaded once next() delivers a row', () => {
    const row = { id: 'tx-1', status: 'Completed' };
    const { result } = renderHook(() => useTransactionRow('tx-1'));

    act(() => lastObserver().next(row));

    expect(result.current).toEqual({ row, loaded: true });
  });

  it('coerces a null row to undefined but still marks loaded (?? undefined)', () => {
    const { result } = renderHook(() => useTransactionRow('tx-1'));

    act(() => lastObserver().next(null));

    expect(result.current).toEqual({ row: undefined, loaded: true });
  });

  it('treats an undefined row (unknown id) as loaded with no row', () => {
    const { result } = renderHook(() => useTransactionRow('tx-missing'));

    act(() => lastObserver().next(undefined));

    expect(result.current).toEqual({ row: undefined, loaded: true });
  });

  it('marks loaded with no row when the subscription errors', () => {
    const { result } = renderHook(() => useTransactionRow('tx-1'));

    act(() => lastObserver().error(new Error('dexie boom')));

    expect(result.current).toEqual({ row: undefined, loaded: true });
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useTransactionRow('tx-1'));
    const unsubscribe = state.unsubscribes[0];
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resets state and re-subscribes when txId changes', () => {
    const firstRow = { id: 'tx-1', status: 'Completed' };
    const { result, rerender } = renderHook(({ id }) => useTransactionRow(id), {
      initialProps: { id: 'tx-1' }
    });

    // Deliver a result for the first id.
    act(() => lastObserver().next(firstRow));
    expect(result.current).toEqual({ row: firstRow, loaded: true });

    const firstUnsubscribe = state.unsubscribes[0];

    // Change the id: effect cleanup unsubscribes the old query, state resets to
    // un-loaded, and a brand-new subscription is created for the new id.
    rerender({ id: 'tx-2' });

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ row: undefined, loaded: false });
    expect(liveQuery).toHaveBeenCalledTimes(2);
    expect(state.observers).toHaveLength(2);

    // The new subscription drives the row independently.
    const secondRow = { id: 'tx-2', status: 'GeneratingTransaction' };
    act(() => lastObserver().next(secondRow));
    expect(result.current).toEqual({ row: secondRow, loaded: true });
  });
});
