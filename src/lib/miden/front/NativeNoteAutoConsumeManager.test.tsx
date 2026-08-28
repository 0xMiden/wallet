import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';

const mockInitiateConsume = jest.fn(
  async (_account: string, _note: { id: string }, _delegate?: boolean): Promise<string> => 'consume-tx'
);
const mockStartBg = jest.fn();
const mockGetUncompleted = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [{ id: 'tx' }]);
jest.mock('../transaction', () => ({
  initiateConsumeTransaction: mockInitiateConsume,
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBg(...args),
  getUncompletedTransactions: (...args: unknown[]) => mockGetUncompleted(...args)
}));

const mockGetFaucetIdSetting = jest.fn(async (): Promise<string | null> => 'native-faucet');
jest.mock('lib/miden/assets', () => ({ getFaucetIdSetting: () => mockGetFaucetIdSetting() }));
let mockBaseFee: number | null = 0;
jest.mock('lib/miden-chain/native-asset', () => ({
  getVerificationBaseFee: () => Promise.resolve(mockBaseFee)
}));

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

const mockClearNoteReceived = jest.fn();
jest.mock('lib/mobile/native-notifications', () => ({
  clearNoteReceivedNotification: (...args: unknown[]) => mockClearNoteReceived(...args)
}));

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
    mockGetUncompleted.mockResolvedValue([{ id: 'tx' }]);
  });

  it('does not auto-consume a native note worth less than the fee to claim it', async () => {
    // Auto-consume runs unattended, so claiming a note that costs more in fee than
    // it yields silently moves the balance DOWN.
    mockBaseFee = 10000;
    mockClaimable = [
      note('dust', 'native-faucet', { amount: '9999' }),
      note('breakeven', 'native-faucet', { amount: '10000' }),
      note('worthit', 'native-faucet', { amount: '10001' })
    ];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume.mock.calls.length).toBeGreaterThanOrEqual(1));
    expect(new Set(mockInitiateConsume.mock.calls.map(c => c[1].id))).toEqual(new Set(['worthit']));
  });

  it('auto-consumes every native note on a chain that charges no fee', async () => {
    mockBaseFee = 0;
    mockClaimable = [note('a', 'native-faucet', { amount: '1' }), note('b', 'native-faucet', { amount: '2' })];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(new Set(mockInitiateConsume.mock.calls.map(c => c[1].id))).toEqual(new Set(['a', 'b']));
  });

  it('consumes the eligible native notes ONE TX PER NOTE (not a batch), skipping the rest', async () => {
    mockClaimable = [
      note('n1'), // native ✓
      note('n1b'), // native ✓ (second eligible so per-note vs batch is distinguishable)
      note('n2', 'other-faucet'), // wrong faucet ✗
      note('n3', 'native-faucet', { swapOrder: { orderId: 'x' } }), // swap-managed ✗
      note('n4', 'native-faucet', { isBeingClaimed: true }) // already claiming ✗
    ];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume.mock.calls.length).toBeGreaterThanOrEqual(2));
    // Per-note: each call takes a single note object (never a batch array), for pk-1.
    mockInitiateConsume.mock.calls.forEach(c => {
      expect(c[0]).toBe('pk-1');
      expect(Array.isArray(c[1])).toBe(false);
    });
    // Exactly the two eligible native notes — never n2/n3/n4.
    expect(new Set(mockInitiateConsume.mock.calls.map(c => c[1].id))).toEqual(new Set(['n1', 'n1b']));
    expect(mockStartBg).toHaveBeenCalled();
  });

  it('clears the stale claim notification after auto-claiming native notes off-Home (#459)', async () => {
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume).toHaveBeenCalled());
    // This route-independent consumer must dismiss the "click to claim"
    // notification too — it's the path that runs when the user isn't on Home.
    await waitFor(() => expect(mockClearNoteReceived).toHaveBeenCalled());
  });

  it('does not clear the notification when there are no eligible native notes', async () => {
    mockClaimable = [note('n2', 'other-faucet')]; // wrong faucet -> nothing to consume

    render(<NativeNoteAutoConsumeManager />);

    // Give the tick a chance to run and bail.
    await waitFor(() => expect(mockGetFaucetIdSetting).toHaveBeenCalled());
    expect(mockInitiateConsume).not.toHaveBeenCalled();
    expect(mockClearNoteReceived).not.toHaveBeenCalled();
  });

  it('does not kick the tx processor when nothing needs driving (all deduped)', async () => {
    mockGetUncompleted.mockResolvedValue([]); // no uncompleted work after enqueue
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume).toHaveBeenCalled());
    expect(mockStartBg).not.toHaveBeenCalled();
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
