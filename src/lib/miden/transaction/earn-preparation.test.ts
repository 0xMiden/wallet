import type { ExpectedEarnWithdrawIntent } from 'lib/epoch/intent-key';
import {
  preparedExecution,
  PREPARED_FAUCET,
  PREPARED_OWNER,
  PREPARED_RECIPIENT
} from 'lib/epoch/testing/earn-prepared';

import { markEarnWithdrawAccepted, markEarnWithdrawNotSent, prepareEarnWithdrawExecution } from './complete';
import { IEarnWithdrawPreparedExecution, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk'),
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('invalid account');
      return { toString: () => value };
    }
  }
}));
jest.mock('lib/epoch/bridge', () => ({ normalizeMidenIdToHex: (value: string) => value }));

let mockRow: ITransaction | undefined;
let mockBeforeModify: (() => void) | undefined;
let mockError: Error | undefined;
let mockSkipModify = false;
let current = true;
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: ({ id }: { id: string }) => ({
      modify: async (mutate: (row: ITransaction) => void) => {
        mockBeforeModify?.();
        if (mockError) throw mockError;
        if (!mockRow || mockRow.id !== id || mockSkipModify) return 0;
        mutate(mockRow);
        return 1;
      }
    })
  }
}));

const expected: ExpectedEarnWithdrawIntent = { owner: PREPARED_OWNER, attemptId: 'attempt-1', nonce: '22' };
const isCurrent = () => current;
function execution(): IEarnWithdrawPreparedExecution {
  return {
    ...preparedExecution(),
    attemptId: 'attempt-1',
    delivery: {
      allocationIndex: 1,
      owner: PREPARED_OWNER,
      nonce: '22',
      destinationChainId: 999999999,
      recipientAccountId: PREPARED_RECIPIENT,
      destinationFaucetId: PREPARED_FAUCET
    }
  };
}
function row(): ITransaction {
  return {
    id: 'withdrawal',
    type: 'earn-withdraw',
    accountId: PREPARED_RECIPIENT,
    amount: 10n,
    faucetId: PREPARED_FAUCET,
    status: ITransactionStatus.Completed,
    initiatedAt: 100,
    completedAt: 100,
    displayIcon: 'DEFAULT',
    extraInputs: {
      evmOwner: PREPARED_OWNER,
      marketUid: 'DUMMY_LENDING:11155111:token',
      destinationFaucetId: PREPARED_FAUCET,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      phase: 'redeeming',
      submissionState: 'preparing',
      submissionAttemptId: 'attempt-1',
      attemptStartedAt: 200
    }
  };
}
function preparedRow(): ITransaction {
  const result = row();
  result.extraInputs.submissionState = 'prepared';
  result.extraInputs.preparedExecution = execution();
  result.extraInputs.withdrawIntentNonce = '22';
  return result;
}
function requireRow(): ITransaction {
  if (!mockRow) throw new Error('missing fixture');
  return mockRow;
}

beforeEach(() => {
  mockRow = row();
  mockBeforeModify = undefined;
  mockError = undefined;
  mockSkipModify = false;
  current = true;
});

it('persists all allocations and the selected nonce together before source execution', async () => {
  expect(typeof prepareEarnWithdrawExecution).toBe('function');
  await expect(prepareEarnWithdrawExecution('withdrawal', execution(), expected, isCurrent)).resolves.toBe(true);
  expect(mockRow).toMatchObject({
    initiatedAt: 100,
    completedAt: 100,
    extraInputs: {
      phase: 'redeeming',
      attemptStartedAt: 200,
      withdrawIntentNonce: '22',
      submissionState: 'prepared',
      preparedExecution: {
        chainId: 11155111,
        attemptId: 'attempt-1',
        allocations: [expect.objectContaining({ nonce: '11' }), expect.objectContaining({ nonce: '22' })],
        delivery: { allocationIndex: 1, nonce: '22' }
      }
    }
  });
});

it.each(['prepared', 'accepted'])('keeps an identical %s preparation idempotent without a downgrade', async state => {
  mockRow = preparedRow();
  mockRow.extraInputs.submissionState = state;
  mockRow.extraInputs.phase = 'delivering';
  const before = { ...mockRow, extraInputs: { ...mockRow.extraInputs } };
  await expect(prepareEarnWithdrawExecution('withdrawal', execution(), expected, isCurrent)).resolves.toBe(true);
  expect(mockRow).toEqual(before);
});

