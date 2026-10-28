import React from 'react';

import { act, render, waitFor } from '@testing-library/react';

import { AUTO_CONSUME_STORAGE_KEY, DELEGATE_PROOF_STORAGE_KEY } from 'lib/settings/constants';

import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';

const mockInitiateConsume = jest.fn(
  async (_account: string, _note: { id: string }, _delegate?: boolean, ..._rest: unknown[]): Promise<string> =>
    'consume-tx'
);
const mockStartBg = jest.fn();
const mockGetUncompleted = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [{ id: 'tx' }]);
const mockInitiateConsumeBatch = jest.fn(async (..._a: any[]) => 'batch-tx');
jest.mock('../transaction', () => ({
  initiateConsumeTransaction: mockInitiateConsume,
  initiateConsumeNotesTransaction: mockInitiateConsumeBatch,
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBg(...args),
  getUncompletedTransactions: (...args: unknown[]) => mockGetUncompleted(...args)
}));

const mockGetFaucetIdSetting = jest.fn(async (): Promise<string | null> => 'native-faucet');
let mockLegacyFeeIdentity: string | undefined;
jest.mock('lib/miden/assets', () => ({
  getFaucetIdSetting: () =>
    mockLegacyFeeIdentity === undefined ? mockGetFaucetIdSetting() : Promise.resolve(mockLegacyFeeIdentity)
}));
let mockBaseFee: number | null = 0;
// Runs as the tick reads the fee; a test lands the lock here, after the tick decided to claim.
let mockOnFeeRead: () => void = () => undefined;
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: () => mockGetFaucetIdSetting(),
  getVerificationBaseFee: () => {
    mockOnFeeRead();
    return Promise.resolve(mockBaseFee);
  }
}));

// The wallet store's lock state, as the claim guard reads it.
let mockWalletReady = true;
jest.mock('lib/store', () => ({ isWalletReadyNow: () => mockWalletReady }));

let mockExtension = false;
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));

let mockAutoConsume = true;
let mockDelegate = true;
let mockUseRealSettings = false;
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () =>
    mockUseRealSettings ? jest.requireActual('lib/settings/helpers').isAutoConsumeEnabled() : mockAutoConsume,
  isDelegateProofEnabled: () =>
    mockUseRealSettings ? jest.requireActual('lib/settings/helpers').isDelegateProofEnabled() : mockDelegate
}));

let mockClaimable: unknown[] = [];
jest.mock('./claimable-notes', () => ({ useClaimableNotes: () => ({ data: mockClaimable }) }));

