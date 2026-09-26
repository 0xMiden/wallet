import { act, renderHook } from '@testing-library/react';

import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';

import { __resetActivityClaimsForTest, useActivityClaims } from './useActivityClaims';

const note: ClaimableNoteWithMetadata = {
  id: 'note-one',
  faucetId: 'faucet',
  amount: '1000000',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: 'unknown',
  metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
};
type MockRow = { id: string; status: number; completedAt?: number };
const mockQueue = jest.fn();
const mockStart = jest.fn();
const mockRequest = jest.fn();
const mockQueueMany = jest.fn();
const mockAnyOf = jest.fn();
const mockSubscriptions: Array<{
  query: () => Promise<unknown>;
  observer: { next: (rows: MockRow[]) => void; error: (error: unknown) => void };
  unsubscribe: jest.Mock;
}> = [];
const mockFlags = { extension: false };
const mockEndpoint = { rpc: 'rpc', network: 'testnet' };
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
// The real reporter runs; telemetry records how each note_handle flow ended.
const mockReported: Array<'ok' | 'failed' | 'cancelled'> = [];
jest.mock('lib/telemetry', () => ({
  beginFlow: () => ({
    complete: () => mockReported.push('ok'),
    fail: () => mockReported.push('failed'),
    cancel: () => mockReported.push('cancelled'),
    step: () => {}
  }),
  classifyError: () => 'unknown'
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'faucet-native' }));
jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: (...args: Parameters<typeof mockQueue>) => mockQueue(...args),
  initiateConsumeNotesTransaction: (...args: Parameters<typeof mockQueueMany>) => mockQueueMany(...args),
  startBackgroundTransactionProcessing: (...args: Parameters<typeof mockStart>) => mockStart(...args),
  requestSWTransactionProcessing: () => mockRequest()
}));
jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (query: () => Promise<unknown>, observer: (typeof mockSubscriptions)[number]['observer']) => {
    const unsubscribe = jest.fn();
    mockSubscriptions.push({ query, observer, unsubscribe });
    return unsubscribe;
  }
}));
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: (field: string) => ({ anyOf: (ids: string[]) => ({ toArray: () => mockAnyOf(field, ids) }) })
  }
}));
jest.mock('lib/miden/db/types', () => ({
  ITransactionStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3 }
}));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => ({ signTransaction: jest.fn() }) }));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/platform', () => ({ isExtension: () => mockFlags.extension }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => mockEndpoint.rpc,
  getEffectiveNetworkName: () => mockEndpoint.network
}));

function latestSubscription() {
  const subscription = mockSubscriptions[mockSubscriptions.length - 1];
  if (!subscription) throw new Error('No claim status subscription');
  return subscription;
}

function settle(rows: MockRow[]) {
  act(() => latestSubscription().observer.next(rows));
}

beforeEach(() => {
  mockQueue.mockReset();
  mockStart.mockReset();
  mockRequest.mockReset();
  mockQueueMany.mockReset();
  mockAnyOf.mockReset();
  mockSubscriptions.length = 0;
  mockReported.length = 0;
  mockFlags.extension = false;
  __resetActivityClaimsForTest();
  mockEndpoint.rpc = 'rpc';
  mockEndpoint.network = 'testnet';
  mockClaim.account = { publicKey: 'account' };
  mockClaim.safeClaimableNotes = [note];
  mockClaim.isFetchingNotes = false;
  mockClaim.isDelegatedProvingEnabled = false;
  mockClaim.claimingNoteIds = new Set();
  mockClaim.checkingNoteIds = new Set();
  mockClaim.invalidNoteIds = new Set();
  mockClaim.retriableNoteIds = new Set();
  mockQueue.mockResolvedValue('tx-one');
  mockQueueMany.mockResolvedValue('tx-batch');
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
  const { result, rerender } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  settle([{ id: 'tx-one', status: 2, completedAt: 123 }]);
  expect(result.current.items[0]?.status).toBe('claimed');
  mockClaim.safeClaimableNotes = [];
  rerender();
  expect(result.current.items[0]).toMatchObject({ txId: 'tx-one', claimedAt: 123 });
});

