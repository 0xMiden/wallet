/* eslint-disable import/first */

import { renderHook, waitFor } from '@testing-library/react';

import {
  guardianSyncFuseKey,
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncWatchdogEviction
} from 'lib/miden/front/sync-fuse';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';

const _g = globalThis as any;
_g.__cnTest = {
  isExtension: false,
  isIOS: false,
  storage: {} as Record<string, any>,
  consumableNotes: [] as any[],
  uncompletedTxs: [] as any[],
  intercomRequest: jest.fn(),
  metadataCache: {} as Record<string, any>,
  fetchMetadata: jest.fn(async () => ({ base: { decimals: 6, symbol: 'X', name: 'X' } })),
  setTokensBaseMetadata: jest.fn(async () => undefined),
  lastFetchPromise: Promise.resolve(),
  lastFetchData: undefined as any,
  walletState: {
    extensionClaimableNotes: null as any,
    assetsMetadata: {} as Record<string, any>,
    setExtensionClaimableNotes: jest.fn(),
    setAssetsMetadata: jest.fn()
  }
};

jest.mock('lib/platform', () => ({
  isExtension: () => (globalThis as any).__cnTest.isExtension,
  isIOS: () => (globalThis as any).__cnTest.isIOS
}));

jest.mock('lib/store', () => {
  const fn = (selector: any) => selector((globalThis as any).__cnTest.walletState);
  (fn as any).getState = () => (globalThis as any).__cnTest.walletState;
  return {
    useWalletStore: fn,
    getIntercom: () => ({ request: (globalThis as any).__cnTest.intercomRequest })
  };
});

// The SWR config is where the #777 gate lives (`isPaused`), so the mock has to keep it
// rather than swallow it — a mock that only calls the fetcher makes the gate untestable.
const swrConfigSeen: any[] = [];

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn((_key: any, fetcher: any, config: any) => {
    swrConfigSeen.push(config);
    if (!fetcher) return { data: undefined, mutate: jest.fn(), isLoading: false, isValidating: false };
    // Run the fetcher and expose its settlement promise so tests can await it.
    // On rejection, drive the onError callback like real SWR would.
    const result = fetcher();
    if (result instanceof Promise) {
      (globalThis as any).__cnTest.lastFetchPromise = result
        .then((data: any) => {
          (globalThis as any).__cnTest.lastFetchData = data;
        })
        .catch((e: any) => {
          config?.onError?.(e);
        });
      return { data: undefined, mutate: jest.fn(), isLoading: true, isValidating: false };
    }
    return { data: result, mutate: jest.fn(), isLoading: false, isValidating: false };
  })
}));

const mockGetMidenClient = jest.fn();
const mockRunWhenClientIdle = jest.fn();
const lockOptionsSeen: any[] = [];
// Models hold OWNERSHIP, not just pass-through. A mock that hands the callback no hold
// and no `getCurrentWasmLockHold` makes every post-await liveness guard in the code under
// test unreachable — including the per-order one inside `classifySwapOrderNotes`, which
// then reads as covered while it is not exercised at all.
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  getCurrentWasmLockHold: () => (globalThis as any).__cnTest.currentHold ?? null,
  withWasmClientLock: async (fn: (hold: object) => Promise<any>, options?: any) => {
    lockOptionsSeen.push(options);
    const hold = { id: `cn-hold-${lockOptionsSeen.length}` };
    (globalThis as any).__cnTest.currentHold = hold;
    try {
      return await fn(hold);
    } finally {
      if ((globalThis as any).__cnTest.currentHold === hold) (globalThis as any).__cnTest.currentHold = null;
    }
  },
  runWhenClientIdle: (fn: () => Promise<any>) => mockRunWhenClientIdle(fn)
}));

// Since slice 4 (issue #260) claimable-notes reads consumable notes through the
// proxy (reduced DTOs) rather than getMidenClient().getConsumableNotes; since slice
// 7a the swap-classification per-order PSWAP lineage also routes through the proxy
// (getPswapLineage) instead of a live client — so the hook no longer calls
// getMidenClient directly at all. Mock both proxy reads.
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getConsumableNotes: (...a: any[]) => (globalThis as any).__cnTest.proxyGetConsumableNotes(...a),
    getPswapLineage: jest.fn(async () => null)
  }
}));

