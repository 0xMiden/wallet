import { act, renderHook } from '@testing-library/react';

import { TEST_NATIVE_ETH_FAUCET } from 'lib/epoch/testing/bridge-config';
import { claimFeeShortfalls } from 'lib/miden/fees/spendable';
import type { TokenBalanceData } from 'lib/miden/front/balance';
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
type MockRow = { id: string; status: number; completedAt?: number; held?: boolean };
const mockQueue = jest.fn();
const mockRequeue = jest.fn();
const mockStart = jest.fn();
const mockRequest = jest.fn();
const mockQueueMany = jest.fn();
// What Accept and Accept All pass after their notes: delegate, manualRetry, and what queued the row.
const ACCEPTS = [false, true, 'claim'] as const;
const ACCEPTS_ALL = [false, true, undefined, undefined, 'claim_all'] as const;
const mockAnyOf = jest.fn();
const mockSubscriptions: Array<{
  query: () => Promise<unknown>;
  observer: { next: (rows: MockRow[]) => void; error: (error: unknown) => void };
  unsubscribe: jest.Mock;
}> = [];
const mockFlags = { extension: false };
const mockEndpoint = { rpc: 'rpc', network: 'testnet' };
let mockFeeCopy = 'worker-fee-copy';
jest.mock('lib/i18n', () => ({
  ...jest.requireActual('lib/i18n'),
  getMessage: (key: string) => (key === 'insufficientFeeAsset' ? mockFeeCopy : key)
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (key === 'insufficientFeeAsset' ? mockFeeCopy : key) })
}));
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

jest.mock('./useClaimNotes', () => ({
  useClaimNotes: () => {
    const { useMemo } = jest.requireActual<typeof import('react')>('react');
    const safeClaimableNotes = useMemo(
      () => mockClaim.safeClaimableNotes.filter(note => note != null),
      [mockClaim.safeClaimableNotes]
    );
    return { ...mockClaim, safeClaimableNotes };
  }
}));
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
let mockLegacyFeeIdentity: string | undefined;
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockLegacyFeeIdentity ?? 'faucet-native'
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'faucet-native' }));
jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: (...args: Parameters<typeof mockQueue>) => mockQueue(...args),
  // The batch entry point: a test resolves it with a committed id, or with the full result when it
  // needs a note covered by a row other than the batch.
  queueConsumeNotes: (...args: Parameters<typeof mockQueueMany>) =>
    Promise.resolve(mockQueueMany(...args)).then((queued: unknown) =>
      typeof queued === 'string'
        ? { committedId: queued, coveringTxIdByNoteId: new Map<string, string>(), feeRefusedNoteIds: [] }
        : queued
    ),
  startBackgroundTransactionProcessing: (...args: Parameters<typeof mockStart>) => mockStart(...args),
  requestSWTransactionProcessing: () => mockRequest(),
  requeueFailedTransaction: (...args: unknown[]) => mockRequeue(...args),
  // The hook only asks it about rows the test settles, so the stub keys on a test-only flag.
  holdsNotes: (row: { status: number; held?: boolean }) => row.held === true
}));
jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (query: () => Promise<unknown>, observer: (typeof mockSubscriptions)[number]['observer']) => {
    const unsubscribe = jest.fn();
    mockSubscriptions.push({ query, observer, unsubscribe });
    return unsubscribe;
  }
}));
// The open bridge trackers whose saved route names the faucet that delivers them.
type MockBridgeRow = { type: string; extraInputs: Record<string, unknown> };
const mockBridgeRows: MockBridgeRow[] = [];
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: (field: string) => ({
      anyOf: (ids: string[]) => ({ toArray: () => mockAnyOf(field, ids) }),
      equals: (value: string) => ({
        filter: (predicate: (row: MockBridgeRow) => boolean) => ({
          toArray: async () => mockBridgeRows.filter(row => field === 'type' && row.type === value && predicate(row))
        })
      })
    })
  }
}));
jest.mock('lib/miden/db/types', () => ({
  ITransactionStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3, Unconfirmed: 4 }
}));
// The vault rows and the base fee the claim gate reads. A null fee fails the gate open, which every case not about
// the fee runs under.
const mockBalances: { data: TokenBalanceData[]; isLoading: boolean } = { data: [], isLoading: false };
let mockBaseFee: number | null = null;
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => mockBalances
}));
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));
// The real rule runs; the spy counts how often the hook asks it.
jest.mock('lib/miden/fees/spendable', () => {
  const actual = jest.requireActual<typeof import('lib/miden/fees/spendable')>('lib/miden/fees/spendable');
  return { ...actual, claimFeeShortfalls: jest.fn(actual.claimFeeShortfalls) };
});
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/platform', () => ({ isExtension: () => mockFlags.extension }));
// The bridge registry names its native-ETH faucet, which sends every Agglayer delivery; the SDK reads an id as itself.
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({}),
  initBridgeConfig: async () => ({})
}));
jest.mock('lib/remote-config/values', () => ({
  selectNativeEthFaucets: () => [
    jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
      .TEST_NATIVE_ETH_FAUCET
  ]
}));
jest.mock('lib/miden/sdk/helpers', () => ({ accountRefToSdk: (ref: string) => ({ toString: () => ref }) }));
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

