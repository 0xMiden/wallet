import React from 'react';

import { act, render } from '@testing-library/react';

import { IEarnDepositExtraInputs, IEarnWithdrawExtraInputs } from 'lib/miden/db/types';

import { EarnIntentWatcher } from './EarnIntentWatcher';
import {
  clearPollRegistryForTests,
  earnDepositPollKey,
  earnWithdrawPollKey,
  isPollActive,
  startIntentPoll
} from './poll-registry';
import { deferred } from './testing/earn-locks';

const mockReconcileEarnDeposits = jest.fn(async (): Promise<void> => undefined);
const mockReconcileEarnWithdrawals = jest.fn(async (): Promise<void> => undefined);
let mockDepositImport = () => undefined;
let mockWithdrawImport = () => undefined;
jest.mock('./earn', () => ({
  get reconcileEarnDeposits() {
    mockDepositImport();
    return mockReconcileEarnDeposits;
  }
}));
jest.mock('./earn-withdraw', () => ({
  get reconcileEarnWithdrawals() {
    mockWithdrawImport();
    return mockReconcileEarnWithdrawals;
  }
}));

interface Row {
  id: string;
  type: string;
  status: number;
  initiatedAt: number;
  restoredFromBackup?: boolean;
  extraInputs?: Partial<IEarnDepositExtraInputs & IEarnWithdrawExtraInputs>;
}
let mockRows: Row[] = [];
const mockReadRows = jest.fn(async (): Promise<Row[]> => mockRows);
jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (tx: Row) => boolean) => ({
      toArray: async () => (await mockReadRows()).filter(predicate)
    })
  }
}));

const OWNER = '0x1111111111111111111111111111111111111111';
const depositRow = (extraInputs: Partial<IEarnDepositExtraInputs> = {}, status = 2): Row => ({
  id: 'dep-1',
  type: 'earn-deposit',
  status,
  initiatedAt: Date.now() / 1000,
  extraInputs: { evmRecipient: OWNER, epochStatus: 'pending', intentNonce: 'N1', ...extraInputs }
});
const withdrawRow = (extraInputs: Partial<IEarnWithdrawExtraInputs> = {}): Row => ({
  id: 'wd-1',
  type: 'earn-withdraw',
  status: 2,
  initiatedAt: Date.now() / 1000,
  extraInputs: { evmOwner: OWNER, phase: 'redeeming', withdrawIntentNonce: 'N2', ...extraInputs }
});
const settle = async () => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
};
const tick = async () => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(15_000);
  });
};
const own = (key: string) =>
  startIntentPoll({ key, intervalMs: 1_000_000, maxAttempts: 1, tick: async () => undefined });