jest.mock('lib/miden/activity', () => ({
  getUncompletedTransactions: async () => {
    if ((globalThis as any).__cnTest.uncompletedTxsError) throw new Error('dexie unavailable');
    return (globalThis as any).__cnTest.uncompletedTxs;
  }
}));

jest.mock('lib/miden/note-quarantine', () => ({
  getQuarantinedNoteIds: async () => (globalThis as any).__cnTest.quarantined ?? new Set()
}));

jest.mock('../assets', () => ({
  isMidenFaucet: jest.fn(async (id: string) => id === 'miden-faucet')
}));

jest.mock('../helpers', () => ({
  toNoteTypeString: () => 'public'
}));

jest.mock('../metadata', () => ({
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech-stub')
}));

jest.mock('./assets', () => ({
  useTokensMetadata: () => ({
    allTokensBaseMetadataRef: { current: (globalThis as any).__cnTest.metadataCache },
    fetchMetadata: (id: string) => (globalThis as any).__cnTest.fetchMetadata(id),
    setTokensBaseMetadata: (batch: any) => (globalThis as any).__cnTest.setTokensBaseMetadata(batch)
  })
}));

import { useClaimableNotes } from './claimable-notes';

beforeEach(() => {
  _g.__cnTest.isExtension = false;
  _g.__cnTest.isIOS = false;
  _g.__cnTest.storage = {};
  _g.__cnTest.consumableNotes = [];
  _g.__cnTest.uncompletedTxs = [];
  _g.__cnTest.quarantined = new Set();
  _g.__cnTest.walletState.extensionClaimableNotes = null;
  _g.__cnTest.walletState.extensionClaimingNoteIds = new Set();
  _g.__cnTest.walletState.assetsMetadata = {};
  _g.__cnTest.intercomRequest.mockReset().mockResolvedValue(undefined);
  _g.__cnTest.metadataCache = {};
  _g.__cnTest.fetchMetadata = jest.fn(async () => ({ base: { decimals: 6, symbol: 'X', name: 'X' } }));
  _g.__cnTest.setTokensBaseMetadata = jest.fn(async () => undefined);
  _g.__cnTest.lastFetchPromise = Promise.resolve();
  _g.__cnTest.lastFetchData = undefined;
  mockRunWhenClientIdle.mockReset();
  mockGetMidenClient.mockReset().mockResolvedValue({});
  // Default proxy read: return the fixture DTO list; individual tests override.
  _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => _g.__cnTest.consumableNotes);
});

