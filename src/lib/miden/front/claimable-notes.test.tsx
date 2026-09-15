/* eslint-disable import/first */

import { act, renderHook, waitFor } from '@testing-library/react';

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
          (globalThis as any).__cnTest.liveDataByKey[JSON.stringify(_key)] = data;
        })
        .catch((e: any) => {
          config?.onError?.(e);
        });
      // Real SWR serves `fallbackData` while the first read is in flight, and the
      // cache-first path is only observable through that — a mock that always
      // returned `undefined` here would make it untestable. Once a live read has
      // settled it wins for its own key, which is what SWR does on revalidation.
      const settled = (globalThis as any).__cnTest.liveDataByKey[JSON.stringify(_key)];
      const data = settled ?? config?.fallbackData;
      return { data, mutate: jest.fn(), isLoading: data === undefined, isValidating: false };
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
  // Records its arguments, so a test can see the step a forwarded check carries.
  assertWasmHoldCurrent: (...a: unknown[]) => (globalThis as any).__cnTest.assertWasmHoldCurrent(...a),
  runWhenClientIdle: (fn: () => Promise<any>) => mockRunWhenClientIdle(fn)
}));

// Since slice 4 (issue #260) claimable-notes reads consumable notes through the
// proxy (reduced DTOs) rather than getMidenClient().getConsumableNotes; since slice
// Swap classification reads a complete lineage snapshot through the same proxy.
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getConsumableNotes: (...a: any[]) => (globalThis as any).__cnTest.proxyGetConsumableNotes(...a),
    getPswapLineages: jest.fn(async () => [])
  }
}));

jest.mock('lib/miden/activity', () => ({
  getUncompletedTransactions: async (address: string) => {
    const t = (globalThis as any).__cnTest;
    if (t.uncompletedTxsError) throw new Error('dexie unavailable');
    // Captured BEFORE the gate: a parked read must resolve with what the store held when IT was
    // issued, not with whatever a later read installed. Reading after the await made a stale-read
    // test observe fresh data and pass against the very bug it was written for.
    const value = t.uncompletedTxsByAddress?.[address] ?? t.uncompletedTxs;
    if (t.uncompletedTxsGateFor === address) {
      await t.uncompletedTxsGate;
      // Lets a test wait until a parked read has actually returned, rather than asserting before it lands.
      t.onParkedReadReturn?.();
    }
    return value;
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

// Path matches the import in `claimable-notes.ts` ('./storage'). Backs the per-account
// cache-first list with a plain in-memory key-value store.
jest.mock('./storage', () => ({
  fetchFromStorage: async (key: string) => (globalThis as any).__cnTest.kv[key] ?? null,
  putToStorage: async (key: string, value: any) => {
    (globalThis as any).__cnTest.puts += 1;
    const override = (globalThis as any).__cnTest.putOverride;
    if (override) return override(key, value);
    (globalThis as any).__cnTest.kv[key] = value;
  }
}));

// Display dates are resolved after the note read; tests hand back a fixed block-to-time map.
jest.mock('lib/miden-chain/block-timestamps', () => ({
  getBlockTimestamps: (...a: any[]) => (globalThis as any).__cnTest.getBlockTimestamps(...a)
}));

// The cache is scoped by endpoint; a test switches endpoints through this value.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => (globalThis as any).__cnTest.rpcUrl,
  getEffectiveNetworkName: () => 'testnet'
}));

jest.mock('./assets', () => ({
  useTokensMetadata: () => ({
    allTokensBaseMetadataRef: { current: (globalThis as any).__cnTest.metadataCache },
    fetchMetadata: (id: string) => (globalThis as any).__cnTest.fetchMetadata(id),
    setTokensBaseMetadata: (batch: any) => (globalThis as any).__cnTest.setTokensBaseMetadata(batch)
  })
}));

import { __resetClaimableNotesCacheForTests, useClaimableNotes } from './claimable-notes';

// A test can leave a fetch in flight (RTL unmounts the hook, the promise chain keeps
// going). Such a straggler still writes the module-level last-known-list cache, so it
// has to settle BEFORE the next test's reset — otherwise it lands in the next test and
// serves it the previous one's list.
afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
});

beforeEach(() => {
  _g.__cnTest.kv = {};
  _g.__cnTest.puts = 0;
  _g.__cnTest.putOverride = undefined;
  _g.__cnTest.liveDataByKey = {};
  _g.__cnTest.rpcUrl = 'https://rpc-a.example';
  _g.__cnTest.getBlockTimestamps = jest.fn(async () => new Map());
  __resetClaimableNotesCacheForTests();
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
  _g.__cnTest.assertWasmHoldCurrent = jest.fn();
});

