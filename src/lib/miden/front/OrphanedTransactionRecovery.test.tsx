/**
 * `OrphanedTransactionRecovery` is the mobile/desktop stand-in for the extension's
 * startup recovery. Off-extension there is no SW, and before this component existed
 * nothing failed orphaned rows or restarted the FIFO loop at app start — a send
 * interrupted by an app kill sat in `GeneratingTransaction` indefinitely with its
 * inputs reserved, head-of-line blocking every later transaction.
 */
import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { __resetColdStartSweepForTests, OrphanedTransactionRecovery } from './OrphanedTransactionRecovery';

const mockFailInterrupted = jest.fn(async () => {});
const mockCancelStuck = jest.fn(async () => {});
const mockGetAllUncompleted = jest.fn(async (): Promise<unknown[]> => []);
const mockStartBg = jest.fn();
jest.mock('../transaction', () => ({
  failInterruptedTransactions: () => mockFailInterrupted(),
  cancelStuckTransactions: () => mockCancelStuck(),
  getAllUncompletedTransactions: () => mockGetAllUncompleted(),
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBg(...args)
}));

let mockExtension = false;
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));

const mockSignTransaction = jest.fn();
jest.mock('./client', () => ({
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

jest.mock('./guardian-sync', () => ({ zustandProvider: { kind: 'zustand' } }));

describe('OrphanedTransactionRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetColdStartSweepForTests();
    mockExtension = false;
    mockGetAllUncompleted.mockResolvedValue([]);
  });

  it('fails orphaned rows AGE-INDEPENDENTLY, not through the age-gated reaper', async () => {
    // The regression this pins: `cancelStuckTransactions()` only reaps a row once
    // `MAX_WAIT_BEFORE_CANCEL` has elapsed — 30 minutes on Tauri desktop — while
    // `generateTransactionsLoop` returns early whenever ANY row is
    // `GeneratingTransaction`. A crash 3 minutes into a send therefore froze every
    // later send/claim/swap at Queued for the remaining ~27 minutes. A fresh app
    // process is definitionally a cold start, so the sweep must be unconditional.
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    render(<OrphanedTransactionRecovery />);

    await waitFor(() => expect(mockFailInterrupted).toHaveBeenCalledTimes(1));
    expect(mockCancelStuck).not.toHaveBeenCalled();
    await waitFor(() => expect(mockStartBg).toHaveBeenCalledWith(mockSignTransaction, false, { kind: 'zustand' }));
  });

  it('still runs the sweep when nothing is left to process', async () => {
    // The sweep must not be conditional on there being work: the loop is only
    // started when `getAllUncompletedTransactions` is non-empty, so an orphan that
    // is the ONLY row still has to be cleared out of `GeneratingTransaction`.
    render(<OrphanedTransactionRecovery />);

    await waitFor(() => expect(mockFailInterrupted).toHaveBeenCalledTimes(1));
    expect(mockStartBg).not.toHaveBeenCalled();
  });

  it('does nothing on the extension — runtime.onStartup owns startup recovery', async () => {
    mockExtension = true;
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    render(<OrphanedTransactionRecovery />);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockFailInterrupted).not.toHaveBeenCalled();
    expect(mockStartBg).not.toHaveBeenCalled();
  });

  it('runs at most once even if the component re-renders', async () => {
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    const { rerender } = render(<OrphanedTransactionRecovery />);
    rerender(<OrphanedTransactionRecovery />);
    rerender(<OrphanedTransactionRecovery />);

    await waitFor(() => expect(mockStartBg).toHaveBeenCalledTimes(1));
    expect(mockFailInterrupted).toHaveBeenCalledTimes(1);
  });

  it('never re-runs the age-independent sweep after a REMOUNT in the same process', async () => {
    // The latch is module scope, not a component ref, precisely because
    // `failInterruptedTransactions` fails every in-progress row regardless of age:
    // a second run inside a live app process would kill a transaction that is
    // actively processing right now.
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    const first = render(<OrphanedTransactionRecovery />);
    await waitFor(() => expect(mockFailInterrupted).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<OrphanedTransactionRecovery />);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockFailInterrupted).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing sweep instead of crashing the app tree', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFailInterrupted.mockRejectedValueOnce(new Error('db closed'));

    render(<OrphanedTransactionRecovery />);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(mockStartBg).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('renders nothing', () => {
    const { container } = render(<OrphanedTransactionRecovery />);
    expect(container).toBeEmptyDOMElement();
  });
});
