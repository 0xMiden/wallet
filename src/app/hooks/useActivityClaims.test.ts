import { act, renderHook, waitFor } from '@testing-library/react';

import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';

import { useActivityClaims } from './useActivityClaims';

const note: NoteWithMetadata = {
  id: 'note-one',
  faucetId: 'faucet',
  amount: '1000000',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: 'unknown',
  metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
};
const mockQueue = jest.fn();
const mockRead = jest.fn();
const mockStart = jest.fn();
const mockRequest = jest.fn();
const mockQueueMany = jest.fn();
const mockFlags = { extension: false };
const mockClaim = {
  account: { publicKey: 'account' },
  safeClaimableNotes: [note],
  isDelegatedProvingEnabled: false,
  claimingNoteIds: new Set<string>(),
  checkingNoteIds: new Set<string>(),
  invalidNoteIds: new Set<string>(),
  retriableNoteIds: new Set<string>()
};

jest.mock('./useClaimNotes', () => ({ useClaimNotes: () => mockClaim }));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'faucet-native' }));
jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: (...args: Parameters<typeof mockQueue>) => mockQueue(...args),
  initiateConsumeNotesTransaction: (...args: Parameters<typeof mockQueueMany>) => mockQueueMany(...args),
  getTransactionById: (...args: Parameters<typeof mockRead>) => mockRead(...args),
  startBackgroundTransactionProcessing: (...args: Parameters<typeof mockStart>) => mockStart(...args),
  requestSWTransactionProcessing: () => mockRequest()
}));
jest.mock('lib/miden/db/types', () => ({
  ITransactionStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3 }
}));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => ({ signTransaction: jest.fn() }) }));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/platform', () => ({ isExtension: () => mockFlags.extension }));

beforeEach(() => {
  jest.clearAllMocks();
  mockFlags.extension = false;
  mockClaim.safeClaimableNotes = [note];
  mockClaim.invalidNoteIds.clear();
  mockClaim.checkingNoteIds.clear();
  mockQueue.mockResolvedValue('tx-one');
  mockRead.mockResolvedValue({ status: 0 });
});

it('queues only once when the carousel and list accept the same note together', async () => {
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await Promise.all([result.current.accept(note), result.current.accept(note)]);
  });
  expect(mockQueue).toHaveBeenCalledTimes(1);
  expect(mockQueue).toHaveBeenCalledWith('account', note, false, true);
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(result.current.items[0]?.status).toBe('claiming');
});

it('keeps a claimed receipt after the note leaves the pending data', async () => {
  mockRead.mockResolvedValue({ status: 2, noteIds: ['note-one'], completedAt: 123 });
  const { result, rerender } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  await waitFor(() => expect(result.current.items[0]?.status).toBe('claimed'));
  mockClaim.safeClaimableNotes = [];
  rerender();
  expect(result.current.items[0]).toMatchObject({ txId: 'tx-one', claimedAt: 123, replaceHistoryRow: true });
});

it('does not replace a history row that contains other notes', async () => {
  mockRead.mockResolvedValue({ status: 2, noteIds: ['note-one', 'note-two'] });
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  await waitFor(() => expect(result.current.items[0]?.status).toBe('claimed'));
  expect(result.current.items[0]?.replaceHistoryRow).toBe(false);
});

it('allows retry after queue failure and uses the worker on extension', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockFlags.extension = true;
  mockQueue.mockRejectedValueOnce(new Error('Queue failed'));
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  expect(result.current.items[0]?.status).toBe('failed');
  await act(async () => {
    await result.current.accept(note);
  });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
  log.mockRestore();
});

it('does not accept notes during validation or after an invalid-note result', async () => {
  mockClaim.checkingNoteIds.add(note.id);
  const { result, rerender } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  mockClaim.checkingNoteIds = new Set();
  mockClaim.invalidNoteIds = new Set([note.id]);
  rerender();
  await act(async () => {
    await result.current.accept(note);
  });
  expect(mockQueue).not.toHaveBeenCalled();
});

it('keeps a queued claim active if the processing wake-up fails', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockStart.mockImplementationOnce(() => {
    throw new Error('Wake-up failed');
  });
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  expect(result.current.items[0]).toMatchObject({ status: 'claiming', txId: 'tx-one' });
  await act(async () => {
    await result.current.accept(note);
  });
  expect(mockQueue).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

it('marks every batch note as claiming at once and queues the native faucet group first', async () => {
  const tokenNote = { ...note, id: 'note-token', faucetId: 'faucet-token' };
  const nativeNote = { ...note, id: 'note-native', faucetId: 'faucet-native' };
  mockClaim.safeClaimableNotes = [tokenNote, nativeNote];
  let releaseFirst: (txId: string) => void = () => {};
  mockQueueMany
    .mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          releaseFirst = resolve;
        })
    )
    .mockResolvedValueOnce('tx-token');
  const { result } = renderHook(() => useActivityClaims());

  let batch: Promise<void> = Promise.resolve();
  act(() => {
    batch = result.current.acceptMany([tokenNote, nativeNote]);
  });
  expect(result.current.items.map(item => item.status)).toEqual(['claiming', 'claiming']);
  expect(mockQueueMany).toHaveBeenCalledTimes(1);
  expect(mockQueueMany.mock.calls[0]?.[1]).toEqual([nativeNote]);

  await act(async () => {
    releaseFirst('tx-native');
    await batch;
  });
  expect(mockQueueMany.mock.calls[1]?.[1]).toEqual([tokenNote]);
  expect(result.current.items.find(item => item.note.id === 'note-native')?.txId).toBe('tx-native');
  expect(result.current.items.find(item => item.note.id === 'note-token')?.txId).toBe('tx-token');
  expect(mockStart).toHaveBeenCalledTimes(1);
});
