import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';

const mockInitiateConsume = jest.fn(
  async (_account: string, _note: { id: string }, _delegate?: boolean): Promise<string> => 'consume-tx'
);
const mockStartBg = jest.fn();
jest.mock('../transaction', () => ({
  initiateConsumeTransaction: mockInitiateConsume,
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBg(...args)
}));

const mockGetFaucetIdSetting = jest.fn(async (): Promise<string | null> => 'native-faucet');
jest.mock('lib/miden/assets', () => ({ getFaucetIdSetting: () => mockGetFaucetIdSetting() }));

let mockExtension = false;
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));

let mockAutoConsume = true;
let mockDelegate = true;
jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => mockAutoConsume,
  isDelegateProofEnabled: () => mockDelegate
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
    mockDelegate = true;
    mockClaimable = [];
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
  });

  it('consumes only native, non-swap, not-being-claimed notes — one tx per note', async () => {
    mockClaimable = [
      note('n1'), // native ✓
      note('n2', 'other-faucet'), // wrong faucet ✗
      note('n3', 'native-faucet', { swapOrder: { orderId: 'x' } }), // swap-managed ✗
      note('n4', 'native-faucet', { isBeingClaimed: true }) // already claiming ✗
    ];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume).toHaveBeenCalled());
    // Only n1 is eligible; every consume is per-note and for n1 — never n2/n3/n4.
    mockInitiateConsume.mock.calls.forEach(c => {
      expect(c[0]).toBe('pk-1');
      expect(c[1].id).toBe('n1');
    });
    expect(mockStartBg).toHaveBeenCalled();
  });

  it('follows the user local/delegated proving setting', async () => {
    mockDelegate = false; // user picked LOCAL proving
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume).toHaveBeenCalled());
    expect(mockInitiateConsume.mock.calls[0]![2]).toBe(false);
  });

  it('is a no-op on the extension (the service worker owns that path)', async () => {
    mockExtension = true;
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });

  it('is a no-op when auto-consume is disabled', async () => {
    mockAutoConsume = false;
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });
});