// Accept All reads the saved delivery faucets before it groups, so its first queue call follows that read.
async function settleDeliverySenders() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mockFeeCopy = 'worker-fee-copy';
  mockQueue.mockReset();
  mockRequeue.mockReset();
  mockStart.mockReset();
  mockRequest.mockReset();
  mockQueueMany.mockReset();
  mockAnyOf.mockReset();
  mockBridgeRows.length = 0;
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
  expect(mockQueue).toHaveBeenCalledWith('account', note, ...ACCEPTS);
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
  expect(mockQueueMany).toHaveBeenCalledWith('account', [other], ...ACCEPTS_ALL);
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

it.each([false, true])(
  'fee identity: queues the actual native claim first under a legacy display override, reversed=%s',
  async reversed => {
    mockLegacyFeeIdentity = 'faucet-legacy';
    const actual = { ...note, id: 'actual-note', faucetId: 'faucet-native' };
    const legacy = { ...note, id: 'legacy-note', faucetId: 'faucet-legacy' };
    const notes = reversed ? [actual, legacy] : [legacy, actual];
    mockClaim.safeClaimableNotes = notes;
    mockQueueMany.mockResolvedValue('queued');
    const { result } = renderHook(() => useActivityClaims());
    await act(async () => {
      await result.current.acceptMany(notes);
    });
    expect(mockQueueMany.mock.calls.map(call => call[1])).toEqual([[actual], [legacy]]);
  }
);

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
  await settleDeliverySenders();
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

it('settles a batch note deduplicated onto another row with that row, not the batch it never joined', async () => {
  const covered = { ...note, id: 'note-covered' };
  const joined = { ...note, id: 'note-joined' };
  mockClaim.safeClaimableNotes = [covered, joined];
  mockQueueMany.mockResolvedValueOnce({
    committedId: 'tx-batch',
    feeRefusedNoteIds: [],
    coveringTxIdByNoteId: new Map([
      [covered.id, 'tx-live'],
      [joined.id, 'tx-batch']
    ])
  });
  const { result } = renderHook(() => useActivityClaims());
  await act(async () => {
    await result.current.acceptMany([covered, joined]);
  });

  settle([
    { id: 'tx-batch', status: 2, completedAt: 70 },
    { id: 'tx-live', status: 3, completedAt: 80 }
  ]);
  expect(result.current.items.find(item => item.note.id === covered.id)).toMatchObject({
    txId: 'tx-live',
    status: 'failed'
  });
  expect(result.current.items.find(item => item.note.id === joined.id)?.status).toBe('claimed');
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
  expect(mockQueueMany).toHaveBeenCalledWith('account', [accepted], ...ACCEPTS_ALL);
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
  expect(mockQueueMany).toHaveBeenCalledWith('account', [first, second], ...ACCEPTS_ALL);
  expect(result.current.items.map(item => item.status)).toEqual(['claiming', 'claiming']);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

it('queues each Agglayer bridge delivery in a consume of its own', async () => {
  const first = { ...note, id: 'bridge-1', senderAddress: TEST_NATIVE_ETH_FAUCET };
  const second = { ...note, id: 'bridge-2', senderAddress: TEST_NATIVE_ETH_FAUCET };
  mockClaim.safeClaimableNotes = [first, second];
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.acceptMany([first, second]);
  });
  expect(mockQueueMany).toHaveBeenCalledTimes(2);
  expect(mockQueueMany).toHaveBeenNthCalledWith(1, 'account', [first], ...ACCEPTS_ALL);
  expect(mockQueueMany).toHaveBeenNthCalledWith(2, 'account', [second], ...ACCEPTS_ALL);
});

