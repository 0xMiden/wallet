import React from 'react';

import { act, cleanup, render, waitFor } from '@testing-library/react';

import {
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus
} from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';

import { earnWithdrawExecutionIdentity, selectEarnWithdrawPreparedExecution } from './earn-withdraw-policy';
import { EarnIntentWatcher } from './EarnIntentWatcher';
import {
  clearPollRegistryForTests,
  earnDepositPollKey,
  earnWithdrawPollKey,
  isPollActive,
  startIntentPoll
} from './poll-registry';
import { preparedExecution, PREPARED_FAUCET, PREPARED_OWNER, PREPARED_RECIPIENT } from './testing/earn-prepared';

const mockGetIntentStatus = jest.fn(async () => []);
const mockRetryIntentSolve = jest.fn(async () => ({ hash: 'hash', digest: 'digest', signature: 'signature' }));
const mockGetSdk = jest.fn(async () => ({
  getIntentStatus: mockGetIntentStatus,
  retryIntentSolve: mockRetryIntentSolve
}));
const mockRegisterBridgeIn = jest.fn(async () => undefined);
const mockAccepted = jest.fn(
  async (...args: Parameters<typeof import('lib/miden/transaction/complete').markEarnWithdrawAccepted>) =>
    jest
      .requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .markEarnWithdrawAccepted(...args)
);
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk'),
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('invalid account');
      return { toString: () => value };
    }
  }
}));
jest.mock('./sdk', () => ({
  getEpochReadOnlySdk: () => mockGetSdk(),
  ensureEpochSmartAccount: jest.fn()
}));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (value: string) => value }));
jest.mock('./earn-note', () => ({ createEarnP2IDENote: jest.fn() }));
jest.mock('./evm-account', () => ({ buildVaultEvmWalletClient: jest.fn() }));
jest.mock('lib/miden/activity', () => {
  return {
    get updateEarnDepositStatus() {
      return jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
        .updateEarnDepositStatus;
    },
    get updateEarnWithdrawPhase() {
      return jest.requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
        .updateEarnWithdrawPhase;
    },
    get markEarnWithdrawAccepted() {
      return mockAccepted;
    },
    initiateEarnWithdrawTransaction: jest.fn(),
    registerPendingBridgeIn: () => mockRegisterBridgeIn(),
    resolveBridgeInNoteId: jest.fn(),
    findPendingBridgeInByEarnWithdrawTxId: jest.fn()
  };
});

const OWNER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const NOW_SECONDS = Date.parse('2026-09-11T10:00:00Z') / 1000;
const EXPIRED_SECONDS = NOW_SECONDS - 7 * 24 * 60 * 60 - 1;
const pendingPhases: Array<IEarnWithdrawExtraInputs['phase']> = ['redeeming', 'delivering'];

function withdrawal(id: string, inputs: Partial<IEarnWithdrawExtraInputs> = {}): ITransaction {
  const extraInputs: IEarnWithdrawExtraInputs = {
    evmOwner: OWNER,
    marketUid: 'DUMMY_LENDING:11155111:0xunderlying',
    destinationFaucetId: 'destination-faucet',
    sourceAmount: '10',
    sourceSymbol: 'USDC',
    phase: 'redeeming',
    withdrawIntentNonce: `nonce-${id}`,
    submissionAttemptId: `attempt-${id}`,
    attemptStartedAt: NOW_SECONDS,
    ...inputs
  };
  return {
    id,
    type: 'earn-withdraw',
    accountId: 'miden-account',
    initiatedAt: NOW_SECONDS,
    completedAt: NOW_SECONDS,
    status: ITransactionStatus.Completed,
    displayIcon: 'DEFAULT',
    amount: 10_000_000n,
    extraInputs
  };
}

function own(key: string) {
  startIntentPoll({ key, intervalMs: 3_600_000, maxAttempts: 1, tick: async () => undefined });
  expect(isPollActive(key)).toBe(true);
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.setSystemTime(NOW_SECONDS * 1000);
  await transactions.clear();
});

afterEach(async () => {
  cleanup();
  clearPollRegistryForTests();
  jest.useRealTimers();
  jest.restoreAllMocks();
  await transactions.clear();
});

