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

const mockSweepOnce = jest.fn(async () => {});
const mockCancelStuck = jest.fn(async () => {});
const mockGetAllUncompleted = jest.fn(async (): Promise<unknown[]> => []);
const mockStartBg = jest.fn();
jest.mock('../transaction', () => ({
  sweepInterruptedTransactionsOnce: () => mockSweepOnce(),
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

    await waitFor(() => expect(mockSweepOnce).toHaveBeenCalledTimes(1));
    expect(mockCancelStuck).not.toHaveBeenCalled();
    await waitFor(() => expect(mockStartBg).toHaveBeenCalledWith(mockSignTransaction, false, { kind: 'zustand' }));
  });

  it('still runs the sweep when nothing is left to process', async () => {
    // The sweep must not be conditional on there being work: the loop is only
    // started when `getAllUncompletedTransactions` is non-empty, so an orphan that
    // is the ONLY row still has to be cleared out of `GeneratingTransaction`.
    render(<OrphanedTransactionRecovery />);

    await waitFor(() => expect(mockSweepOnce).toHaveBeenCalledTimes(1));
    expect(mockStartBg).not.toHaveBeenCalled();
  });

  it('does nothing on the extension — runtime.onStartup owns startup recovery', async () => {
    mockExtension = true;
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    render(<OrphanedTransactionRecovery />);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockSweepOnce).not.toHaveBeenCalled();
    expect(mockStartBg).not.toHaveBeenCalled();
  });

  it('runs at most once even if the component re-renders', async () => {
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    const { rerender } = render(<OrphanedTransactionRecovery />);
    rerender(<OrphanedTransactionRecovery />);
    rerender(<OrphanedTransactionRecovery />);

    await waitFor(() => expect(mockStartBg).toHaveBeenCalledTimes(1));
    expect(mockSweepOnce).toHaveBeenCalledTimes(1);
  });

  it('never re-runs the startup recovery after a REMOUNT in the same process', async () => {
    // The sweep is once per realm on its own (sweepInterruptedTransactionsOnce); the
    // module-scope latch keeps a provider remount from starting a second poller.
    mockGetAllUncompleted.mockResolvedValue([{ id: 'tx-orphan' }]);

    const first = render(<OrphanedTransactionRecovery />);
    await waitFor(() => expect(mockStartBg).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<OrphanedTransactionRecovery />);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockSweepOnce).toHaveBeenCalledTimes(1);
    expect(mockStartBg).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing row read instead of crashing the app tree', async () => {
    // The sweep never rejects (it logs its own failure), so the read after it is
    // what reaches this catch.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetAllUncompleted.mockRejectedValueOnce(new Error('db closed'));

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