it('queues each delivery from the faucet an open deposit saved alone after the document drops its chain', async () => {
  const savedFaucet = '0x5a7ed0000000000000000000000000';
  mockBridgeRows.push({
    type: 'bridged-receive',
    extraInputs: {
      provider: 'agglayer',
      phase: 'delivering',
      agglayerRoute: { chainId: 84532, nativeEthFaucetId: savedFaucet }
    }
  });
  const first = { ...note, id: 'saved-1', senderAddress: savedFaucet };
  const second = { ...note, id: 'saved-2', senderAddress: savedFaucet };
  mockClaim.safeClaimableNotes = [first, second];
  const { result } = renderHook(() => useActivityClaims());

  await act(async () => {
    await result.current.acceptMany([first, second]);
  });
  expect(mockQueueMany).toHaveBeenCalledTimes(2);
  expect(mockQueueMany).toHaveBeenNthCalledWith(1, 'account', [first], ...ACCEPTS_ALL);
  expect(mockQueueMany).toHaveBeenNthCalledWith(2, 'account', [second], ...ACCEPTS_ALL);
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
  expect(mockQueueMany).toHaveBeenCalledWith('account', [failed], ...ACCEPTS_ALL);
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

function deferQueueFailure(mock: jest.Mock) {
  let fail: (error: Error) => void = () => {};
  mock.mockImplementationOnce(
    () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      })
  );
  return (error: Error) => fail(error);
}

describe('a claim shared across the Activity views', () => {
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
    expect(mockReported).toEqual(['ok']);
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
    expect(mockReported).toEqual(['ok']);
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
    await settleDeliverySenders();
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

  it('reports a failed accept whose view was switched before the queue call rejected', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failQueue = deferQueueFailure(mockQueue);
    const list = renderHook(() => useActivityClaims());
    let accepting: Promise<void> = Promise.resolve();
    act(() => {
      accepting = list.result.current.accept(note);
    });
    // AllHistory renders one view or the other, so a List/Groups switch unmounts this hook and mounts another.
    list.unmount();
    const groups = renderHook(() => useActivityClaims());
    await act(async () => {
      failQueue(new Error('queue failed'));
      await accepting;
    });
    expect(mockReported).toEqual(['failed']);
    expect(groups.result.current.items[0]?.status).toBe('failed');
    log.mockRestore();
  });

  it('completes each Accept All group whose view was switched before it queued', async () => {
    const other = { ...note, id: 'note-two', faucetId: 'other-faucet' };
    mockClaim.safeClaimableNotes = [note, other];
    const queued = deferQueue(mockQueueMany);
    mockQueueMany.mockResolvedValueOnce('tx-2');
    const list = renderHook(() => useActivityClaims());
    let accepting: Promise<void> = Promise.resolve();
    act(() => {
      accepting = list.result.current.acceptMany([note, other]);
    });
    list.unmount();
    renderHook(() => useActivityClaims());
    await settleDeliverySenders();
    await act(async () => {
      queued('tx-1');
      await accepting;
    });
    expect(mockQueueMany).toHaveBeenCalledTimes(2);
    expect(mockReported).toEqual(['ok', 'ok']);
  });
});

