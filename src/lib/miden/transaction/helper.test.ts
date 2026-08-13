import { ITransaction, ITransactionStatus } from '../db/types';

const mockTransactionsWhere = jest.fn();

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { where: mockTransactionsWhere };
  }
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn()
}));

import { updateTransactionStatus } from './helper';

describe('updateTransactionStatus stage handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const arrangeRow = (row: Partial<ITransaction>) => {
    const modify = jest.fn(async (callback: (tx: ITransaction) => void) => {
      callback(row as ITransaction);
    });

    mockTransactionsWhere
      .mockReturnValueOnce({ first: jest.fn().mockResolvedValue(row) })
      .mockReturnValueOnce({ modify });

    return modify;
  };

  it('stamps complete when a transaction completes without an explicit stage', async () => {
    const row = {
      id: 'tx-completed',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'confirming'
    } as Partial<ITransaction>;
    arrangeRow(row);

    await updateTransactionStatus('tx-completed', ITransactionStatus.Completed, { completedAt: 123 });

    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.stage).toBe('complete');
  });

  it('preserves an explicit stage supplied by the completion caller', async () => {
    const row = {
      id: 'tx-explicit-stage',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'confirming'
    } as Partial<ITransaction>;
    arrangeRow(row);

    await updateTransactionStatus('tx-explicit-stage', ITransactionStatus.Completed, {
      stage: 'guardian-synced'
    });

    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.stage).toBe('guardian-synced');
  });

  it('keeps the failure stage for diagnostics', async () => {
    const row = {
      id: 'tx-failed',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'creating-proposal'
    } as Partial<ITransaction>;
    arrangeRow(row);

    await updateTransactionStatus('tx-failed', ITransactionStatus.Failed, { error: 'guardian rejected' });

    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.stage).toBe('creating-proposal');
  });
});