describe('EarnIntentWatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-11T10:00:00Z'));
    mockRows = [];
    mockReadRows.mockReset().mockImplementation(async () => mockRows);
    mockReconcileEarnDeposits.mockReset().mockResolvedValue(undefined);
    mockReconcileEarnWithdrawals.mockReset().mockResolvedValue(undefined);
    mockDepositImport = () => undefined;
    mockWithdrawImport = () => undefined;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    clearPollRegistryForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('scans initially and every 15 seconds, discovering later rows without remount', async () => {
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    mockRows = [depositRow(), withdrawRow()];
    await tick();
    expect(mockReadRows).toHaveBeenCalledTimes(2);
    expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(1);
    await tick();
    expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(2);
  });

  it('skips owned identities, recovers after release, and leaves pollers alive on unmount', async () => {
    const depositKey = earnDepositPollKey(OWNER, 'N1');
    own(depositKey);
    own(earnWithdrawPollKey(OWNER, 'N2'));
    mockRows = [depositRow(), withdrawRow()];
    const view = render(<EarnIntentWatcher />);
    await settle();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
    clearPollRegistryForTests();
    await tick();
    expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(1);
    own(depositKey);
    view.unmount();
    expect(isPollActive(depositKey)).toBe(true);
    await tick();
    expect(mockReadRows).toHaveBeenCalledTimes(2);
  });

  it('does not confuse different owners with the same nonce', async () => {
    own(earnDepositPollKey('another-owner', 'N1'));
    own(earnWithdrawPollKey('another-owner', 'N2'));
    mockRows = [depositRow(), withdrawRow()];
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(1);
  });

  it('ignores terminal rows, uncompleted deposits, nonce-less deposits and restored deposits', async () => {
    mockRows = [
      depositRow({ epochStatus: 'confirmed' }),
      depositRow({}, 1),
      depositRow({ intentNonce: undefined }),
      { ...depositRow(), restoredFromBackup: true },
      withdrawRow({ phase: 'received' }),
      withdrawRow({ phase: 'failed' })
    ];
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
  });

  it.each(['restored', 'expired', 'missing nonce', 'missing owner'])(
    'admits %s withdrawals despite unrelated or active poll ownership',
    async variant => {
      own(earnWithdrawPollKey(OWNER, 'N2'));
      const row = withdrawRow();
      if (variant === 'restored') row.restoredFromBackup = true;
      if (variant === 'expired') row.initiatedAt -= 7 * 24 * 60 * 60 + 1;
      if (variant === 'missing nonce' && row.extraInputs) row.extraInputs.withdrawIntentNonce = undefined;
      if (variant === 'missing owner' && row.extraInputs) row.extraInputs.evmOwner = undefined;
      mockRows = [row];
      render(<EarnIntentWatcher />);
      await settle();
      expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(1);
    }
  );

  it('uses the attempt age and strict TTL boundary rather than a retried row history date', async () => {
    own(earnWithdrawPollKey(OWNER, 'N2'));
    const now = Date.now() / 1000;
    jest.setSystemTime(Date.now() + 999);
    mockRows = [{ ...withdrawRow({ attemptStartedAt: now - 7 * 24 * 60 * 60 }), initiatedAt: 1 }];
    render(<EarnIntentWatcher />);
    await settle();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
    await tick();
    expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(1);
  });

  it('resumes scanning after the document becomes visible', async () => {
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mockRows = [depositRow()];
    render(<EarnIntentWatcher />);
    await settle();
    await tick();
    expect(mockReadRows).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await tick();
    expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(1);
  });

  it.each(['deposits', 'withdrawals'])(
    'a parked %s reconciler does not block the opposite direction or overlap itself',
    async direction => {
      const parked = deferred<void>();
      const blocked = direction === 'deposits' ? mockReconcileEarnDeposits : mockReconcileEarnWithdrawals;
      const other = direction === 'deposits' ? mockReconcileEarnWithdrawals : mockReconcileEarnDeposits;
      blocked.mockImplementation(() => parked.promise);
      mockRows = [depositRow(), withdrawRow()];
      render(<EarnIntentWatcher />);
      await settle();
      await tick();
      expect(blocked).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(2);
      parked.resolve();
      await settle();
      await tick();
      expect(blocked).toHaveBeenCalledTimes(2);
    }
  );

  it('does not overlap scans and ignores a scan completed after unmount', async () => {
    const pending = deferred<Row[]>();
    mockReadRows.mockReturnValue(pending.promise);
    const view = render(<EarnIntentWatcher />);
    await settle();
    await tick();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    view.unmount();
    pending.resolve([depositRow(), withdrawRow()]);
    await settle();
    expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
    expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
  });

  it.each(['deposits', 'withdrawals'])(
    'does not invoke %s after its import completes during teardown',
    async direction => {
      mockRows = [direction === 'deposits' ? depositRow() : withdrawRow()];
      const view = render(<EarnIntentWatcher />);
      if (direction === 'deposits')
        mockDepositImport = () => {
          view.unmount();
          return undefined;
        };
      else
        mockWithdrawImport = () => {
          view.unmount();
          return undefined;
        };
      await settle();
      expect(mockReadRows).toHaveBeenCalledTimes(1);
      expect(mockReconcileEarnDeposits).not.toHaveBeenCalled();
      expect(mockReconcileEarnWithdrawals).not.toHaveBeenCalled();
    }
  );

  it('recovers from scan and reconciler failures on later ticks', async () => {
    mockRows = [depositRow(), withdrawRow()];
    mockReadRows.mockRejectedValueOnce(new Error('DB unavailable'));
    mockReconcileEarnDeposits.mockRejectedValueOnce(new Error('deposit unavailable'));
    mockReconcileEarnWithdrawals.mockRejectedValueOnce(new Error('withdraw unavailable'));
    render(<EarnIntentWatcher />);
    await settle();
    await tick();
    await tick();
    expect(mockReadRows).toHaveBeenCalledTimes(3);
    expect(mockReconcileEarnDeposits).toHaveBeenCalledTimes(2);
    expect(mockReconcileEarnWithdrawals).toHaveBeenCalledTimes(2);
  });
});