describe('held claims (#1081)', () => {
  it('a claiming item whose row is held shows as held, from a session attempt and from a fresh mount alike', async () => {
    mockClaim.safeClaimableNotes = [{ ...note, isBeingClaimed: true, claimingTxId: 'tx-held' }];
    const { result } = renderHook(() => useActivityClaims());
    settle([{ id: 'tx-held', status: 4, held: true }]);
    expect(result.current.items[0]).toMatchObject({ status: 'claiming', txId: 'tx-held', held: true });
  });

  it('a claim the user just accepted shows as held once its row holds, so its card offers Retry', async () => {
    mockQueue.mockResolvedValue('tx-held');
    const { result } = renderHook(() => useActivityClaims());
    await act(async () => {
      await result.current.accept(note);
    });
    settle([{ id: 'tx-held', status: 4, held: true }]);
    expect(result.current.items[0]).toMatchObject({ status: 'claiming', txId: 'tx-held', held: true });
  });

  it('Retry on a held item requeues that row in place and starts processing, without a second claim', async () => {
    mockRequeue.mockResolvedValue(undefined);
    mockClaim.safeClaimableNotes = [{ ...note, isBeingClaimed: true, claimingTxId: 'tx-held' }];
    const { result } = renderHook(() => useActivityClaims());
    settle([{ id: 'tx-held', status: 4, held: true }]);
    await act(async () => {
      await result.current.retryHeld(result.current.items[0]!);
    });
    expect(mockRequeue).toHaveBeenCalledWith('tx-held');
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it('a refusal stays on the item as its message', async () => {
    mockRequeue.mockRejectedValue(
      new Error('The Guardian is still holding this transaction. You can retry it after 10:00:00.')
    );
    mockClaim.safeClaimableNotes = [{ ...note, isBeingClaimed: true, claimingTxId: 'tx-held' }];
    const { result } = renderHook(() => useActivityClaims());
    settle([{ id: 'tx-held', status: 4, held: true }]);
    await act(async () => {
      await result.current.retryHeld(result.current.items[0]!);
    });
    expect(result.current.items[0]?.retryError).toMatch(/still holding this transaction/);
  });

  it('a second Retry while the first runs does nothing, so no refusal is left behind', async () => {
    let finishFirst: () => void = () => {};
    mockRequeue
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishFirst = resolve;
          })
      )
      .mockRejectedValueOnce(new Error('Transaction tx-held (consume) is not retryable'));
    mockClaim.safeClaimableNotes = [{ ...note, isBeingClaimed: true, claimingTxId: 'tx-held' }];
    const { result } = renderHook(() => useActivityClaims());
    settle([{ id: 'tx-held', status: 4, held: true }]);
    const item = result.current.items[0]!;
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.retryHeld(item);
      second = result.current.retryHeld(item);
    });
    await act(async () => {
      finishFirst();
      await Promise.all([first, second]);
    });
    expect(mockRequeue).toHaveBeenCalledTimes(1);
    // The row runs and is held again: the later hold opens with no refusal on it.
    settle([{ id: 'tx-held', status: 1 }]);
    settle([{ id: 'tx-held', status: 4, held: true }]);
    expect(result.current.items[0]).toMatchObject({ held: true });
    expect(result.current.items[0]?.retryError).toBeUndefined();
  });

  it('forgets a refusal once the claim moves on, so a later hold starts clean', async () => {
    mockRequeue.mockRejectedValue(new Error('The Guardian is still holding this transaction.'));
    mockClaim.safeClaimableNotes = [{ ...note, isBeingClaimed: true, claimingTxId: 'tx-held' }];
    const { result } = renderHook(() => useActivityClaims());
    settle([{ id: 'tx-held', status: 4, held: true }]);
    await act(async () => {
      await result.current.retryHeld(result.current.items[0]!);
    });
    expect(result.current.items[0]?.retryError).toMatch(/still holding this transaction/);
    settle([{ id: 'tx-held', status: 0 }]);
    settle([{ id: 'tx-held', status: 4, held: true }]);
    expect(result.current.items[0]).toMatchObject({ held: true });
    expect(result.current.items[0]?.retryError).toBeUndefined();
  });

  it('a row that holds nothing settles the attempt to failed', async () => {
    mockQueue.mockResolvedValue('tx-new');
    const { result } = renderHook(() => useActivityClaims());
    await act(async () => {
      await result.current.accept(note);
    });
    settle([{ id: 'tx-new', status: 4, held: false }]);
    expect(result.current.items[0]?.status).toBe('failed');
  });
});

beforeEach(() => {
  mockLegacyFeeIdentity = undefined;
});

