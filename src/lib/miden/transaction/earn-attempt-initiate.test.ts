import { initiateEarnWithdrawTransaction } from './initiate';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockAdded: ITransaction[] = [];
jest.mock('lib/miden/repo', () => ({
  transactions: {
    add: async (row: ITransaction) => {
      mockAdded.push(row);
    }
  }
}));

it('persists attempt identity and its clock before exposing the withdrawal row', async () => {
  const id = await initiateEarnWithdrawTransaction(
    'account',
    10n,
    'owner',
    'market',
    'faucet',
    '10',
    'USDC',
    'attempt-1',
    123
  );
  expect(mockAdded).toHaveLength(1);
  expect(mockAdded[0]).toEqual(
    expect.objectContaining({
      id,
      status: ITransactionStatus.Completed,
      extraInputs: expect.objectContaining({
        submissionState: 'preparing',
        submissionAttemptId: 'attempt-1',
        attemptStartedAt: 123
      })
    })
  );
});

it('records the source decimals a retry falls back on', async () => {
  mockAdded.length = 0;
  await initiateEarnWithdrawTransaction('account', 10n, 'owner', 'market', 'faucet', '10', 'USDC', 'attempt-1', 123, 6);
  expect(mockAdded[0]?.extraInputs).toEqual(expect.objectContaining({ sourceDecimals: 6 }));
});
