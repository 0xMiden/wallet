import { isRequeueableTransaction, requeueFailedTransaction } from './retry';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockTransactionsWhere = jest.fn();

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { where: mockTransactionsWhere };
  }
}));

/** In-memory row + Dexie-shaped where().first()/where().modify() plumbing. */
function wireRow(row: ITransaction | undefined) {
  mockTransactionsWhere.mockImplementation(() => ({
    first: jest.fn().mockResolvedValue(row),
    modify: jest.fn((fn: (tx: ITransaction) => void) => {
      if (row) fn(row);
      return Promise.resolve(row ? 1 : 0);
    })
  }));
}

function failedRow(overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id: 'tx-1',
    type: 'send',
    accountId: 'acct-1',
    status: ITransactionStatus.Failed,
    initiatedAt: 1000,
    processingStartedAt: 1100,
    completedAt: 1200,
    stage: 'sending',
    nextEligibleAt: 99_999,
    error: 'Something broke',
    rawError: 'Error: something broke',
    displayMessage: 'Failed',
    displayIcon: 'FAILED',
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isRequeueableTransaction', () => {
  it('accepts failed rows of re-queueable types only', () => {
    for (const type of ['send', 'consume', 'swap', 'bridged-send', 'execute'] as const) {
      expect(isRequeueableTransaction({ status: ITransactionStatus.Failed, type })).toBe(true);
    }
    for (const type of ['switch-guardian', 'replace-hot-key', 'update-procedure-threshold'] as const) {
      expect(isRequeueableTransaction({ status: ITransactionStatus.Failed, type })).toBe(false);
    }
  });

  it('rejects non-failed rows regardless of type', () => {
    expect(isRequeueableTransaction({ status: ITransactionStatus.Completed, type: 'send' })).toBe(false);
    expect(isRequeueableTransaction({ status: ITransactionStatus.Queued, type: 'send' })).toBe(false);
    expect(isRequeueableTransaction({ status: undefined, type: 'send' })).toBe(false);
  });
});

describe('requeueFailedTransaction', () => {
  it('resets the row to Queued and clears every failure/backoff field', async () => {
    const row = failedRow();
    wireRow(row);
    const before = Math.floor(Date.now() / 1000);

    await requeueFailedTransaction('tx-1');

    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.initiatedAt).toBeGreaterThanOrEqual(before);
    expect(row.processingStartedAt).toBeUndefined();
    expect(row.completedAt).toBeUndefined();
    expect(row.stage).toBeUndefined();
    // Stale requeue-backoff must not delay an explicit user retry.
    expect(row.nextEligibleAt).toBeUndefined();
    expect(row.error).toBeUndefined();
    expect(row.rawError).toBeUndefined();
    expect(row.displayMessage).toBeUndefined();
    expect(row.displayIcon).toBe('SEND');
  });

  it('restores the pre-failure display icon per type', async () => {
    const cases: Array<[ITransaction['type'], ITransaction['displayIcon']]> = [
      ['consume', 'RECEIVE'],
      ['swap', 'SWAP'],
      ['bridged-send', 'SEND'],
      ['execute', 'DEFAULT']
    ];
    for (const [type, icon] of cases) {
      const row = failedRow({ type });
      wireRow(row);
      // eslint-disable-next-line no-await-in-loop
      await requeueFailedTransaction('tx-1');
      expect(row.displayIcon).toBe(icon);
    }
  });

  it('throws for a missing row', async () => {
    wireRow(undefined);
    await expect(requeueFailedTransaction('gone')).rejects.toThrow('not found');
  });

  it('throws for a non-retryable type and leaves the row untouched', async () => {
    const row = failedRow({ type: 'replace-hot-key' });
    wireRow(row);
    await expect(requeueFailedTransaction('tx-1')).rejects.toThrow('not retryable');
    expect(row.status).toBe(ITransactionStatus.Failed);
  });

  it('throws for a completed row (never downgrades a landed tx)', async () => {
    const row = failedRow({ status: ITransactionStatus.Completed });
    wireRow(row);
    await expect(requeueFailedTransaction('tx-1')).rejects.toThrow('not retryable');
    expect(row.status).toBe(ITransactionStatus.Completed);
  });
});