describe('useClaimableNotes (extension mode)', () => {
  beforeEach(() => {
    _g.__cnTest.isExtension = true;
    _g.__cnTest.uncompletedTxsError = false;
    _g.__cnTest.uncompletedTxsGate = undefined;
    _g.__cnTest.uncompletedTxsGateFor = undefined;
    _g.__cnTest.uncompletedTxsByAddress = undefined;
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

  it('drops a consume-row read that resolves after the account changed', async () => {
    // The read is async and runs from both the poll and `mutate`, so one started before an account
    // switch can land after it. Ungated it installs the PREVIOUS account's claim gate over the new
    // account's notes -- the note reads as claimed by a transaction that is not its own.
    let release: () => void = () => {};
    _g.__cnTest.uncompletedTxsGate = new Promise<void>(res => {
      release = res;
    });
    // Park ONLY the old account's read. Gating both would let the new account's read resolve last
    // and clear the map on its own, which is what made an earlier version of this test vacuous.
    _g.__cnTest.uncompletedTxsGateFor = 'pk-old';
    const parkedReturned = new Promise<void>(res => {
      _g.__cnTest.onParkedReadReturn = res;
    });
    // The new account has a live consume of its own. Unguarded, the stale read replaces the map that consume installed,
    // and the render-time generation check then shows no claim at all, which asserting "not claimed" cannot tell apart
    // from the guard working.
    _g.__cnTest.uncompletedTxsByAddress = {
      'pk-old': [{ id: 'tx-old', type: 'consume', noteIds: ['n1'] }],
      'pk-new': [{ id: 'tx-new', type: 'consume', noteIds: ['n1'] }]
    };
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

    const { result, rerender } = renderHook(({ pk }: { pk: string }) => useClaimableNotes(pk), {
      initialProps: { pk: 'pk-old' }
    });

    // Switch accounts while the first read is still parked; the new account's own claim shows first.
    rerender({ pk: 'pk-new' });
    await waitFor(() => expect(result.current.data?.[0]?.claimingTxId).toBe('tx-new'));

    // Then let the stale read land, and wait until it has before asserting it changed nothing.
    await act(async () => {
      release();
      await parkedReturned;
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(result.current.data?.[0]?.claimingTxId).toBe('tx-new');
  });

  it('drops a stale read across an A -> B -> A switch, which an address comparison cannot', async () => {
    // The ABA case. Comparing the resolving read's address against the current one passes here,
    // because the address IS 'pk-a' again by the time the first read lands -- so that guard would
    // install the FIRST A's rows over the second A's. Only a generation distinguishes them.
    let release: () => void = () => {};
    _g.__cnTest.uncompletedTxsGate = new Promise<void>(res => {
      release = res;
    });
    _g.__cnTest.uncompletedTxsGateFor = 'pk-a';
    const parkedReturned = new Promise<void>(res => {
      _g.__cnTest.onParkedReadReturn = res;
    });
    _g.__cnTest.uncompletedTxsByAddress = {
      'pk-a': [{ id: 'tx-stale', type: 'consume', noteIds: ['n1'] }],
      'pk-b': []
    };
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

    const { result, rerender } = renderHook(({ pk }: { pk: string }) => useClaimableNotes(pk), {
      initialProps: { pk: 'pk-a' }
    });

    // The first A's read has already captured [tx-stale] and is parked. From here on the store holds the second A's own
    // live consume, tx-a2, so the parked read landing unguarded would replace that map with a stale one, which the
    // render-time generation check then shows as no claim at all.
    _g.__cnTest.uncompletedTxsGateFor = 'never';
    _g.__cnTest.uncompletedTxsByAddress['pk-a'] = [{ id: 'tx-a2', type: 'consume', noteIds: ['n1'] }];

    // A -> B -> A: the parked read belongs to the FIRST A.
    rerender({ pk: 'pk-b' });
    rerender({ pk: 'pk-a' });
    await waitFor(() => expect(result.current.data?.[0]?.claimingTxId).toBe('tx-a2'));

    await act(async () => {
      release();
      await parkedReturned;
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(result.current.data?.[0]?.claimingTxId).toBe('tx-a2');
  });

  it("does not show the previous account's installed claim map while the new account's read fails", async () => {
    // The generation guard drops stale completions, but a map that already landed is not a completion: untagged, it stayed
    // applied after a switch, and a failed read deliberately keeps the last map, so the new account showed the old
    // account's claim until its own read succeeded.
    _g.__cnTest.uncompletedTxsByAddress = {
      'pk-old': [{ id: 'tx-old', type: 'consume', noteIds: ['n1'] }],
      'pk-new': []
    };
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

    const { result, rerender } = renderHook(({ pk }: { pk: string }) => useClaimableNotes(pk), {
      initialProps: { pk: 'pk-old' }
    });
    // Positive control: the old account's map is installed before the switch.
    await waitFor(() => expect(result.current.data?.[0]?.isBeingClaimed).toBe(true));

    _g.__cnTest.uncompletedTxsError = true;
    rerender({ pk: 'pk-new' });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.isBeingClaimed).toBe(false);
  });

  it('re-reads the consume rows when mutate is called, without waiting for the next poll', async () => {
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

    // A consume is queued after the last poll. `mutate` must surface it, or a caller that
    // refreshes right after claiming still sees the note as claimable for a whole poll period.
    _g.__cnTest.uncompletedTxs = [{ id: 'tx-9', type: 'consume', noteIds: ['n1'] }];
    await act(async () => {
      await result.current.mutate();
    });

    await waitFor(() => expect(result.current.data?.[0]?.isBeingClaimed).toBe(true));
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

  it('publishes the extension list in the fixed order, however the service worker stored it', () => {
    const metadata = { decimals: 6, symbol: 'TOK', name: 'Token' };
    const note = (id: string, receivedAt?: number) => ({
      id,
      faucetId: 'f1',
      amountBaseUnits: '100',
      senderAddress: 's1',
      noteType: 'public',
      receivedAt,
      metadata
    });
    _g.__cnTest.walletState.extensionClaimableNotes = [
      note('b', 10),
      note('a', 10),
      note('old', 5),
      note('newest', 20)
    ];
    const { result, rerender } = renderHook(() => useClaimableNotes('pk-1'));
    expect(result.current.data?.map((n: any) => n.id)).toEqual(['newest', 'a', 'b', 'old']);

    _g.__cnTest.walletState.extensionClaimableNotes = [
      note('old', 5),
      note('a', 10),
      note('newest', 20),
      note('b', 10)
    ];
    rerender();
    expect(result.current.data?.map((n: any) => n.id)).toEqual(['newest', 'a', 'b', 'old']);
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

  it('dates notes on the endpoint they were read from, even if the wallet moves during the read', async () => {
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => {
      _g.__cnTest.rpcUrl = 'https://rpc-b.example';
      return [{ ...makeMockNote({ id: 'dated' }), blockNum: 42 }];
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.getBlockTimestamps).toHaveBeenCalledWith([42], 'https://rpc-a.example');
  });

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

  it('forwards the reader check that parked into its own read label', async () => {
    let forwarded: ((step?: string) => void) | undefined;
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async (...called: unknown[]) => {
      forwarded = called[1] as (step?: string) => void;
      return [];
    });
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(forwarded).toBeDefined();
    forwarded?.('after the reader build');
    expect(_g.__cnTest.assertWasmHoldCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^cn-hold-/) }),
      'inside the claimable-notes read',
      'after the reader build'
    );
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

  // -------------------- Cache-first list --------------------

  const CACHE_KEY = 'claimable_notes:v1:https://rpc-a.example|testnet:pk-1';

  function makeCachedNote(id: string, receivedAt?: number): any {
    return {
      id,
      faucetId: 'miden-faucet',
      amount: '100',
      senderAddress: 'sender-1',
      isBeingClaimed: false,
      type: 'public',
      receivedAt,
      metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
    };
  }

  /** A live read that never settles, so only the cached list can be observed. */
  function neverSettlingRead() {
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(() => new Promise(() => {}));
  }

  it('serves the persisted list on the first render, before the live read lands', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('cached-1', 20), makeCachedNote('cached-2', 10)];
    neverSettlingRead();
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(result.current.data?.map((n: any) => n.id)).toEqual(['cached-1', 'cached-2']);
    });
  });

  it('marks cached entries fromCache so every claim gate drops them, and live entries not at all', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('cached-1')];
    neverSettlingRead();
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });
    expect(result.current.data?.every((n: any) => n.fromCache === true)).toBe(true);

    // The live read carries no flag, so the same gates admit it.
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'live-1' })];
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => _g.__cnTest.consumableNotes);
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.lastFetchData.map((n: any) => [n.id, n.fromCache])).toEqual([['live-1', undefined]]);
  });

  it('reports the persisted list as a fallback until a live read replaces it', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('cached-1')];
    neverSettlingRead();
    const { result, rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(result.current.data?.map((n: any) => n.id)).toEqual(['cached-1']);
    });
    expect(result.current.isFallback).toBe(true);

    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'live-1' })];
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => _g.__cnTest.consumableNotes);
    rerender();
    await _g.__cnTest.lastFetchPromise;
    rerender();
    expect(result.current.data?.map((n: any) => n.id)).toEqual(['live-1']);
    expect(result.current.isFallback).toBe(false);
  });

  it('replaces the cached list with the live result and rewrites the cache', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('stale-1')];
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'live-1' })];
    const { result, rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    expect(result.current.data?.map((n: any) => n.id)).toEqual(['live-1']);
    // The cache now holds the live list, stored as plain JSON with no cache flag.
    expect(_g.__cnTest.kv[CACHE_KEY].map((n: any) => n.id)).toEqual(['live-1']);
    expect(_g.__cnTest.kv[CACHE_KEY][0].fromCache).toBeUndefined();
  });

  it('never serves one account cached notes belonging to another', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('cached-1')];
    neverSettlingRead();
    const { result, rerender } = renderHook(({ address }) => useClaimableNotes(address), {
      initialProps: { address: 'pk-1' }
    });
    await waitFor(() => {
      expect(result.current.data?.map((n: any) => n.id)).toEqual(['cached-1']);
    });
    // The fallback state still holds pk-1's list during the render that switches accounts.
    rerender({ address: 'pk-2' });
    expect(result.current.data).toBeUndefined();
    await Promise.resolve();
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the cached list per endpoint, so a switch neither serves nor overwrites the previous chain list', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('chain-a')];
    neverSettlingRead();
    const { result, rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(result.current.data?.map((n: any) => n.id)).toEqual(['chain-a']);
    });

    _g.__cnTest.rpcUrl = 'https://rpc-b.example';
    rerender();
    expect(result.current.data).toBeUndefined();
    await Promise.resolve();
    expect(result.current.data).toBeUndefined();

    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'chain-b' })];
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => _g.__cnTest.consumableNotes);
    rerender();
    await _g.__cnTest.lastFetchPromise;
    rerender();
    const chainBKey = 'claimable_notes:v1:https://rpc-b.example|testnet:pk-1';
    await waitFor(() => expect(_g.__cnTest.kv[chainBKey]?.map((n: any) => n.id)).toEqual(['chain-b']));
    expect(_g.__cnTest.kv[CACHE_KEY].map((n: any) => n.id)).toEqual(['chain-a']);
  });

  it('does not serve the previous endpoint live list while the new endpoint is read', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'chain-a' })];
    const { result, rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    expect(result.current.data?.map((n: any) => n.id)).toEqual(['chain-a']);

    _g.__cnTest.rpcUrl = 'https://rpc-b.example';
    neverSettlingRead();
    rerender();
    expect(result.current.data).toBeUndefined();
  });

  it('publishes at most 300 cached notes, newest first, however many were stored', async () => {
    _g.__cnTest.kv[CACHE_KEY] = Array.from({ length: 305 }, (_, index) => makeCachedNote(`cached-${index}`, index + 1));
    neverSettlingRead();
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => expect(result.current.data).toHaveLength(300));
    expect(result.current.data?.[0]?.id).toBe('cached-304');
  });

  it('drops persisted entries whose fields would throw or misorder while rendering', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [
      makeCachedNote('valid', 20),
      { ...makeCachedNote('bad-amount'), amount: 'not-a-number' },
      { ...makeCachedNote('string-decimals'), metadata: { decimals: '6', symbol: 'X', name: 'X' } },
      { ...makeCachedNote('fractional-decimals'), metadata: { decimals: 1.5, symbol: 'X', name: 'X' } },
      { ...makeCachedNote('negative-decimals'), metadata: { decimals: -1, symbol: 'X', name: 'X' } },
      { ...makeCachedNote('numeric-name'), metadata: { decimals: 6, symbol: 'X', name: 7 } },
      { ...makeCachedNote('huge-decimals'), metadata: { decimals: 1_000_000_000, symbol: 'X', name: 'X' } },
      { ...makeCachedNote('string-received-at'), receivedAt: 'yesterday' },
      { ...makeCachedNote('string-recallable-at'), recallableAtMs: 'soon' }
    ];
    neverSettlingRead();
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(result.current.data?.map((n: any) => n.id)).toEqual(['valid']);
    });
  });

  it('overwrites the cache with an empty list when the published live read finds no notes', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('stale-1')];
    _g.__cnTest.consumableNotes = [];
    const { rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await waitFor(() => expect(_g.__cnTest.kv[CACHE_KEY]).toEqual([]));
  });

  it('leaves the cache alone for a live read the hook has not published', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [makeCachedNote('stale-1')];
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'live-1' })];
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.kv[CACHE_KEY].map((n: any) => n.id)).toEqual(['stale-1']);
    expect(_g.__cnTest.puts).toBe(0);
  });

  it('writes the published list once, however many refreshes return it unchanged', async () => {
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'live-1' })];
    const { rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await waitFor(() => expect(_g.__cnTest.puts).toBe(1));

    await _g.__cnTest.lastFetchPromise;
    rerender();
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(_g.__cnTest.puts).toBe(1);
  });

  it('keeps a newer write marker when an older write fails, so an equal list is not written again', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let failFirstWrite: (error: Error) => void = () => {};
    _g.__cnTest.putOverride = (key: string, value: any) => {
      if (_g.__cnTest.puts === 1) {
        return new Promise<void>((_resolve, reject) => {
          failFirstWrite = reject;
        });
      }
      _g.__cnTest.kv[key] = value;
      return Promise.resolve();
    };
    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'first' })];
    const { rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await waitFor(() => expect(_g.__cnTest.puts).toBe(1));

    _g.__cnTest.consumableNotes = [makeMockNote({ id: 'second' })];
    rerender();
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await waitFor(() => expect(_g.__cnTest.puts).toBe(2));

    failFirstWrite(new Error('Storage unavailable'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(_g.__cnTest.puts).toBe(2);
    expect(_g.__cnTest.kv[CACHE_KEY].map((n: any) => n.id)).toEqual(['second']);
    warn.mockRestore();
  });

  it('keeps only the first 300 notes of the published order in the cache', async () => {
    _g.__cnTest.consumableNotes = Array.from({ length: 305 }, (_, index) =>
      makeMockNote({ id: `note-${String(index).padStart(3, '0')}` })
    );
    const { rerender } = renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    rerender();
    await waitFor(() => expect(_g.__cnTest.kv[CACHE_KEY]).toHaveLength(300));
    const ids = _g.__cnTest.kv[CACHE_KEY].map((n: any) => n.id);
    expect([ids[0], ids[299]]).toEqual(['note-000', 'note-299']);
  });

  it('orders both the cached and the live list by receivedAt, then by note id', async () => {
    _g.__cnTest.kv[CACHE_KEY] = [
      makeCachedNote('b-note', 10),
      makeCachedNote('newest', 30),
      makeCachedNote('a-note', 10)
    ];
    neverSettlingRead();
    const { result } = renderHook(() => useClaimableNotes('pk-1'));
    await waitFor(() => {
      expect(result.current.data?.map((n: any) => n.id)).toEqual(['newest', 'a-note', 'b-note']);
    });

    // Same order out of the live read, whatever order the client returned them in. Dates come from
    // each note's block once the read is done; a block with no known time leaves its note undated.
    _g.__cnTest.consumableNotes = [
      { ...makeMockNote({ id: 'b-note' }), blockNum: 1 },
      { ...makeMockNote({ id: 'undated' }), blockNum: 3 },
      { ...makeMockNote({ id: 'a-note' }), blockNum: 1 },
      { ...makeMockNote({ id: 'newest' }), blockNum: 2 }
    ];
    _g.__cnTest.getBlockTimestamps = jest.fn(
      async () =>
        new Map([
          [1, 10],
          [2, 30]
        ])
    );
    _g.__cnTest.proxyGetConsumableNotes = jest.fn(async () => _g.__cnTest.consumableNotes);
    renderHook(() => useClaimableNotes('pk-1'));
    await _g.__cnTest.lastFetchPromise;
    expect(_g.__cnTest.getBlockTimestamps).toHaveBeenCalledWith([1, 3, 1, 2], 'https://rpc-a.example');
    expect(_g.__cnTest.lastFetchData.map((n: any) => [n.id, n.receivedAt])).toEqual([
      ['newest', 30],
      ['a-note', 10],
      ['b-note', 10],
      ['undated', undefined]
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
