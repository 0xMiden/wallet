import { updateEarnDepositStatus, updateEarnWithdrawPhase } from './complete';
import { ITransaction, ITransactionStatus } from '../db/types';

let mockRow: ITransaction | undefined;
let mockBeforeModify: (() => void) | undefined;
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: () => ({
      modify: async (mutate: (row: ITransaction) => void) => {
        mockBeforeModify?.();
        if (mockRow) mutate(mockRow);
        return mockRow ? 1 : 0;
      }
    })
  }
}));

const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const deposit = (): ITransaction => ({
  id: 'deposit',
  type: 'earn-deposit',
  accountId: 'account',
  initiatedAt: 1,
  status: ITransactionStatus.Completed,
  displayIcon: 'DEFAULT',
  amount: 10n,
  extraInputs: {
    evmRecipient: OWNER,
    intentNonce: '7',
    epochStatus: 'pending',
    marketUid: 'market',
    sourceFaucetId: 'faucet'
  }
});
const withdrawal = (): ITransaction => ({
  id: 'withdrawal',
  type: 'earn-withdraw',
  accountId: 'account',
  initiatedAt: 1,
  status: ITransactionStatus.Completed,
  displayIcon: 'DEFAULT',
  amount: 10n,
  extraInputs: {
    evmOwner: OWNER,
    withdrawIntentNonce: '7',
    submissionAttemptId: 'attempt-1',
    phase: 'redeeming',
    marketUid: 'market',
    destinationFaucetId: 'faucet',
    sourceAmount: '10',
    sourceSymbol: 'USDC'
  }
});

beforeEach(() => {
  mockRow = undefined;
  mockBeforeModify = undefined;
});

it.each(['terminal', 'restored', 'status', 'type', 'owner', 'nonce', 'deleted'])(
  'rejects a deposit %s change at the atomic writer boundary',
  async change => {
    mockRow = deposit();
    mockBeforeModify = () => {
      if (!mockRow) throw new Error('missing fixture');
      if (change === 'terminal') mockRow.extraInputs.epochStatus = 'failed';
      if (change === 'restored') mockRow.restoredFromBackup = true;
      if (change === 'status') mockRow.status = ITransactionStatus.Failed;
      if (change === 'type') mockRow.type = 'consume';
      if (change === 'owner') mockRow.extraInputs.evmRecipient = 'another-owner';
      if (change === 'nonce') mockRow.extraInputs.intentNonce = '8';
      if (change === 'deleted') mockRow = undefined;
    };
    await updateEarnDepositStatus('deposit', 'confirmed', { outputAmount: '99' }, { owner: OWNER, nonce: '7' });
    expect(mockRow?.extraInputs.outputAmount).toBeUndefined();
    expect(mockRow?.extraInputs.epochStatus).not.toBe('confirmed');
  }
);

it('applies a current deposit response under the atomic guard', async () => {
  mockRow = deposit();
  await updateEarnDepositStatus(
    'deposit',
    'confirmed',
    { outputAmount: '99' },
    { owner: OWNER.toUpperCase(), nonce: '7' }
  );
  expect(mockRow.extraInputs).toEqual(expect.objectContaining({ epochStatus: 'confirmed', outputAmount: '99' }));
});

it.each(['attempt', 'owner', 'nonce', 'restored', 'status', 'type'])(
  'rejects a withdrawal %s change at the atomic writer boundary',
  async change => {
    mockRow = withdrawal();
    mockBeforeModify = () => {
      if (!mockRow) throw new Error('missing fixture');
      if (change === 'attempt') {
        mockRow.extraInputs.submissionAttemptId = 'attempt-2';
        mockRow.extraInputs.withdrawIntentNonce = undefined;
      }
      if (change === 'owner') mockRow.extraInputs.evmOwner = 'another-owner';
      if (change === 'nonce') mockRow.extraInputs.withdrawIntentNonce = '8';
      if (change === 'restored') mockRow.restoredFromBackup = true;
      if (change === 'status') mockRow.status = ITransactionStatus.Failed;
      if (change === 'type') mockRow.type = 'consume';
    };
    await updateEarnWithdrawPhase('withdrawal', 'received', { midenNoteId: 'late' }, 99n, {
      owner: OWNER,
      nonce: '7',
      attemptId: 'attempt-1'
    });
    expect(mockRow.extraInputs.phase).toBe('redeeming');
    expect(mockRow.extraInputs.midenNoteId).toBeUndefined();
    expect(mockRow.amount).toBe(10n);
  }
);

it('completes the same verified attempt when its nonce persistence was interrupted', async () => {
  mockRow = withdrawal();
  mockRow.extraInputs.withdrawIntentNonce = undefined;
  await updateEarnWithdrawPhase('withdrawal', 'received', { midenNoteId: 'delivered' }, 99n, {
    owner: OWNER,
    nonce: '7',
    attemptId: 'attempt-1'
  });
  expect(mockRow.extraInputs.phase).toBe('received');
  expect(mockRow.amount).toBe(99n);
});
