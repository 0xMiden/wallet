import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';

const mockInitiateConsumeNotes = jest.fn(
  async (_account: string, _notes: Array<{ id: string }>, _delegate?: boolean): Promise<string> => 'consume-tx'
);
const mockStartBg = jest.fn();
jest.mock('../transaction', () => ({
  initiateConsumeNotesTransaction: mockInitiateConsumeNotes,
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBg(...args)
}));

const mockGetFaucetIdSetting = jest.fn(async (): Promise<string | null> => 'native-faucet');
jest.mock('lib/miden/assets', () => ({ getFaucetIdSetting: () => mockGetFaucetIdSetting() }));

let mockExtension = false;
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));

let mockAutoConsume = true;
jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => mockAutoConsume,
  isDelegateProofEnabled: () => true
}));

let mockClaimable: unknown[] = [];
jest.mock('./claimable-notes', () => ({ useClaimableNotes: () => ({ data: mockClaimable }) }));

const mockSignTransaction = jest.fn();
jest.mock('./client', () => ({
  useMidenContext: () => ({ currentAccount: { publicKey: 'pk-1' }, signTransaction: mockSignTransaction })
}));

jest.mock('./guardian-sync', () => ({ zustandProvider: { kind: 'zustand' } }));

const note = (id: string, faucetId = 'native-faucet', extra: Record<string, unknown> = {}) => ({
  id,
  faucetId,
  amount: '100',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: 'Public',
  swapOrder: undefined,
  ...extra
});

describe('NativeNoteAutoConsumeManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtension = false;
    mockAutoConsume = true;
    mockClaimable = [];
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
  });

  it('consumes only native, non-swap, not-being-claimed notes on mobile/desktop', async () => {
    mockClaimable = [
      note('n1'), // native ✓
      note('n2', 'other-faucet'), // wrong faucet ✗
      note('n3', 'native-faucet', { swapOrder: { orderId: 'x' } }), // swap-managed ✗
      note('n4', 'native-faucet', { isBeingClaimed: true }) // already claiming ✗
    ];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeNotes).toHaveBeenCalledTimes(1));
    const [account, notes, delegate] = mockInitiateConsumeNotes.mock.calls[0]!;
    expect(account).toBe('pk-1');
    expect(notes.map(n => n.id)).toEqual(['n1']);
    expect(delegate).toBe(true);
    expect(mockStartBg).toHaveBeenCalled();
  });

  it('is a no-op on the extension (the service worker owns that path)', async () => {
    mockExtension = true;
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockInitiateConsumeNotes).not.toHaveBeenCalled();
  });

  it('is a no-op when auto-consume is disabled', async () => {
    mockAutoConsume = false;
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockInitiateConsumeNotes).not.toHaveBeenCalled();
  });
});
