import { updateTransactionStatus } from './helper';
import {
  TERMINAL_STATUS_WRITE_ATTEMPTS,
  TERMINAL_STATUS_WRITE_BACKOFF_MS,
  writeCommittedCompleted
} from './terminal-write';
import { ITransaction, ITransactionStatus } from '../db/types';

const rows: ITransaction[] = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((query: { id: string }) => ({
      first: jest.fn(async () => {
        const row = rows.find(r => r.id === query.id);
        return row && { ...row };
      })
    }))
  }
}));

jest.mock('./helper', () => ({ updateTransactionStatus: jest.fn(async () => {}) }));

const mockUpdate = updateTransactionStatus as jest.MockedFunction<typeof updateTransactionStatus>;

const storeRow = (status: ITransactionStatus, extra: Partial<ITransaction> = {}) => {
  rows.push({ id: 'row-1', type: 'replace-hot-key', status, ...extra } as ITransaction);
};

/** Drives the spaced attempts under fake timers, so an exhausted budget costs no real backoff. */
const runToEnd = async <T>(write: Promise<T>): Promise<T> => {
  await jest.advanceTimersByTimeAsync(TERMINAL_STATUS_WRITE_BACKOFF_MS * TERMINAL_STATUS_WRITE_ATTEMPTS ** 2);
  return write;
};

describe('writeCommittedCompleted', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue(undefined);
    rows.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stops at the first write that lands and returns the row it read', async () => {
    storeRow(ITransactionStatus.GeneratingTransaction);
    mockUpdate.mockRejectedValueOnce(new Error('IndexedDB transaction aborted'));

    const written = await runToEnd(writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test'));

    expect(written).toMatchObject({ id: 'row-1', status: ITransactionStatus.GeneratingTransaction });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    for (const call of mockUpdate.mock.calls) {
      expect(call).toEqual(['row-1', ITransactionStatus.Completed, { displayMessage: 'Done' }]);
    }
    expect(console.warn).toHaveBeenCalledWith(
      `Could not record the completed status for the test row (attempt 1/${TERMINAL_STATUS_WRITE_ATTEMPTS}):`,
      expect.any(Error)
    );
  });

  it('spaces the attempts rather than retrying at once', async () => {
    storeRow(ITransactionStatus.GeneratingTransaction);
    mockUpdate.mockRejectedValueOnce(new Error('IndexedDB transaction aborted'));

    const write = writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test');
    await jest.advanceTimersByTimeAsync(TERMINAL_STATUS_WRITE_BACKOFF_MS - 1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(write).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Completed', ITransactionStatus.Completed],
    ['Failed', ITransactionStatus.Failed],
    ['Unconfirmed', ITransactionStatus.Unconfirmed]
  ])('leaves a row already %s unwritten', async (_label, status) => {
    storeRow(status);

    await expect(runToEnd(writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test'))).resolves.toBe(
      undefined
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('writes nothing for a missing row', async () => {
    await expect(runToEnd(writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test'))).resolves.toBe(
      undefined
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('stops retrying once another writer finalized the row between attempts', async () => {
    storeRow(ITransactionStatus.GeneratingTransaction);
    mockUpdate.mockImplementationOnce(async () => {
      rows[0]!.status = ITransactionStatus.Failed;
      throw new Error('Transaction already in a finalized state');
    });

    await expect(runToEnd(writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test'))).resolves.toBe(
      undefined
    );
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('resolves undefined after the whole budget without rejecting', async () => {
    storeRow(ITransactionStatus.GeneratingTransaction);
    mockUpdate.mockRejectedValue(new Error('IndexedDB transaction aborted'));

    await expect(runToEnd(writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test'))).resolves.toBe(
      undefined
    );
    expect(mockUpdate).toHaveBeenCalledTimes(TERMINAL_STATUS_WRITE_ATTEMPTS);
  });

  it('retries a row read that fails like a write that fails', async () => {
    storeRow(ITransactionStatus.GeneratingTransaction);
    const repo = jest.requireMock('lib/miden/repo') as { transactions: { where: jest.Mock } };
    repo.transactions.where.mockImplementationOnce(() => ({
      first: async () => {
        throw new Error('IndexedDB transaction aborted');
      }
    }));

    await expect(runToEnd(writeCommittedCompleted('row-1', { displayMessage: 'Done' }, 'test'))).resolves.toBeDefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("derives a payload function from each attempt's own read", async () => {
    storeRow(ITransactionStatus.GeneratingTransaction, { displayMessage: 'first read' });
    mockUpdate.mockImplementationOnce(async () => {
      rows[0]!.displayMessage = 'second read';
      throw new Error('IndexedDB transaction aborted');
    });
    const reads: ITransaction[] = [];

    const written = await runToEnd(
      writeCommittedCompleted(
        'row-1',
        row => {
          reads.push(row);
          return { displayMessage: `${row.displayMessage} done` };
        },
        'test'
      )
    );

    expect(written).toMatchObject({ displayMessage: 'second read' });
    expect(reads).toHaveLength(2);
    expect(mockUpdate.mock.calls.map(call => call[2])).toEqual([
      { displayMessage: 'first read done' },
      { displayMessage: 'second read done' }
    ]);
  });
});
