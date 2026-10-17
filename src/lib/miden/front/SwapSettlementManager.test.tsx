import React from 'react';

import { act, render, waitFor } from '@testing-library/react';

import { SwapSettlementManager } from './SwapSettlementManager';

// The wallet store's lock state, as the claim guard reads it.
let mockWalletReady = true;
jest.mock('lib/store', () => ({ isWalletReadyNow: () => mockWalletReady }));

jest.mock('lib/platform', () => ({ isExtension: () => false }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => true }));

const mockSignTransaction = jest.fn();
jest.mock('./client', () => ({
  useMidenContext: () => ({ currentAccount: { publicKey: 'pk-1' }, signTransaction: mockSignTransaction })
}));
jest.mock('./guardian-sync', () => ({ zustandProvider: { kind: 'zustand' } }));

const mockStartBg = jest.fn();
jest.mock('../transaction', () => ({
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBg(...args)
}));

// Runs while the pass holds the client for its note read; a test lands the lock here.
let mockOnNoteRead: () => void = () => undefined;
const writtenRows: string[] = [];
// The pass, down to what the claim queue does with the guard it is handed (settlement.test.ts follows the guard to
// the queue, initiate.batch-isolation.test.ts pins the refusal on real rows): a guard that answers no at the write
// refuses it.
const mockSettle = jest.fn(async (_accountId: string, _delegate?: boolean, canSign?: unknown) => {
  await Promise.resolve();
  mockOnNoteRead();
  if (typeof canSign === 'function' && !canSign()) throw new Error('Claim not queued');
  writtenRows.push('payback');
  return { queuedTransactionIds: ['consume-1'], managedNoteIds: new Set<string>() };
});
jest.mock('../swap/settlement', () => ({
  settleSwapOrders: (...args: [string, boolean?, unknown?]) => mockSettle(...args)
}));

describe('SwapSettlementManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    writtenRows.length = 0;
    mockWalletReady = true;
    mockOnNoteRead = () => undefined;
  });

  it('queues no settlement row and starts no processing when the lock lands during the note read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockOnNoteRead = () => {
      mockWalletReady = false;
    };

    render(<SwapSettlementManager />);
    await waitFor(() => expect(mockSettle).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(writtenRows).toEqual([]);
    expect(mockStartBg).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('queues the settlement row and starts processing on a tick the wallet stays unlocked through', async () => {
    render(<SwapSettlementManager />);

    await waitFor(() => expect(mockStartBg).toHaveBeenCalledTimes(1));
    expect(writtenRows).toEqual(['payback']);
    expect(mockSettle).toHaveBeenCalledWith('pk-1', true, expect.any(Function));
  });
});