it('drops a failed attempt once its note leaves the live list, so neither Retry nor Accept All can queue it', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const other = { ...note, id: 'note-two' };
  mockClaim.safeClaimableNotes = [note, other];
  mockQueue.mockRejectedValueOnce(new Error('Queue failed'));
  const { result, rerender } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  expect(result.current.items.find(item => item.note.id === note.id)?.status).toBe('failed');

  mockClaim.safeClaimableNotes = [other];
  rerender();
  expect(result.current.items.map(item => item.note.id)).toEqual(['note-two']);
  await act(async () => {
    await result.current.accept(note);
    await result.current.acceptMany([note, other]);
  });
  expect(mockQueue).toHaveBeenCalledTimes(1);
  expect(mockQueueMany).toHaveBeenCalledWith('account', [other], false, true);
  log.mockRestore();
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

it('marks every batch note as claiming at once, queues the native faucet group first and settles each group on its own', async () => {
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
  expect(mockSubscriptions).toHaveLength(0);

  await act(async () => {
    releaseFirst('tx-native');
    await batch;
  });
  expect(mockQueueMany.mock.calls[1]?.[1]).toEqual([tokenNote]);
  expect(result.current.items.find(item => item.note.id === 'note-native')?.txId).toBe('tx-native');
  expect(result.current.items.find(item => item.note.id === 'note-token')?.txId).toBe('tx-token');
  expect(mockStart).toHaveBeenCalledTimes(1);

  // A row still being generated settles nothing.
  const unsettled = result.current.items;
  settle([{ id: 'tx-native', status: 1 }]);
  expect(result.current.items).toBe(unsettled);

  settle([
    { id: 'tx-native', status: 2, completedAt: 50 },
    { id: 'tx-token', status: 1 }
  ]);
  expect(result.current.items.find(item => item.note.id === 'note-native')?.status).toBe('claimed');
  expect(result.current.items.find(item => item.note.id === 'note-token')?.status).toBe('claiming');

  // A later emission still lists the settled native row; only the token claim changes.
  settle([
    { id: 'tx-native', status: 2, completedAt: 50 },
    { id: 'tx-token', status: 3, completedAt: 60 }
  ]);
  expect(result.current.items.find(item => item.note.id === 'note-native')).toMatchObject({
    status: 'claimed',
    claimedAt: 50
  });
  expect(result.current.items.find(item => item.note.id === 'note-token')).toMatchObject({
    status: 'failed',
    claimedAt: 60
  });
});

it('projects every live note state and leaves an undated note undated', () => {
  // A claim in flight is read from the note's own row (`isBeingClaimed`, written the moment the
  // consume is enqueued), not from a set the retired batch claimer used to keep in memory.
  const live = { ...note, id: 'live', receivedAt: 123, isBeingClaimed: true };
  const checking = { ...note, id: 'checking' };
  const unavailable = { ...note, id: 'unavailable' };
  const failed = { ...note, id: 'failed' };
  const pending = { ...note, id: 'pending' };
  mockClaim.safeClaimableNotes = [live, checking, unavailable, failed, pending];
  mockClaim.checkingNoteIds.add(checking.id);
  mockClaim.invalidNoteIds.add(unavailable.id);
  mockClaim.retriableNoteIds.add(failed.id);

  const { result } = renderHook(() => useActivityClaims());
  expect(result.current.items.map(item => [item.note.id, item.status, item.note.receivedAt])).toEqual([
    ['live', 'claiming', 123],
    ['checking', 'checking', undefined],
    ['unavailable', 'unavailable', undefined],
    ['failed', 'failed', undefined],
    ['pending', 'pending', undefined]
  ]);
});

it('records a failed transaction and lets the note be retried', async () => {
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  settle([{ id: 'tx-one', status: 3, completedAt: 321 }]);
  expect(result.current.items[0]).toMatchObject({ status: 'failed', claimedAt: 321 });
  await act(async () => {
    await result.current.accept(note);
  });
  expect(mockQueue).toHaveBeenCalledTimes(2);
});

it('leaves a queued claim active when its status cannot be read', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.accept(note);
  });
  act(() => latestSubscription().observer.error(new Error('Read failed')));
  expect(result.current.items[0]?.status).toBe('claiming');
  expect(log).toHaveBeenCalledWith('[activity] Could not read claim status', expect.any(Error));
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
  expect(mockQueueMany).toHaveBeenCalledWith('account', [accepted], false, true);
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

  mockClaim.checkingNoteIds = new Set([note.id]);
  rerender();
  expect(result.current.items[0]?.status).toBe('checking');
  log.mockRestore();
});

