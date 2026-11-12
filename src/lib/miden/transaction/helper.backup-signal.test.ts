import * as Repo from 'lib/miden/repo';

import { updateTransactionStatus } from './helper';
import { ITransaction, ITransactionStatus } from '../db/types';

// The backup signal is the boundary: a Completed row of this device asks for a history upload at once.
const mockSignalTransactionCompleted = jest.fn<void, []>();
jest.mock('lib/backup/adopt-signal', () => ({
  signalTransactionCompleted: () => mockSignalTransactionCompleted()
}));

const generating = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'acct',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 1000,
  processingStartedAt: 1100,
  attemptId: 'a1',
  displayIcon: 'SEND',
  ...overrides
});

beforeEach(async () => {
  await Repo.transactions.clear();
  mockSignalTransactionCompleted.mockReset();
});

describe('updateTransactionStatus signals the encrypted backup', () => {
  it('signals once when a row of this device reaches Completed', async () => {
    await Repo.transactions.put(generating());

    await updateTransactionStatus('tx-1', ITransactionStatus.Completed, {});

    expect(mockSignalTransactionCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not signal for a row restored from the backup: it is a peer row', async () => {
    await Repo.transactions.put(generating({ restoredFromBackup: true }));

    await updateTransactionStatus('tx-1', ITransactionStatus.Completed, {});

    expect(mockSignalTransactionCompleted).not.toHaveBeenCalled();
  });

  it.each([ITransactionStatus.Failed, ITransactionStatus.Unconfirmed, ITransactionStatus.GeneratingTransaction])(
    'does not signal for status %s',
    async status => {
      await Repo.transactions.put(generating({ status: ITransactionStatus.Queued }));

      await updateTransactionStatus('tx-1', status, {});

      expect(mockSignalTransactionCompleted).not.toHaveBeenCalled();
    }
  );

  it('does not signal when the row already left the queue and the write is refused', async () => {
    await Repo.transactions.put(generating({ status: ITransactionStatus.Failed }));

    await expect(updateTransactionStatus('tx-1', ITransactionStatus.Completed, {})).rejects.toThrow(
      'Transaction already in a finalized state'
    );

    expect(mockSignalTransactionCompleted).not.toHaveBeenCalled();
  });
});