describe('useClaimableNotes (extension mode)', () => {
  beforeEach(() => {
    _g.__cnTest.isExtension = true;
    _g.__cnTest.uncompletedTxsError = false;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: jest.fn((key: string, cb: any) => {
            cb({ [key]: (globalThis as any).__cnTest.storage[key] });
          })
        }
      }
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('returns isLoading when no notes have been received yet', () => {
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.isLoading).toBe(true);
  });

  it('gates a note that has a live consume row, and points at that row', async () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
      }
    ];
    _g.__cnTest.uncompletedTxs = [{ id: 'tx-9', type: 'consume', noteIds: ['n1'] }];

    const { result } = renderHook(() => useClaimableNotes('pk-1'));

    await waitFor(() => expect(result.current.data?.[0]?.isBeingClaimed).toBe(true));
    expect(result.current.data?.[0]?.claimingTxId).toBe('tx-9');
  });

  it('keeps the previous gate when the consume-row read fails', async () => {
    // Better a stale gate for one tick than a Claim button that reappears under a live
    // consume: a failed read must not be read as "nothing is being claimed".
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
      }
    ];
    _g.__cnTest.uncompletedTxsError = true;

    const { result } = renderHook(() => useClaimableNotes('pk-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.isBeingClaimed).toBe(false);
    _g.__cnTest.uncompletedTxsError = false;
  });

  it('un-gates a note once no consume row is in flight for it', async () => {
    // A row leaving Queued/GeneratingTransaction is reported by omission from
    // `getUncompletedTransactions` -- and that includes a consume that FAILED. The broadcast
    // gate this replaced had no path back from a failure: the note stays consumable, so the
    // note-gone clear never fired and the Claim button did not return.
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
      }
    ];
    _g.__cnTest.uncompletedTxs = [];

    const { result } = renderHook(() => useClaimableNotes('pk-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.isBeingClaimed).toBe(false);
    expect(result.current.data?.[0]?.claimingTxId).toBeUndefined();
  });

  it('maps notes from the wallet store when present', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.id).toBe('n1');
  });

  it('hides swap-managed notes while leaving unrelated notes visible', () => {
    const metadata = { decimals: 6, symbol: 'TOK', name: 'Token' };
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'swap-tip',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata,
        swapOrder: {
          orderId: '77',
          depth: 2,
          role: 'tip',
          lineageState: 'active',
          expiresAt: 220,
          autoConsume: true
        }
      },
      {
        id: 'manual-swap-tip',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata,
        swapOrder: {
          orderId: '78',
          depth: 0,
          role: 'tip',
          lineageState: 'active',
          expiresAt: 220,
          autoConsume: false
        }
      },
      {
        id: 'ordinary-same-token-and-amount',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's1',
        noteType: 'public',
        metadata
      }
    ];

    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data?.map(note => note.id)).toEqual(['manual-swap-tip', 'ordinary-same-token-and-amount']);
  });

  it('mutate triggers a SyncRequest via intercom', async () => {
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await result.current.mutate();
    expect(_g.__cnTest.intercomRequest).toHaveBeenCalled();
  });

  it('skips when enabled is false', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [{ id: 'n1', faucetId: 'f' }];
    const { result } = renderHook(() => useClaimableNotes('pk-1', false));
    expect(result.current.data).toBeUndefined();
  });

  it('uses asset metadata fallback when note has none', () => {
    _g.__cnTest.walletState.assetsMetadata = {
      f1: { decimals: 6, symbol: 'A', name: 'A' }
    };
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public'
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data?.[0]?.metadata?.symbol).toBe('A');
  });

  it('filters notes that have neither metadata in the note nor in assets', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'unknown',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public'
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([]);
  });

  it('falls back to "unknown" type when a note has no noteType', () => {
    _g.__cnTest.walletState.extensionClaimableNotes = [
      {
        id: 'n1',
        faucetId: 'f1',
        amountBaseUnits: '100',
        senderAddress: 's',
        metadata: { decimals: 6, symbol: 'TOK', name: 'Token' }
        // noteType intentionally omitted -> nullish coalescing fallback
      }
    ];
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data?.[0]?.type).toBe('unknown');
  });

  it('serves cached notes only for the matching account (account-scoped poll)', () => {
    _g.__cnTest.storage['miden_sync_data'] = {
      notes: [{ id: 'nX', faucetId: 'f1', amountBaseUnits: '5', senderAddress: 's', noteType: 'public' }],
      vaultAssets: [],
      accountPublicKey: 'A'
    };
    const setSpy = _g.__cnTest.walletState.setExtensionClaimableNotes as jest.Mock;

    // Account B must NOT receive account A's cached notes.
    setSpy.mockClear();
    renderHook(() => useClaimableNotes('B'));
    expect(setSpy).toHaveBeenLastCalledWith([]);

    // Account A receives its own notes.
    setSpy.mockClear();
    renderHook(() => useClaimableNotes('A'));
    expect(setSpy).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'nX' })]);
  });

  it('stays loading (does not overwrite) when no sync data has been cached yet', () => {
    const setSpy = _g.__cnTest.walletState.setExtensionClaimableNotes as jest.Mock;
    setSpy.mockClear();
    renderHook(() => useClaimableNotes('A'));
    // No miden_sync_data present → poll must not push an (empty) result that
    // would flip isLoading off prematurely.
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('does nothing when chrome.storage.local is unavailable', () => {
    (globalThis as any).chrome = {};
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    // No crash; store never populated, so still loading.
    expect(result.current.isLoading).toBe(true);
  });
});