describe('the network fee', () => {
  // No fee asset in the vault, a base fee of 100 units, and the fixture note in another token.
  const nativeRow = (balance: number): TokenBalanceData => ({
    tokenId: 'faucet-native',
    tokenSlug: 'USDCX',
    metadata: { name: 'USDCX', symbol: 'USDCX', decimals: 6 },
    balance,
    fiatPrice: 0,
    change24h: 0
  });
  const nativeNote = (id: string, amount: string): ClaimableNoteWithMetadata => ({
    ...note,
    id,
    faucetId: 'faucet-native',
    amount
  });

  beforeEach(() => {
    mockBaseFee = 100;
    mockBalances.data = [nativeRow(0)];
    mockBalances.isLoading = false;
  });
  afterEach(() => {
    mockBaseFee = null;
    mockBalances.data = [];
  });

  it('marks a transfer the account cannot pay the fee for and refuses to queue it', async () => {
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: true });
    await act(async () => {
      await result.current.accept(note);
    });
    expect(mockQueue).not.toHaveBeenCalled();
    expect(result.current.items[0]?.status).toBe('pending');
  });

  it('writer fee refusal keeps Accept pending with the existing fee state', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
      'lib/miden/transaction/initiate'
    );
    mockBalances.data = [nativeRow(1)];
    mockQueue.mockRejectedValueOnce(new ClaimFeeRefusedError());
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { result, rerender } = renderHook(() => useActivityClaims());
    try {
      expect(result.current.items[0]?.cannotPayFee).toBe(false);
      await act(async () => {
        await result.current.accept(note);
      });

      expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: true });
      expect(result.current.items[0]?.txId).toBeUndefined();
      expect(mockStart).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      rerender();
      expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: true });

      mockBalances.data = [nativeRow(2)];
      rerender();
      expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: false });
      mockQueue.mockRejectedValueOnce(new ClaimFeeRefusedError());
      await act(async () => {
        await result.current.accept(note);
      });
      expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: true });
      mockBaseFee = 101;
      rerender();
      expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: false });
      await act(async () => {
        await result.current.accept(note);
      });
      expect(result.current.items[0]).toMatchObject({ status: 'claiming', txId: 'tx-one' });
    } finally {
      log.mockRestore();
    }
  });

  it('a writer fee refusal survives a view remount until a live refresh', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
      'lib/miden/transaction/initiate'
    );
    mockBalances.data = [nativeRow(1)];
    mockQueue.mockRejectedValueOnce(new ClaimFeeRefusedError());
    const list = renderHook(() => useActivityClaims());
    expect(list.result.current.items[0]?.cannotPayFee).toBe(false);
    await act(async () => {
      await list.result.current.accept(note);
    });
    expect(list.result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: true });
    expect(list.result.current.items[0]?.txId).toBeUndefined();

    list.unmount();
    const groups = renderHook(() => useActivityClaims());
    expect(groups.result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: true });
    expect(groups.result.current.items[0]?.txId).toBeUndefined();
    await act(async () => {
      await groups.result.current.accept(note);
    });
    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();

    mockBalances.data = [nativeRow(2)];
    groups.rerender();
    expect(groups.result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: false });
    expect(groups.result.current.items[0]?.txId).toBeUndefined();
    await act(async () => {
      await groups.result.current.accept(note);
    });
    expect(groups.result.current.items[0]).toMatchObject({ status: 'claiming', txId: 'tx-one' });
    groups.unmount();
  });

  it('Accept All applies partial fee refusals per note and continues', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
      'lib/miden/transaction/initiate'
    );
    mockBalances.data = [nativeRow(1)];
    const refused = { ...note, id: 'refused', carriesMoreAssets: true };
    const admitted = { ...note, id: 'admitted', carriesMoreAssets: false };
    const covered = { ...note, id: 'covered', carriesMoreAssets: false };
    const allRefused = { ...note, id: 'all-refused', faucetId: 'other-faucet' };
    const later = { ...note, id: 'later', faucetId: 'last-faucet' };
    mockClaim.safeClaimableNotes = [refused, admitted, covered, allRefused, later];
    mockQueueMany
      .mockResolvedValueOnce({
        committedId: 'tx-admitted',
        coveringTxIdByNoteId: new Map([
          [admitted.id, 'tx-admitted'],
          [covered.id, 'tx-covered']
        ]),
        feeRefusedNoteIds: [refused.id]
      })
      .mockRejectedValueOnce(new ClaimFeeRefusedError())
      .mockResolvedValueOnce('tx-later');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const actualShortfalls =
      jest.requireActual<typeof import('lib/miden/fees/spendable')>('lib/miden/fees/spendable').claimFeeShortfalls;
    let laterAhead: unknown;
    jest.mocked(claimFeeShortfalls).mockImplementation((transactions, ahead, ...context) => {
      if (transactions[0]?.[0] === later) laterAhead = [...ahead];
      return actualShortfalls(transactions, ahead, ...context);
    });
    const { result, rerender } = renderHook(() => useActivityClaims());
    try {
      await act(async () => {
        await result.current.acceptMany(mockClaim.safeClaimableNotes);
      });

      for (const id of [refused.id, allRefused.id]) {
        const item = result.current.items.find(candidate => candidate.note.id === id);
        expect(item).toMatchObject({ status: 'pending', cannotPayFee: true });
        expect(item?.txId).toBeUndefined();
      }
      expect(result.current.items.find(item => item.note.id === admitted.id)).toMatchObject({
        status: 'claiming',
        txId: 'tx-admitted'
      });
      expect(result.current.items.find(item => item.note.id === covered.id)).toMatchObject({
        status: 'claiming',
        txId: 'tx-covered'
      });
      expect(result.current.items.find(item => item.note.id === later.id)).toMatchObject({
        status: 'claiming',
        txId: 'tx-later'
      });
      expect(laterAhead).toEqual([admitted, covered]);
      expect(mockQueueMany).toHaveBeenCalledTimes(3);
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();

      mockClaim.safeClaimableNotes = mockClaim.safeClaimableNotes.map(note => ({ ...note, receivedAt: 123 }));
      rerender();
      expect(result.current.items.find(item => item.note.id === refused.id)).toMatchObject({
        status: 'pending',
        cannotPayFee: false
      });
    } finally {
      jest.mocked(claimFeeShortfalls).mockImplementation(actualShortfalls);
      log.mockRestore();
    }
  });

  it('held Retry renders localized fee refusal without processing', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
      'lib/miden/transaction/initiate'
    );
    const refusal = new ClaimFeeRefusedError();
    mockFeeCopy = 'localized-fee-copy';
    mockBalances.data = [nativeRow(1)];
    mockClaim.safeClaimableNotes = [{ ...note, isBeingClaimed: true, claimingTxId: 'tx-held' }];
    mockRequeue.mockRejectedValueOnce(refusal);
    const { result } = renderHook(() => useActivityClaims());
    settle([{ id: 'tx-held', status: 4, held: true }]);

    await act(async () => {
      await result.current.retryHeld(result.current.items[0]!);
    });

    expect(result.current.items[0]?.retryError).toBe('localized-fee-copy');
    expect(result.current.items[0]?.retryError).not.toBe(refusal.message);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.retryHeld(result.current.items[0]!);
    });
    expect(mockRequeue).toHaveBeenCalledTimes(2);
  });

  it("withholds a failed claim's Retry the same way", async () => {
    mockClaim.retriableNoteIds.add(note.id);
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.items[0]).toMatchObject({ status: 'failed', cannotPayFee: true });
    await act(async () => {
      await result.current.accept(note);
    });
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it('lets a new wallet accept its first USDCX, which pays its own fee', async () => {
    const first = nativeNote('first-usdcx', '1000000');
    mockClaim.safeClaimableNotes = [first];
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: false });
    await act(async () => {
      await result.current.accept(first);
    });
    expect(mockQueue).toHaveBeenCalledWith('account', first, ...ACCEPTS);
  });

  it('counts the fee asset of a claim the queue runs first', async () => {
    // An auto-consume of the faucet's USDCX, still running, pays for a token claimed after it.
    const queued = { ...nativeNote('queued-usdcx', '1000000'), isBeingClaimed: true, claimingTxId: 'tx-auto' };
    mockClaim.safeClaimableNotes = [queued, note];
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.items.find(item => item.note.id === note.id)).toMatchObject({
      status: 'pending',
      cannotPayFee: false
    });
    await act(async () => {
      await result.current.accept(note);
    });
    expect(mockQueue).toHaveBeenCalledWith('account', note, ...ACCEPTS);
  });

  it('admits a card when a queued USDCX claim is listed after it', () => {
    // 150 covers little more than that claim's own fee, which is not charged against the card: the queue may run
    // either first.
    const queued = { ...nativeNote('queued-usdcx', '150'), isBeingClaimed: true, claimingTxId: 'tx-auto' };
    mockClaim.safeClaimableNotes = [note, queued];
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.items.find(item => item.note.id === note.id)).toMatchObject({
      status: 'pending',
      cannotPayFee: false
    });
  });

  it('reads the queued claims once per change, not once per card', () => {
    const cards = Array.from({ length: 50 }, (_, index) => ({ ...note, id: `card-${index}` }));
    const queued = Array.from({ length: 50 }, (_, index) => ({
      ...note,
      id: `queued-${index}`,
      isBeingClaimed: true,
      claimingTxId: `tx-${index}`
    }));
    mockClaim.safeClaimableNotes = [...cards, ...queued];
    jest.mocked(claimFeeShortfalls).mockClear();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useActivityClaims();
    });
    expect(jest.mocked(claimFeeShortfalls).mock.calls.length).toBeLessThanOrEqual(renders);
    // No fee asset anywhere, so every card is refused.
    expect(result.current.items.filter(item => item.cannotPayFee === true)).toHaveLength(50);
  });

  it('fails open until balances first land', async () => {
    // Until then the rows are a zero placeholder, which would refuse every claim.
    mockBalances.isLoading = true;
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.items[0]).toMatchObject({ status: 'pending', cannotPayFee: false });
    await act(async () => {
      await result.current.accept(note);
    });
    expect(mockQueue).toHaveBeenCalledTimes(1);
  });

  it('Accept All queues the groups after a USDCX group it queued, whatever that group leaves after its fee', async () => {
    // 150 pays the USDCX transaction's own fee of at least 100 and leaves less than another, which is not simulated.
    const dust = nativeNote('dust-usdcx', '150');
    const other = { ...note, id: 'note-other', faucetId: 'faucet-other' };
    mockClaim.safeClaimableNotes = [note, dust, other];
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.cannotPayFee([note, dust, other])).toBe(false);

    await act(async () => {
      await result.current.acceptMany([note, dust, other]);
    });
    expect(mockQueueMany.mock.calls.map(call => call[1])).toEqual([[dust], [note], [other]]);
    expect(result.current.items.map(item => [item.note.id, item.status])).toEqual([
      ['note-one', 'claiming'],
      ['dust-usdcx', 'claiming'],
      ['note-other', 'claiming']
    ]);
  });

  it('Accept All refuses the groups after a USDCX group whose queue write failed', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const usdcx = nativeNote('usdcx', '1000000');
    mockClaim.safeClaimableNotes = [note, usdcx];
    mockQueueMany.mockRejectedValueOnce(new Error('Queue failed'));
    const { result } = renderHook(() => useActivityClaims());

    await act(async () => {
      await result.current.acceptMany([note, usdcx]);
    });
    // The failed write delivers no USDCX, so the token claim after it is certain to fail on the fee.
    expect(mockQueueMany).toHaveBeenCalledTimes(1);
    expect(mockQueueMany).toHaveBeenCalledWith('account', [usdcx], ...ACCEPTS_ALL);
    expect(mockStart).not.toHaveBeenCalled();
    expect(result.current.items.map(item => [item.note.id, item.status])).toEqual([
      ['note-one', 'pending'],
      ['usdcx', 'failed']
    ]);
    log.mockRestore();
  });

  it('Accept All with no fee asset anywhere queues nothing and starts no processing', async () => {
    const other = { ...note, id: 'note-other', faucetId: 'faucet-other' };
    mockClaim.retriableNoteIds.add(other.id);
    mockClaim.safeClaimableNotes = [note, other];
    const { result } = renderHook(() => useActivityClaims());
    expect(result.current.cannotPayFee([note, other])).toBe(true);

    await act(async () => {
      await result.current.acceptMany([note, other]);
    });
    expect(mockQueueMany).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    // Each note is back where it was: pending, and the failed one still failed.
    expect(result.current.items.map(item => [item.note.id, item.status])).toEqual([
      ['note-one', 'pending'],
      ['note-other', 'failed']
    ]);
  });
});
