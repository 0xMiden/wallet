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
const mockDates = new Map<string, number>();
const mockClaim = {
  account: { publicKey: 'account' },
  safeClaimableNotes: [note],
  isFetchingNotes: false,
  isDelegatedProvingEnabled: false,
  claimingNoteIds: new Set<string>(),
  checkingNoteIds: new Set<string>(),
  invalidNoteIds: new Set<string>(),
  retriableNoteIds: new Set<string>()
};

jest.mock('./useClaimNotes', () => ({ useClaimNotes: () => mockClaim }));
jest.mock('app/hooks/useActivityNoteDates', () => ({ useActivityNoteDates: () => mockDates }));
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
  mockQueue.mockReset();
  mockRead.mockReset();
  mockStart.mockReset();
  mockRequest.mockReset();
  mockQueueMany.mockReset();
  mockFlags.extension = false;
  mockClaim.safeClaimableNotes = [note];
  mockClaim.isFetchingNotes = false;
  mockClaim.isDelegatedProvingEnabled = false;
  mockClaim.claimingNoteIds = new Set();
  mockClaim.checkingNoteIds = new Set();
  mockClaim.invalidNoteIds = new Set();
  mockClaim.retriableNoteIds = new Set();
  mockDates.clear();
  mockQueue.mockResolvedValue('tx-one');
  mockQueueMany.mockResolvedValue('tx-batch');
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

it('projects every live note state and uses live, stored, then stable fallback dates', () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  const live = { ...note, id: 'live', receivedAt: 123, isBeingClaimed: true };
  const claimed = { ...note, id: 'claimed' };
  const checking = { ...note, id: 'checking' };
  const unavailable = { ...note, id: 'unavailable' };
  const failed = { ...note, id: 'failed' };
  const fallback = { ...note, id: 'fallback' };
  mockClaim.safeClaimableNotes = [live, claimed, checking, unavailable, failed, fallback];
  mockClaim.claimingNoteIds.add(claimed.id);
  mockClaim.checkingNoteIds.add(checking.id);
  mockClaim.invalidNoteIds.add(unavailable.id);
  mockClaim.retriableNoteIds.add(failed.id);
  mockDates.set(claimed.id, 456);

  const { result, rerender } = renderHook(() => useActivityClaims());
  expect(result.current.items.map(item => [item.note.id, item.status, item.note.receivedAt])).toEqual([
    ['live', 'claiming', 123],
    ['claimed', 'claiming', 456],
    ['checking', 'checking', 1_700_000_000],
    ['unavailable', 'unavailable', 1_700_000_000],
    ['failed', 'failed', 1_700_000_000],
    ['fallback', 'pending', 1_700_000_000]
  ]);

  now.mockReturnValue(1_800_000_000_000);
  rerender();
  expect(result.current.items.find(item => item.note.id === fallback.id)?.note.receivedAt).toBe(1_700_000_000);
  now.mockRestore();
});

it('records a failed transaction and derives its single note from noteId', async () => {
  mockRead.mockResolvedValue({ status: 3, noteId: note.id, completedAt: 321 });
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.accept(note);
  });
  await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));
  expect(result.current.items[0]).toMatchObject({ claimedAt: 321, replaceHistoryRow: true });
});

it('leaves a queued claim active when its status cannot be read', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockRead.mockRejectedValue(new Error('Read failed'));
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.accept(note);
  });
  await waitFor(() => expect(mockRead).toHaveBeenCalled());
  expect(result.current.items[0]?.status).toBe('claiming');
  log.mockRestore();
});

it('rejects cached and unknown notes before queueing', async () => {
  const cached = { ...note, fromCache: true };
  mockClaim.safeClaimableNotes = [cached];
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.accept(cached);
    await result.current.accept({ ...note, id: 'unknown' });
  });
  expect(mockQueue).not.toHaveBeenCalled();
});

it('marks every note in a failed batch retryable and does not wake a worker', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const first = { ...note, id: 'first' };
  const second = { ...note, id: 'second' };
  mockClaim.safeClaimableNotes = [first, second];
  mockQueueMany.mockRejectedValue(new Error('Queue failed'));
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.acceptMany([first, second]);
  });
  expect(result.current.items.map(item => item.status)).toEqual(['failed', 'failed']);
  expect(mockQueueMany).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
  log.mockRestore();
});