const changes: ReadonlyArray<[string, (tx: ITransaction) => void]> = [
  [
    'attempt',
    tx => {
      tx.extraInputs.submissionAttemptId = 'attempt-2';
    }
  ],
  [
    'owner',
    tx => {
      tx.extraInputs.evmOwner = '0x2222222222222222222222222222222222222222';
    }
  ],
  [
    'nonce',
    tx => {
      tx.extraInputs.withdrawIntentNonce = '99';
    }
  ],
  [
    'restored',
    tx => {
      tx.restoredFromBackup = true;
    }
  ],
  [
    'status',
    tx => {
      tx.status = ITransactionStatus.Failed;
    }
  ],
  [
    'type',
    tx => {
      tx.type = 'consume';
    }
  ],
  [
    'account',
    tx => {
      tx.accountId = 'invalid-account';
    }
  ],
  [
    'faucet',
    tx => {
      tx.extraInputs.destinationFaucetId = 'invalid-faucet';
    }
  ]
];

it.each(changes)('refuses preparation if %s changes inside the atomic boundary', async (_name, change) => {
  mockBeforeModify = () => change(requireRow());
  await expect(prepareEarnWithdrawExecution('withdrawal', execution(), expected, isCurrent)).resolves.toBe(false);
  expect(mockRow?.extraInputs.preparedExecution).toBeUndefined();
  expect(mockRow?.extraInputs.submissionState).toBe('preparing');
});

it.each(['failed', 'received', 'legacy', 'disposed', 'deleted', 'no-op', 'invalid-payload', 'conflicting-payload'])(
  'does not manufacture a successful preparation for %s',
  async change => {
    const captured = execution();
    if (change === 'failed' || change === 'received') requireRow().extraInputs.phase = change;
    if (change === 'legacy') requireRow().extraInputs.submissionState = undefined;
    if (change === 'disposed')
      mockBeforeModify = () => {
        current = false;
      };
    if (change === 'deleted') mockRow = undefined;
    if (change === 'no-op') mockSkipModify = true;
    if (change === 'invalid-payload') requireRow().extraInputs.preparedExecution = { ...captured, allocations: [] };
    if (change === 'conflicting-payload') {
      mockRow = preparedRow();
      requireRow().extraInputs.preparedExecution = {
        ...captured,
        allocations: captured.allocations.map(allocation => ({
          ...allocation,
          requestJson: allocation.requestJson + ' '
        }))
      };
    }
    await expect(prepareEarnWithdrawExecution('withdrawal', captured, expected, isCurrent)).resolves.toBe(false);
  }
);

it('does not permit an invalid incoming payload even for a matching attempt', async () => {
  await expect(
    prepareEarnWithdrawExecution('withdrawal', { ...execution(), allocations: [] }, expected, isCurrent)
  ).resolves.toBe(false);
  expect(requireRow().extraInputs.withdrawIntentNonce).toBeUndefined();
});

it.each(['preparing', 'prepared'])(
  'clears only proven unsent %s state and preserves its original clocks',
  async state => {
    if (state === 'prepared') mockRow = preparedRow();
    await expect(
      markEarnWithdrawNotSent('withdrawal', 'storage unavailable', expected, execution(), isCurrent)
    ).resolves.toBe(true);
    expect(mockRow).toMatchObject({
      initiatedAt: 100,
      completedAt: 100,
      error: 'storage unavailable',
      extraInputs: {
        phase: 'failed',
        submissionState: 'preparing',
        error: 'storage unavailable',
        attemptStartedAt: 200
      }
    });
    expect(mockRow?.extraInputs.withdrawIntentNonce).toBeUndefined();
    expect(mockRow?.extraInputs.preparedExecution).toBeUndefined();
  }
);

it('marks a setup failure before the callback captured any execution', async () => {
  await expect(
    markEarnWithdrawNotSent('withdrawal', 'setup unavailable', expected, undefined, isCurrent)
  ).resolves.toBe(true);
  expect(requireRow().extraInputs.phase).toBe('failed');
});

it.each(changes)('refuses unsent cleanup if %s changes inside the atomic boundary', async (_name, change) => {
  mockRow = preparedRow();
  mockBeforeModify = () => change(requireRow());
  await expect(markEarnWithdrawNotSent('withdrawal', 'setup error', expected, execution(), isCurrent)).resolves.toBe(
    false
  );
  expect(mockRow?.extraInputs.preparedExecution).toBeDefined();
  expect(mockRow?.error).toBeUndefined();
});