describe('useClaimableNotes (local mode — mobile/desktop)', () => {
  beforeEach(() => {
    _g.__cnTest.isExtension = false;
  });

  // DTO fixtures (issue #260, slice 4): the proxy returns reduced ConsumableNoteDtos,
  // so bech32 encoding is already applied — faucetId/senderAccountId are final values.
  function makeMockNote({
    id = 'note-1',
    faucetId = 'miden-faucet',
    amount = '100',
    senderId = 'sender-1',
    noteType = 0
  }: {
    id?: string;
    faucetId?: string;
    amount?: string;
    senderId?: string;
    noteType?: number;
  } = {}): any {
    return {
      noteId: id,
      nullifier: `null-${id}`,
      noteType,
      senderAccountId: senderId,
      state: 2,
      assets: [{ faucetId, amount }],
      swapAttachment: null
    };
  }

  it('fetches notes from the WASM client and parses them', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'local-1' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(_g.__cnTest.proxyGetConsumableNotes).toHaveBeenCalled();
    });
  });

  it('handles a note with no fungible assets by skipping it', async () => {
    const badNote = { ...makeMockNote({ id: 'empty', senderId: 's' }), assets: [] };
    _g.__cnTest.consumableNotes = [badNote, makeMockNote({ id: 'good' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(_g.__cnTest.proxyGetConsumableNotes).toHaveBeenCalled();
    });
  });

  it('skips a partial note whose noteId is null', async () => {
    const partialNote = { ...makeMockNote({ id: 'partial' }), noteId: null };
    _g.__cnTest.consumableNotes = [partialNote, makeMockNote({ id: 'full-note' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(_g.__cnTest.proxyGetConsumableNotes).toHaveBeenCalled();
    });
  });

  it('excludes quarantined notes (simulation dry-run imports) from the result', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'quarantined-note' }), makeMockNote({ id: 'visible-note' })];
    _g.__cnTest.quarantined = new Set(['quarantined-note']);
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData.map((n: any) => n.id)).toEqual(['visible-note']);
  });

  it('uses the in-progress consume transactions to mark notes as being claimed', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'note-being-claimed' })];
    _g.__cnTest.uncompletedTxs = [{ type: 'consume', noteId: 'note-being-claimed' }];
    renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(_g.__cnTest.proxyGetConsumableNotes).toHaveBeenCalled();
    });
  });

  it('attaches cached metadata for a non-miden faucet present in the cache', async () => {
    _g.__cnTest.metadataCache = { 'other-faucet': { decimals: 8, symbol: 'OTH', name: 'Other' } };
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'cached-note', faucetId: 'other-faucet' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([
      expect.objectContaining({ id: 'cached-note', faucetId: 'other-faucet' })
    ]);
    // Non-miden faucet that is already cached must NOT be queued for prefetch.
    expect(mockRunWhenClientIdle).not.toHaveBeenCalled();
  });

  it('queues a background fetch for an unknown faucet and persists the fetched metadata', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'unknown-note', faucetId: 'unknown-faucet' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    // Run the scheduled idle callback to exercise the prefetch + persist path.
    const idleCb = mockRunWhenClientIdle.mock.calls[0]![0];
    await idleCb();
    expect(_g.__cnTest.fetchMetadata).toHaveBeenCalledWith('unknown-faucet');
    expect(_g.__cnTest.setTokensBaseMetadata).toHaveBeenCalledWith({
      'unknown-faucet': { decimals: 6, symbol: 'X', name: 'X' }
    });
  });

  it('swallows a metadata fetch error in the background prefetch and skips persisting', async () => {
    _g.__cnTest.fetchMetadata = jest.fn(async () => {
      throw new Error('rpc down');
    });
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'unknown-note', faucetId: 'unknown-faucet' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    const idleCb = mockRunWhenClientIdle.mock.calls[0]![0];
    await idleCb();
    expect(_g.__cnTest.fetchMetadata).toHaveBeenCalledWith('unknown-faucet');
    // Nothing fetched successfully → persist must be skipped.
    expect(_g.__cnTest.setTokensBaseMetadata).not.toHaveBeenCalled();
  });

  it('records a debug error and rethrows when getConsumableNotes throws', async () => {
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => {
      throw new Error('client exploded');
    });
    renderHook(() => useClaimableNotes('pk-1'));
    // The fetch rejects → onError fires (covered by the SWR mock).
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.proxyGetConsumableNotes).toHaveBeenCalled();
  });

  it('bounds and labels BOTH of its WASM holds, not just the note read (#777)', async () => {
    // Two holds per lap on the same 5s cadence: the DTO read and the swap-lineage
    // classification that follows it. Flag-OFF both are inline WASM that rebuild the
    // client when the slot is empty — which after any eviction it is — so leaving the
    // second on the 5-minute backstop reopened the same 300s park the first no longer
    // takes, one hold further down the same function.
    lockOptionsSeen.length = 0;
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;

    expect(lockOptionsSeen).toEqual([
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'claimable-notes' },
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'claimable-notes-swap-lineage' }
    ]);
  });

  it('pauses its poll while its own fuse is lit, keeping the last note list on screen', async () => {
    // Bounding capped each park at 120s; only the fuse stops a 5s poll re-entering that
    // park — and leaking the client it poisoned — every other lap, indefinitely, on a
    // wallet the user is not even touching. `isPaused` rather than an early return so the
    // notes already displayed stay displayed: returning [] would read as "they're gone".
    __resetSyncFuseStateForTests();
    swrConfigSeen.length = 0;
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    const isPaused = swrConfigSeen[0].isPaused;

    expect(isPaused()).toBe(false);
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('claimable-notes');
    expect(isPaused()).toBe(true);

    // Keyed per probe: a fuse lit on some OTHER probe must not silence this poll, which
    // is the aliasing that made one shared counter useless.
    __resetSyncFuseStateForTests();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++)
      noteSyncWatchdogEviction(guardianSyncFuseKey('0xother', 'https://guardian.test'));
    expect(isPaused()).toBe(false);
    __resetSyncFuseStateForTests();
  });

  it('feeds its own evictions to the fuse and clears them on a completed read', async () => {
    __resetSyncFuseStateForTests();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => {
        throw new WasmClientPoisonedError('watchdog');
      });
      renderHook(() => useClaimableNotes('pk-1'));
      await _g.__cnTest.lastFetchPromise;
    }
    expect(isSyncFused('claimable-notes')).toBe(true);

    // An ordinary failure is not proof of a parked call, so it must not light the fuse.
    __resetSyncFuseStateForTests();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 1; i++) {
      _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => {
        throw new Error('rpc down');
      });
      renderHook(() => useClaimableNotes('pk-1'));
      await _g.__cnTest.lastFetchPromise;
    }
    expect(isSyncFused('claimable-notes')).toBe(false);

    // And a read that completes withdraws the evidence outright.
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('claimable-notes');
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => []);
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(isSyncFused('claimable-notes')).toBe(false);
    __resetSyncFuseStateForTests();
  });

  it('exposes debugInfo only on iOS', () => {
    _g.__cnTest.isIOS = true;
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.debugInfo).toBeDefined();
    expect(result.current.debugInfo?.lastFetchTime).toBeDefined();
  });

  it('returns undefined debugInfo when not on iOS', () => {
    _g.__cnTest.isIOS = false;
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.debugInfo).toBeUndefined();
  });

  it('skips a note whose first fungible asset is falsy', async () => {
    // A DTO whose assets[0] is falsy -> hits `if (!firstAsset)` in parseNotes.
    const noteWithFalsyAsset = { ...makeMockNote({ id: 'falsy-asset', senderId: 's' }), assets: [null] };
    _g.__cnTest.consumableNotes = [noteWithFalsyAsset];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([]);
  });

  it('parses a note with no metadata using empty sender and unknown type', async () => {
    // Metadata-less DTO: noteType/senderAccountId undefined (reducer output).
    const noMetaNote = {
      noteId: 'no-meta',
      nullifier: null,
      noteType: undefined,
      senderAccountId: undefined,
      state: 0,
      assets: [{ faucetId: 'miden-faucet', amount: '42' }],
      swapAttachment: null
    };
    _g.__cnTest.consumableNotes = [noMetaNote];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([
      expect.objectContaining({ id: 'no-meta', senderAddress: '', type: 'unknown' })
    ]);
  });

  it('tolerates a null metadata cache ref', async () => {
    _g.__cnTest.metadataCache = null;
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'null-cache-note' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData).toEqual([expect.objectContaining({ id: 'null-cache-note' })]);
  });
});