const mockSignTransaction = jest.fn();
let mockCurrentAccount: { publicKey: string; requiresHotKeyRotation?: boolean } = { publicKey: 'pk-1' };
jest.mock('./client', () => ({
  useMidenContext: () => ({ currentAccount: mockCurrentAccount, signTransaction: mockSignTransaction })
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
    mockUseRealSettings = false;
    if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
    localStorage.clear();
    mockClaimable = [];
    mockCurrentAccount = { publicKey: 'pk-1' };
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockGetUncompleted.mockResolvedValue([{ id: 'tx' }]);
    mockInitiateConsumeBatch.mockImplementation(async () => 'batch-tx');
    mockInitiateConsume.mockImplementation(async () => 'consume-tx');
    mockOnFeeRead = () => undefined;
    mockWalletReady = true;
  });

  afterEach(() => {
    if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
  });

  // The claim queue's contract, pinned on real rows in initiate.batch-isolation.test.ts: a guard that answers no at
  // the write refuses it. Returns the note ids of every row written.
  const guardCheckingQueue = (): string[][] => {
    const written: string[][] = [];
    const write = (noteIds: string[], canSign: unknown): string => {
      if (typeof canSign === 'function' && !canSign()) throw new Error('Claim not queued');
      written.push(noteIds);
      return 'tx';
    };
    mockInitiateConsumeBatch.mockImplementation(async (...args: any[]) =>
      write(
        args[1].map((n: { id: string }) => n.id),
        args[7]
      )
    );
    mockInitiateConsume.mockImplementation(async (...args: any[]) => write([args[1].id], args[5]));
    return written;
  };

  it('queues no claim, runs no per-note fallback and starts nothing when the lock lands after the fee read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const written = guardCheckingQueue();
    mockOnFeeRead = () => {
      mockWalletReady = false;
    };
    mockClaimable = [note('a'), note('b')];

    render(<NativeNoteAutoConsumeManager />);
    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(written).toEqual([]);
    expect(mockInitiateConsume).not.toHaveBeenCalled();
    expect(mockGetUncompleted).not.toHaveBeenCalled();
    expect(mockStartBg).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('queues the batch and starts processing on a tick the wallet stays unlocked through', async () => {
    const written = guardCheckingQueue();
    mockClaimable = [note('a'), note('b')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockStartBg).toHaveBeenCalledTimes(1));
    expect(written).toEqual([['a', 'b']]);
    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });

  it('fee identity: auto-consumes actual native notes and leaves the legacy display faucet manual', async () => {
    mockLegacyFeeIdentity = 'legacy-B';
    mockBaseFee = 7;
    mockClaimable = [
      note('actual-note', 'native-faucet', { amount: '1000000' }),
      note('legacy-note', 'legacy-B', { amount: '1000000' })
    ];
    render(<NativeNoteAutoConsumeManager />);
    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1));
    expect(mockInitiateConsumeBatch.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ id: 'actual-note' })]);
  });

  it('claims every eligible note in ONE transaction, paying one fee', async () => {
    mockClaimable = [note('a'), note('b'), note('c')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1));
    expect(mockInitiateConsumeBatch.mock.calls[0]![1].map((n: any) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the native notes of a rotation-pending account to its rotation gate (#805)', async () => {
    mockCurrentAccount = { publicKey: 'pk-1', requiresHotKeyRotation: true };
    mockClaimable = [note('a')];

    render(<NativeNoteAutoConsumeManager />);
    // The first tick runs as the effect mounts; one macrotask is enough for it to reach the read.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(mockGetFaucetIdSetting).not.toHaveBeenCalled();
    expect(mockInitiateConsumeBatch).not.toHaveBeenCalled();
  });

  it('never claims a native note that only the cached list has shown', async () => {
    mockClaimable = [note('cached', 'native-faucet', { fromCache: true }), note('live')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1));
    expect(mockInitiateConsumeBatch.mock.calls[0]![1].map((n: any) => n.id)).toEqual(['live']);
  });

  it('falls back to one transaction per note when the batch fails', async () => {
    // A Miden transaction is atomic, so one unconsumable note fails the whole
    // batch. Splitting isolates the poison note instead of letting it throttle
    // its healthy mates through the shared per-note backoff.
    mockClaimable = [note('a'), note('b')];
    mockInitiateConsumeBatch.mockRejectedValueOnce(new Error('one note is unconsumable'));

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsume.mock.calls.length).toBe(2));
    expect(new Set(mockInitiateConsume.mock.calls.map(c => c[1].id))).toEqual(new Set(['a', 'b']));
    // Batched or one per note, every row is queued as auto-consume.
    expect(mockInitiateConsumeBatch.mock.calls[0]![6]).toBe('auto_consume');
    expect(mockInitiateConsume.mock.calls.map(c => c[4])).toEqual(['auto_consume', 'auto_consume']);
  });

  it('fee-refused native batch has no single-note fallback or processing kick', async () => {
    const { ClaimFeeRefusedError } =
      jest.requireActual<typeof import('../transaction/initiate')>('../transaction/initiate');
    mockClaimable = [note('a'), note('b')];
    mockInitiateConsumeBatch.mockRejectedValueOnce(new ClaimFeeRefusedError());

    const view = render(<NativeNoteAutoConsumeManager />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1);
    expect(mockInitiateConsume).not.toHaveBeenCalled();
    expect(mockGetUncompleted).not.toHaveBeenCalled();
    expect(mockStartBg).not.toHaveBeenCalled();
    expect(mockClearNoteReceived).not.toHaveBeenCalled();
    expect(mockClaimable).toEqual([note('a'), note('b')]);
    view.unmount();

    mockInitiateConsumeBatch.mockRejectedValueOnce(new Error('batch enqueue failed'));
    mockInitiateConsume
      .mockRejectedValueOnce(new ClaimFeeRefusedError())
      .mockRejectedValueOnce(new ClaimFeeRefusedError());
    const fallback = render(<NativeNoteAutoConsumeManager />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(mockInitiateConsume).toHaveBeenCalledTimes(2);
    expect(mockStartBg).not.toHaveBeenCalled();
    expect(mockClearNoteReceived).not.toHaveBeenCalled();
    fallback.unmount();

    mockInitiateConsumeBatch.mockRejectedValueOnce(new Error('batch enqueue failed'));
    mockInitiateConsume.mockRejectedValueOnce(new ClaimFeeRefusedError());
    render(<NativeNoteAutoConsumeManager />);
    await waitFor(() => expect(mockStartBg).toHaveBeenCalledTimes(1));
    expect(mockInitiateConsume).toHaveBeenCalledTimes(4);
    expect(mockClearNoteReceived).toHaveBeenCalledTimes(1);
  });

  it('does not auto-consume a native backlog worth less than the fee to claim it', async () => {
    // Auto-consume runs unattended, so claiming for more in fee than it yields silently
    // moves the balance DOWN. The whole backlog is ONE transaction paying ONE fee, so
    // the BATCH TOTAL is what must clear the floor -- a pile of dust that sums to less
    // than one transaction's cost must not be swept.
    mockBaseFee = 10000;
    mockClaimable = [
      note('dust', 'native-faucet', { amount: '1' }),
      note('overBaseFee', 'native-faucet', { amount: String(10000 + 1) })
    ];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockGetFaucetIdSetting).toHaveBeenCalled());
    expect(mockInitiateConsumeBatch).not.toHaveBeenCalled();
  });

  it('auto-consumes a backlog of individually-marginal notes, at most MAX_NOTES_PER_UNATTENDED_CLAIM to a transaction', async () => {
    // The stranding bug: judged per note these were ALL refused, yet they total well
    // above one transaction's cost. Over the claim cap the backlog is several transactions
    // (#1644), each measured on its own: the two full chunks of 8 are worth 40 fees each and
    // go, the 4 left over are worth exactly the floor and wait for more notes.
    mockBaseFee = 10000;
    mockClaimable = Array.from({ length: 20 }, (_unused, index) =>
      note(`n${String(index).padStart(2, '0')}`, 'native-faucet', { amount: String(10000 * 5) })
    );

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockStartBg).toHaveBeenCalled());
    expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(2);
    expect(mockInitiateConsumeBatch.mock.calls[0]![1].map((n: any) => n.id)).toEqual(
      Array.from({ length: 8 }, (_unused, index) => `n${String(index).padStart(2, '0')}`)
    );
    expect(mockInitiateConsumeBatch.mock.calls[1]![1]).toHaveLength(8);
  });

  it('auto-consumes every native note on a chain that charges no fee', async () => {
    mockBaseFee = 0;
    mockClaimable = [note('a', 'native-faucet', { amount: '1' }), note('b', 'native-faucet', { amount: '2' })];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1));
    expect(mockInitiateConsumeBatch.mock.calls[0]![1].map((n: any) => n.id)).toEqual(['a', 'b']);
  });

  it('claims exactly the eligible native notes, in one transaction, skipping the rest', async () => {
    mockClaimable = [
      note('n1'), // native ✓
      note('n1b'), // native ✓ (second eligible so per-note vs batch is distinguishable)
      note('n2', 'other-faucet'), // wrong faucet ✗
      note('n3', 'native-faucet', { swapOrder: { orderId: 'x' } }), // swap-managed ✗
      note('n4', 'native-faucet', { isBeingClaimed: true }) // already claiming ✗
    ];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalledTimes(1));
    expect(mockInitiateConsumeBatch.mock.calls[0]![0]).toBe('pk-1');
    // Exactly the two eligible native notes — never n2/n3/n4 — and in ONE tx.
    expect(new Set(mockInitiateConsumeBatch.mock.calls[0]![1].map((n: any) => n.id))).toEqual(new Set(['n1', 'n1b']));
    expect(mockStartBg).toHaveBeenCalled();
  });

  it('clears the stale claim notification after auto-claiming native notes off-Home (#459)', async () => {
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalled());
    // This route-independent consumer must dismiss the "click to claim"
    // notification too — it's the path that runs when the user isn't on Home.
    await waitFor(() => expect(mockClearNoteReceived).toHaveBeenCalled());
  });

  it('does not clear the notification when there are no eligible native notes', async () => {
    mockClaimable = [note('n2', 'other-faucet')]; // wrong faucet -> nothing to consume

    render(<NativeNoteAutoConsumeManager />);

    // Give the tick a chance to run and bail.
    await waitFor(() => expect(mockGetFaucetIdSetting).toHaveBeenCalled());
    expect(mockInitiateConsumeBatch).not.toHaveBeenCalled();
    expect(mockClearNoteReceived).not.toHaveBeenCalled();
  });

  it('does not kick the tx processor when nothing needs driving (all deduped)', async () => {
    mockGetUncompleted.mockResolvedValue([]); // no uncompleted work after enqueue
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalled());
    expect(mockStartBg).not.toHaveBeenCalled();
  });

  it('follows the user local/delegated proving setting', async () => {
    mockDelegate = false; // user picked LOCAL proving
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalled());
    expect(mockInitiateConsumeBatch.mock.calls[0]![2]).toBe(false);
  });

  it('does not auto-consume when the preference cannot be read', async () => {
    mockUseRealSettings = true;
    mockClaimable = [note('n1')];
    Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
    render(<NativeNoteAutoConsumeManager />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(mockInitiateConsumeBatch).not.toHaveBeenCalled();
  });

  it('proves locally when the delegated-proving preference cannot be read', async () => {
    mockUseRealSettings = true;
    mockClaimable = [note('n1')];
    localStorage.removeItem(AUTO_CONSUME_STORAGE_KEY);
    localStorage.setItem(DELEGATE_PROOF_STORAGE_KEY, '{broken');
    render(<NativeNoteAutoConsumeManager />);
    await waitFor(() => expect(mockInitiateConsumeBatch).toHaveBeenCalled());
    expect(mockInitiateConsumeBatch.mock.calls[0]![2]).toBe(false);
  });

  it('is a no-op on the extension (the service worker owns that path)', async () => {
    mockExtension = true;
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockInitiateConsumeBatch).not.toHaveBeenCalled();
  });

  it('is a no-op when auto-consume is disabled', async () => {
    mockAutoConsume = false;
    mockClaimable = [note('n1')];

    render(<NativeNoteAutoConsumeManager />);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockInitiateConsumeBatch).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  mockLegacyFeeIdentity = undefined;
  mockBaseFee = 0;
});