it('filters cached and busy notes from a batch and wakes the extension worker', async () => {
  mockFlags.extension = true;
  const cached = { ...note, id: 'cached', fromCache: true };
  const accepted = { ...note, id: 'accepted' };
  mockClaim.safeClaimableNotes = [cached, accepted];
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await Promise.all([result.current.acceptMany([cached, accepted]), result.current.acceptMany([accepted])]);
  });
  expect(mockQueueMany).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
});

it('groups notes from the same faucet and keeps them queued if the worker wake-up fails', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const first = { ...note, id: 'first' };
  const second = { ...note, id: 'second' };
  mockClaim.safeClaimableNotes = [first, second];
  mockStart.mockImplementationOnce(() => {
    throw new Error('Wake-up failed');
  });
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.acceptMany([first, second]);
  });
  expect(mockQueueMany).toHaveBeenCalledWith('account', [first, second], false, true);
  expect(result.current.items.map(item => item.status)).toEqual(['claiming', 'claiming']);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

it('does not publish a single claim transaction id after unmount', async () => {
  let releaseQueue: (txId: string) => void = () => {};
  mockQueue.mockImplementationOnce(
    () =>
      new Promise<string>(resolve => {
        releaseQueue = resolve;
      })
  );
  const { result, unmount } = renderHook(() => useActivityClaims());

  let claim: Promise<void> = Promise.resolve();
  act(() => {
    claim = result.current.accept(note);
  });
  unmount();
  await act(async () => {
    releaseQueue('late-transaction');
    await claim;
  });
  expect(mockStart).toHaveBeenCalledTimes(1);
});

it('does not replace history when a completed transaction has no note references', async () => {
  mockRead.mockResolvedValue({ status: 2 });
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.accept(note);
  });
  await waitFor(() => expect(result.current.items[0]?.status).toBe('claimed'));
  expect(result.current.items[0]?.replaceHistoryRow).toBe(false);
});

it('queues only failed notes when a batch also contains unknown and checking notes', async () => {
  const checking = { ...note, id: 'checking' };
  const failed = { ...note, id: 'failed' };
  mockClaim.safeClaimableNotes = [checking, failed];
  mockClaim.checkingNoteIds.add(checking.id);
  mockClaim.retriableNoteIds.add(failed.id);
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.acceptMany([{ ...note, id: 'unknown' }, checking, failed]);
  });
  expect(mockQueueMany).toHaveBeenCalledWith('account', [failed], false, true);
});

it('lets a live checking state take priority over an old failed attempt', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockQueue.mockRejectedValueOnce(new Error('Queue failed'));
  const { result, rerender } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });

  mockClaim.checkingNoteIds.add(note.id);
  rerender();
  expect(result.current.items[0]?.status).toBe('checking');
  log.mockRestore();
});

it('reports note loading while the live fetch is active', () => {
  mockClaim.isFetchingNotes = true;
  const { result } = renderHook(() => useActivityClaims());
  expect(result.current.isLoadingNotes).toBe(true);
});

it('does not publish batch results that settle after unmount', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const first = { ...note, id: 'first', faucetId: 'first-faucet' };
  const second = { ...note, id: 'second', faucetId: 'second-faucet' };
  mockClaim.safeClaimableNotes = [first, second];
  let releaseFirst: (txId: string) => void = () => {};
  mockQueueMany
    .mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          releaseFirst = resolve;
        })
    )
    .mockRejectedValueOnce(new Error('Late queue failure'));
  const { result, unmount } = renderHook(() => useActivityClaims());

  let batch: Promise<void> = Promise.resolve();
  act(() => {
    batch = result.current.acceptMany([first, second]);
  });
  unmount();
  await act(async () => {
    releaseFirst('late-transaction');
    await batch;
  });
  expect(mockQueueMany).toHaveBeenCalledTimes(2);
  expect(mockStart).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

it('ignores a claim status read that settles after unmount', async () => {
  let releaseRead: (transaction: { status: number }) => void = () => {};
  mockRead.mockImplementationOnce(
    () =>
      new Promise<{ status: number }>(resolve => {
        releaseRead = resolve;
      })
  );
  const { result, unmount } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  await waitFor(() => expect(mockRead).toHaveBeenCalled());

  unmount();
  await act(async () => releaseRead({ status: 2 }));
});