it.each([
  'accepted',
  'delivering',
  'received',
  'hash',
  'note',
  'output',
  'disposed',
  'uncaptured',
  'conflicting-payload',
  'no-op'
])('preserves protected state when unsent cleanup sees %s', async change => {
  mockRow = preparedRow();
  if (change === 'accepted') mockRow.extraInputs.submissionState = 'accepted';
  if (change === 'delivering' || change === 'received') mockRow.extraInputs.phase = change;
  if (change === 'hash') mockRow.extraInputs.evmTxHash = '0xsource';
  if (change === 'note') mockRow.extraInputs.midenNoteId = 'note';
  if (change === 'output') mockRow.extraInputs.outputAmount = '0';
  if (change === 'disposed')
    mockBeforeModify = () => {
      current = false;
    };
  if (change === 'no-op') mockSkipModify = true;
  const captured = change === 'uncaptured' ? undefined : execution();
  if (change === 'conflicting-payload' && captured) {
    mockRow.extraInputs.preparedExecution = { ...captured, delivery: { ...captured.delivery, allocationIndex: 0 } };
  }
  await expect(markEarnWithdrawNotSent('withdrawal', 'setup error', expected, captured, isCurrent)).resolves.toBe(
    false
  );
  expect(mockRow.extraInputs.preparedExecution).toBeDefined();
  expect(mockRow.extraInputs.withdrawIntentNonce).toBe('22');
  expect(mockRow.error).toBeUndefined();
});

it.each(['redeeming', 'delivering', 'received', 'failed'])(
  'marks accepted while preserving a concurrent %s phase',
  async phase => {
    mockRow = preparedRow();
    mockBeforeModify = () => {
      const tx = requireRow();
      tx.extraInputs.phase = phase;
      tx.extraInputs.midenNoteId = 'known-note';
      tx.extraInputs.outputAmount = '12';
      tx.amount = 12n;
    };
    await expect(markEarnWithdrawAccepted('withdrawal', expected, isCurrent)).resolves.toBe(true);
    expect(mockRow).toMatchObject({
      amount: 12n,
      initiatedAt: 100,
      completedAt: 100,
      extraInputs: {
        phase,
        submissionState: 'accepted',
        midenNoteId: 'known-note',
        outputAmount: '12',
        withdrawIntentNonce: '22',
        attemptStartedAt: 200
      }
    });
    await expect(markEarnWithdrawAccepted('withdrawal', expected, isCurrent)).resolves.toBe(true);
  }
);

it.each(changes)('refuses acceptance if %s changes inside the atomic boundary', async (_name, change) => {
  mockRow = preparedRow();
  mockBeforeModify = () => change(requireRow());
  await expect(markEarnWithdrawAccepted('withdrawal', expected, isCurrent)).resolves.toBe(false);
  expect(mockRow?.extraInputs.submissionState).toBe('prepared');
});

it.each(['preparing', 'legacy', 'missing-nonce', 'missing-payload', 'invalid-payload', 'disposed', 'deleted', 'no-op'])(
  'does not claim allocation acceptance with %s',
  async change => {
    mockRow = preparedRow();
    if (change === 'preparing') mockRow.extraInputs.submissionState = 'preparing';
    if (change === 'legacy') mockRow.extraInputs.submissionState = undefined;
    if (change === 'missing-nonce') mockRow.extraInputs.withdrawIntentNonce = undefined;
    if (change === 'missing-payload') mockRow.extraInputs.preparedExecution = undefined;
    if (change === 'invalid-payload') mockRow.extraInputs.preparedExecution = { ...execution(), allocations: [] };
    if (change === 'disposed')
      mockBeforeModify = () => {
        current = false;
      };
    if (change === 'deleted') mockRow = undefined;
    if (change === 'no-op') mockSkipModify = true;
    await expect(markEarnWithdrawAccepted('withdrawal', expected, isCurrent)).resolves.toBe(false);
    expect(mockRow?.extraInputs.submissionState).not.toBe('accepted');
  }
);

it('propagates database failures from every barrier writer without clearing protection', async () => {
  mockRow = preparedRow();
  mockError = new Error('database unavailable');
  await expect(prepareEarnWithdrawExecution('withdrawal', execution(), expected, isCurrent)).rejects.toThrow(mockError);
  await expect(markEarnWithdrawNotSent('withdrawal', 'setup error', expected, execution(), isCurrent)).rejects.toThrow(
    mockError
  );
  await expect(markEarnWithdrawAccepted('withdrawal', expected, isCurrent)).rejects.toThrow(mockError);
  expect(requireRow().extraInputs.submissionState).toBe('prepared');
  expect(requireRow().extraInputs.withdrawIntentNonce).toBe('22');
});