it('reports note loading while the live fetch is active', () => {
  mockClaim.isFetchingNotes = true;
  const { result } = renderHook(() => useActivityClaims());
  expect(result.current.isLoadingNotes).toBe(true);
});

it('watches only the queued claim rows and stops watching on unmount', async () => {
  mockAnyOf.mockResolvedValue([]);
  const { result, unmount } = renderHook(() => useActivityClaims());
  expect(mockSubscriptions).toHaveLength(0);
  await act(async () => {
    await result.current.accept(note);
  });
  const subscription = latestSubscription();
  await subscription.query();
  expect(mockAnyOf).toHaveBeenCalledWith('id', ['tx-one']);
  unmount();
  expect(subscription.unsubscribe).toHaveBeenCalled();
});

it('keeps a cached note listed as pending while the claim check runs, since it cannot be accepted anyway', () => {
  const cached = { ...note, id: 'cached', fromCache: true };
  mockClaim.safeClaimableNotes = [cached, note];
  mockClaim.checkingNoteIds = new Set([cached.id, note.id]);
  const { result } = renderHook(() => useActivityClaims());
  expect(result.current.items.map(item => [item.note.id, item.status])).toEqual([
    ['cached', 'pending'],
    ['note-one', 'checking']
  ]);
});

describe('a claim shared across the Activity views', () => {
  function deferQueue(mock: jest.Mock) {
    let release: (txId: string) => void = () => {};
    mock.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = resolve;
        })
    );
    return (txId: string) => release(txId);
  }

  it('does not queue a note again after a view switch while its first claim is still being queued', async () => {
    const release = deferQueue(mockQueue);
    const first = renderHook(() => useActivityClaims());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = first.result.current.accept(note);
    });
    first.unmount();

    const second = renderHook(() => useActivityClaims());
    expect(second.result.current.items[0]?.status).toBe('claiming');
    await act(async () => {
      await second.result.current.accept(note);
    });
    await act(async () => {
      release('tx-one');
      await pending;
    });
    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(second.result.current.items[0]).toMatchObject({ status: 'claiming', txId: 'tx-one' });
  });

  it('does not queue a batch note again after a view switch', async () => {
    const release = deferQueue(mockQueueMany);
    const first = renderHook(() => useActivityClaims());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = first.result.current.acceptMany([note]);
    });
    first.unmount();

    const second = renderHook(() => useActivityClaims());
    await act(async () => {
      await second.result.current.acceptMany([note]);
    });
    await act(async () => {
      release('tx-batch');
      await pending;
    });
    expect(mockQueueMany).toHaveBeenCalledTimes(1);
  });

  it('does not queue a note from a batch while another view is queueing it alone, or the reverse', async () => {
    const release = deferQueue(mockQueue);
    const list = renderHook(() => useActivityClaims());
    const groups = renderHook(() => useActivityClaims());
    // Both taps land before either view re-renders, so only the shared reservation can stop the second.
    let single: Promise<void> = Promise.resolve();
    let batch: Promise<void> = Promise.resolve();
    act(() => {
      single = list.result.current.accept(note);
      batch = groups.result.current.acceptMany([note]);
    });
    await act(async () => {
      release('tx-one');
      await Promise.all([single, batch]);
    });
    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(mockQueueMany).not.toHaveBeenCalled();

    const other = { ...note, id: 'note-two' };
    mockClaim.safeClaimableNotes = [note, other];
    list.rerender();
    groups.rerender();
    const releaseBatch = deferQueue(mockQueueMany);
    act(() => {
      batch = groups.result.current.acceptMany([other]);
      single = list.result.current.accept(other);
    });
    await act(async () => {
      releaseBatch('tx-batch');
      await Promise.all([single, batch]);
    });
    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(mockQueueMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['account', () => (mockClaim.account = { publicKey: 'account-other' })],
    ['RPC endpoint', () => (mockEndpoint.rpc = `${mockEndpoint.rpc}-other`)],
    ['network', () => (mockEndpoint.network = 'devnet')]
  ])('keeps the claims of another %s apart', async (_part, change) => {
    const release = deferQueue(mockQueue);
    const first = renderHook(() => useActivityClaims());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = first.result.current.accept(note);
    });
    first.unmount();

    change();
    const second = renderHook(() => useActivityClaims());
    expect(second.result.current.items[0]?.status).toBe('pending');
    await act(async () => {
      await second.result.current.accept(note);
    });
    await act(async () => {
      release('tx-first');
      await pending;
    });
    expect(mockQueue).toHaveBeenCalledTimes(2);
  });
});