describe('EarnIntentWatcher local reconciliation', () => {
  it('repairs an unavailable sibling after a persisted selected receipt without changing its terminal phase', async () => {
    jest.useRealTimers();
    const row = withdrawal('received-prepared', {
      evmOwner: PREPARED_OWNER,
      marketUid: 'DUMMY_LENDING:11155111:token',
      destinationFaucetId: PREPARED_FAUCET,
      phase: 'received',
      withdrawIntentNonce: '22',
      midenNoteId: 'received-note',
      submissionState: 'prepared'
    });
    row.accountId = PREPARED_RECIPIENT;
    const identity = earnWithdrawExecutionIdentity(row);
    if (!identity) throw new Error('fixture identity');
    row.extraInputs.preparedExecution = selectEarnWithdrawPreparedExecution(preparedExecution(), identity);
    await transactions.add(row);
    render(<EarnIntentWatcher />);
    await waitFor(async () => {
      const persisted = await transactions.get(row.id);
      expect(persisted?.extraInputs.submissionState).toBe('accepted');
      expect(persisted?.extraInputs.phase).toBe('received');
      expect(persisted?.extraInputs.midenNoteId).toBe('received-note');
    });
    expect(mockRetryIntentSolve).toHaveBeenCalledTimes(1);
    expect(mockRetryIntentSolve).toHaveBeenCalledWith(JSON.parse(preparedExecution().allocations[0]!.requestJson));
    expect(mockGetIntentStatus).not.toHaveBeenCalledWith(PREPARED_OWNER, '22');
  });

  it.each(pendingPhases)('persists failure for a restored %s withdrawal whose poll key is owned', async phase => {
    const row = withdrawal('restored', { phase });
    row.restoredFromBackup = true;
    row.status = ITransactionStatus.Failed;
    await transactions.add(row);
    const heldKey = earnWithdrawPollKey(OWNER.toUpperCase(), 'nonce-restored');
    own(heldKey);

    render(<EarnIntentWatcher />);

    await waitFor(async () => {
      const persisted = await transactions.get('restored');
      const inputs: IEarnWithdrawExtraInputs | undefined = persisted?.extraInputs;
      expect(inputs?.phase).toBe('failed');
      expect(persisted?.error).toBe('Restored from a backup - this withdrawal could not be verified.');
    });
    expect(isPollActive(earnWithdrawPollKey(OWNER, 'nonce-restored'))).toBe(true);
    expect(mockGetSdk).not.toHaveBeenCalled();
    expect(mockGetIntentStatus).not.toHaveBeenCalled();
    expect(mockRegisterBridgeIn).not.toHaveBeenCalled();
  });

  it.each(pendingPhases)('preserves an owned %s intent despite its local age', async phase => {
    const row = withdrawal('expired', {
      phase,
      attemptStartedAt: EXPIRED_SECONDS
    });
    await transactions.add(row);
    own(earnWithdrawPollKey(OWNER.toUpperCase(), 'nonce-expired'));

    render(<EarnIntentWatcher />);

    await waitFor(async () => {
      const persisted = await transactions.get('expired');
      const inputs: IEarnWithdrawExtraInputs | undefined = persisted?.extraInputs;
      expect(inputs?.phase).toBe(phase);
      expect(persisted?.error).toBeUndefined();
      expect(persisted?.initiatedAt).toBe(NOW_SECONDS);
    });
    expect(isPollActive(earnWithdrawPollKey(OWNER, 'nonce-expired'))).toBe(true);
    expect(mockGetSdk).not.toHaveBeenCalled();
    expect(mockGetIntentStatus).not.toHaveBeenCalled();
    expect(mockRegisterBridgeIn).not.toHaveBeenCalled();
  });

  it('keeps restored deposits inert while a later root tick repairs an expired withdrawal', async () => {
    const depositInputs: IEarnDepositExtraInputs = {
      evmRecipient: OWNER,
      marketUid: 'market',
      sourceFaucetId: 'source-faucet',
      intentNonce: 'deposit-nonce',
      epochStatus: 'pending'
    };
    await transactions.add({
      id: 'restored-deposit',
      type: 'earn-deposit',
      accountId: 'miden-account',
      initiatedAt: NOW_SECONDS,
      completedAt: NOW_SECONDS,
      status: ITransactionStatus.Completed,
      displayIcon: 'DEFAULT',
      restoredFromBackup: true,
      extraInputs: depositInputs
    });
    const read = jest.spyOn(transactions, 'filter');
    render(<EarnIntentWatcher />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    await transactions.add(
      withdrawal('late-expired', {
        attemptStartedAt: EXPIRED_SECONDS,
        withdrawIntentNonce: undefined,
        submissionState: 'preparing'
      })
    );
    own(earnWithdrawPollKey(OWNER.toUpperCase(), 'nonce-late-expired'));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(async () => {
      const persisted = await transactions.get('late-expired');
      const inputs: IEarnWithdrawExtraInputs | undefined = persisted?.extraInputs;
      expect(inputs?.phase).toBe('failed');
    });
    const deposit = await transactions.get('restored-deposit');
    expect(deposit?.extraInputs).toEqual(depositInputs);
    expect(isPollActive(earnDepositPollKey(OWNER, 'deposit-nonce'))).toBe(false);
    expect(mockGetSdk).not.toHaveBeenCalled();
    expect(mockGetIntentStatus).not.toHaveBeenCalled();
    expect(mockRegisterBridgeIn).not.toHaveBeenCalled();
  });
});
