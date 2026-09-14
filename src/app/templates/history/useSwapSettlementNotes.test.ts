import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { liveQuery } from 'dexie';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';

import { useSwapSettlementNotes } from './useSwapSettlementNotes';

jest.mock('lib/miden/activity', () => {
  const actual = jest.requireActual<typeof import('lib/miden/transaction/get')>('lib/miden/transaction/get');
  return { getSwapSettlementNotes: jest.fn(actual.getSwapSettlementNotes) };
});
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ PswapLineageState: {} }));

const mockGetSwapSettlementNotes = jest.mocked(
  jest.requireMock<typeof import('lib/miden/transaction/get')>('lib/miden/activity').getSwapSettlementNotes
);

const emptyNotes = {
  settled: [],
  reclaimed: [],
  settledTransactions: [],
  reclaimedTransactions: []
};

function consume(id: string, swapOrderTxId: string, overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id,
    type: 'consume',
    accountId: 'account-1',
    initiatedAt: 100,
    completedAt: 200,
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    noteIds: [`note-${id}`],
    amount: 42n,
    faucetId: 'faucet-1',
    transactionId: `chain-${id}`,
    extraInputs: { swapOrderTxId, swapSettleKind: 'settle' },
    ...overrides
  };
}

async function mutateAndObserve(mutate: () => Promise<unknown>, expectedCount: number) {
  let observedCount: number | undefined;
  const subscription = liveQuery(() => transactions.count()).subscribe(count => {
    observedCount = count;
  });
  try {
    await waitFor(() => expect(observedCount).toBeDefined());
    await act(async () => {
      await mutate();
    });
    await waitFor(() => expect(observedCount).toBe(expectedCount));
  } finally {
    subscription.unsubscribe();
  }
}

beforeEach(async () => {
  await transactions.clear();
});

afterEach(async () => {
  cleanup();
  jest.restoreAllMocks();
  await transactions.clear();
});

describe('useSwapSettlementNotes', () => {
  it('starts empty, then receives a completed linked consume inserted after mount', async () => {
    const { result } = renderHook(() => useSwapSettlementNotes('swap-1'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual(emptyNotes));

    await act(async () => {
      await transactions.bulkAdd([consume('first', 'swap-1'), consume('unrelated', 'swap-2')]);
    });

    await waitFor(() =>
      expect(result.current).toEqual({
        settled: ['note-first'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'first',
            transactionId: 'chain-first',
            noteIds: ['note-first'],
            amount: 42n,
            faucetId: 'faucet-1',
            completedAt: 200
          }
        ],
        reclaimedTransactions: []
      })
    );
  });

  it('does not recompute when a different swap receives a settlement row', async () => {
    const { result } = renderHook(() => useSwapSettlementNotes('swap-1'));
    await waitFor(() => expect(result.current).toEqual(emptyNotes));
    mockGetSwapSettlementNotes.mockClear();

    await act(async () => {
      await transactions.add(consume('unrelated', 'swap-2'));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(mockGetSwapSettlementNotes).not.toHaveBeenCalled();
  });

  it('adds a reclaim when its existing consume becomes completed', async () => {
    await transactions.add(
      consume('reclaim', 'swap-1', {
        status: ITransactionStatus.Queued,
        extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'reclaim' }
      })
    );
    const { result } = renderHook(() => useSwapSettlementNotes('swap-1'));
    await waitFor(() => expect(result.current).toEqual(emptyNotes));

    await act(async () => {
      await transactions.update('reclaim', { status: ITransactionStatus.Completed });
    });

    await waitFor(() => expect(result.current?.reclaimed).toEqual(['note-reclaim']));
    expect(result.current?.settled).toEqual([]);
    expect(result.current?.reclaimedTransactions[0]).toMatchObject({ id: 'reclaim', amount: 42n });
  });

  it('clears the previous order before subscribing to a different order', async () => {
    await transactions.bulkAdd([consume('first', 'swap-1'), consume('second', 'swap-2')]);
    const { result, rerender } = renderHook(({ id }) => useSwapSettlementNotes(id), {
      initialProps: { id: 'swap-1' }
    });
    await waitFor(() => expect(result.current?.settled).toEqual(['note-first']));

    rerender({ id: 'swap-2' });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.settled).toEqual(['note-second']));

    await mutateAndObserve(() => transactions.add(consume('late-first', 'swap-1')), 3);
    expect(result.current?.settled).toEqual(['note-second']);
  });

  it('clears notes and stops reading when the order id becomes undefined', async () => {
    await transactions.add(consume('first', 'swap-1'));
    const initialProps: { id: string | undefined } = { id: 'swap-1' };
    const { result, rerender } = renderHook(({ id }) => useSwapSettlementNotes(id), { initialProps });
    await waitFor(() => expect(result.current?.settled).toEqual(['note-first']));

    const read = jest.spyOn(transactions, 'where');
    rerender({ id: undefined });
    expect(result.current).toBeNull();
    await mutateAndObserve(() => transactions.add(consume('late', 'swap-1')), 2);
    expect(result.current).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not subscribe when mounted without an order id', async () => {
    const read = jest.spyOn(transactions, 'where');
    const { result } = renderHook(() => useSwapSettlementNotes(undefined));

    await mutateAndObserve(() => transactions.add(consume('first', 'swap-1')), 1);
    expect(result.current).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('stops reading settlement rows after unmount', async () => {
    const { result, unmount } = renderHook(() => useSwapSettlementNotes('swap-1'));
    await waitFor(() => expect(result.current).toEqual(emptyNotes));
    const read = jest.spyOn(transactions, 'where');

    unmount();
    await mutateAndObserve(() => transactions.add(consume('late', 'swap-1')), 1);

    expect(read).not.toHaveBeenCalled();
  });

  it('reports a failed database read without publishing settlement notes', async () => {
    const error = new Error('Database read failed');
    jest.spyOn(transactions, 'where').mockImplementationOnce(() => {
      throw error;
    });
    const logError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useSwapSettlementNotes('swap-1'));

    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith('[HistoryDetails] Failed to read swap settlement notes:', error)
    );
    expect(result.current).toBeNull();
  });
});