describe('note_handle reporting', () => {
  it('reports an accepted note as one attempt around its queue call', async () => {
    const { result } = renderHook(() => useActivityClaims());
    await act(async () => {
      await result.current.accept(note);
    });
    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(mockReported).toEqual(['ok']);
  });

  it('lets the reporter see a queue-time failure the hook then absorbs', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQueue.mockRejectedValue(new Error('queue failed'));
    const { result } = renderHook(() => useActivityClaims());
    await act(async () => {
      await result.current.accept(note);
    });
    expect(mockReported).toEqual(['failed']);
    expect(result.current.items[0]?.status).toBe('failed');
    log.mockRestore();
  });

  it('reports each faucet group of Accept All as its own attempt', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const other = { ...note, id: 'note-two', faucetId: 'other-faucet' };
    mockClaim.safeClaimableNotes = [note, other];
    mockQueueMany.mockResolvedValueOnce('tx-batch').mockRejectedValueOnce(new Error('queue failed'));
    const { result } = renderHook(() => useActivityClaims());
    await act(async () => {
      await result.current.acceptMany([note, other]);
    });
    expect(mockQueueMany).toHaveBeenCalledTimes(2);
    expect(mockReported).toEqual(['ok', 'failed']);
    log.mockRestore();
  });

  it('completes an accept whose view was switched before the queue call resolved', async () => {
    let queued = (_txId: string) => {};
    mockQueue.mockReturnValue(new Promise<string>(resolve => (queued = resolve)));
    const list = renderHook(() => useActivityClaims());
    let accepting: Promise<void> = Promise.resolve();
    act(() => {
      accepting = list.result.current.accept(note);
    });
    // AllHistory renders one view or the other, so a List/Groups switch unmounts this hook and mounts another.
    list.unmount();
    renderHook(() => useActivityClaims());
    await act(async () => {
      queued('tx-1');
      await accepting;
    });
    expect(mockReported).toEqual(['ok']);
  });

  it('completes each Accept All group whose view was switched before it queued', async () => {
    const other = { ...note, id: 'note-two', faucetId: 'other-faucet' };
    mockClaim.safeClaimableNotes = [note, other];
    let queued = (_txId: string) => {};
    mockQueueMany.mockReturnValueOnce(new Promise<string>(resolve => (queued = resolve))).mockResolvedValueOnce('tx-2');
    const list = renderHook(() => useActivityClaims());
    let accepting: Promise<void> = Promise.resolve();
    act(() => {
      accepting = list.result.current.acceptMany([note, other]);
    });
    list.unmount();
    renderHook(() => useActivityClaims());
    await act(async () => {
      queued('tx-1');
      await accepting;
    });
    expect(mockQueueMany).toHaveBeenCalledTimes(2);
    expect(mockReported).toEqual(['ok', 'ok']);
  });
});
