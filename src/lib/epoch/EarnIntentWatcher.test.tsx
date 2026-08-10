import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { EarnIntentWatcher } from './EarnIntentWatcher';
import { clearPollRegistryForTests, earnDepositPollKey, earnWithdrawPollKey, tryBeginPoll } from './poll-registry';

const mockReconcileEarnDeposits = jest.fn(async (): Promise<void> => undefined);
jest.mock('./earn', () => ({ reconcileEarnDeposits: () => mockReconcileEarnDeposits() }));

const mockReconcileEarnWithdrawals = jest.fn(async (): Promise<void> => undefined);
jest.mock('./earn-withdraw', () => ({ reconcileEarnWithdrawals: () => mockReconcileEarnWithdrawals() }));

interface Row {
  id: string;
  type: string;
  status: number;
  extraInputs?: Record<string, unknown>;
}
let mockRows: Row[] = [];
jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (tx: Row) => boolean) => ({
      toArray: async () => mockRows.filter(predicate)
    })
  }
}));

const COMPLETED = 2;

const depositRow = (extraInputs: Record<string, unknown>, status = COMPLETED): Row => ({
  id: 'dep-1',
  type: 'earn-deposit',
  status,
  extraInputs
});

const withdrawRow = (extraInputs: Record<string, unknown>): Row => ({
  id: 'wd-1',
  type: 'earn-withdraw',
  status: COMPLETED,
  extraInputs
});

/** Let the mounted watcher run its immediate first tick to completion. */
const settle = async () => {
  // Two awaited dynamic imports + the Dexie scan need a few microtask turns.
  await waitFor(() => expect(true).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('EarnIntentWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPollRegistryForTests();
    mockRows = [];
  });

  it('does nothing when there are no earn rows', async () => {
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
  });

  it('reconciles deposits when a pending intent has no live poll', async () => {
    mockRows = [depositRow({ epochStatus: 'pending', intentNonce: 'N1' })];
    render(<EarnIntentWatcher />);
    await waitFor(() => expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(1));
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
  });

  it('reconciles withdrawals for a non-terminal phase, including a row that lost its nonce', async () => {
    mockRows = [withdrawRow({ phase: 'redeeming' })];
    render(<EarnIntentWatcher />);
    await waitFor(() => expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(1));
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
  });

  it('skips rows already covered by a live poll', async () => {
    tryBeginPoll(earnDepositPollKey('N1'));
    tryBeginPoll(earnWithdrawPollKey('N2'));
    mockRows = [
      depositRow({ epochStatus: 'pending', intentNonce: 'N1' }),
      withdrawRow({ phase: 'delivering', withdrawIntentNonce: 'N2' })
    ];
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
  });

  it('ignores terminal rows and deposits whose Miden leg has not completed', async () => {
    mockRows = [
      depositRow({ epochStatus: 'confirmed', intentNonce: 'N1' }),
      depositRow({ epochStatus: 'pending', intentNonce: 'N2' }, 1), // still proving
      depositRow({ epochStatus: 'pending' }), // no nonce yet → nothing to poll
      withdrawRow({ phase: 'received' }),
      withdrawRow({ phase: 'failed' })
    ];
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
  });

  it('does not tick while the document is hidden', async () => {
    const hiddenSpy = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mockRows = [depositRow({ epochStatus: 'pending', intentNonce: 'N1' })];
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    hiddenSpy.mockRestore();
  });
});
