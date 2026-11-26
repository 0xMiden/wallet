/* eslint-disable import/first */

import React from 'react';

import { act, renderHook } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { __resetSyncFuseStateForTests, isSyncFused, noteSyncWatchdogEviction } from 'lib/miden/front/sync-fuse';
import {
  TOKENS_BASE_METADATA_STORAGE_KEY,
  TOKENS_METADATA_SCHEMA_STORAGE_KEY,
  TOKENS_METADATA_SCHEMA_VERSION
} from 'lib/miden/metadata/storage';
import { FUSED_SYNC_PROBE_INTERVAL_MS, MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';
import { _resetInteractionPriorityForTest } from 'lib/ui/interaction-priority';

const _g = globalThis as Record<string, any>;
_g.__cnSwrTest = {
  kv: {} as Record<string, any>,
  consumableNotes: [] as any[],
  proxyGetConsumableNotes: jest.fn(async () => [] as any[]),
  metadataCache: {} as Record<string, any>,
  metadataRef: { current: {} as Record<string, any> },
  fetchMetadata: jest.fn(async () => ({ decimals: 6, symbol: 'USDC', name: 'USD Coin' })),
  setTokensBaseMetadata: jest.fn(async (batch: Record<string, any>) => {
    _g.__cnSwrTest.metadataCache = { ..._g.__cnSwrTest.metadataCache, ...batch };
    _g.__cnSwrTest.metadataRef.current = _g.__cnSwrTest.metadataCache;
  }),
  tokenMetadataOverrides: {} as Record<string, any>
};

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  hasExtensionRuntime: () => false,
  isIOS: () => true
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'miden-faucet',
  getNativeAssetMetadataSync: () => ({ symbol: 'MIDEN', decimals: 6 })
}));

jest.mock('lib/store', () => {
  const fn = (selector: (s: any) => any) =>
    selector({
      extensionClaimableNotes: null,
      assetsMetadata: _g.__cnSwrTest.metadataCache,
      tokenMetadataOverrides: _g.__cnSwrTest.tokenMetadataOverrides
    });
  (fn as any).getState = () => ({
    tokenMetadataOverrides: _g.__cnSwrTest.tokenMetadataOverrides
  });
  return {
    useWalletStore: fn,
    getIntercom: () => ({ request: jest.fn() }),
    faucetMetadataOf: (faucetId: string) =>
      _g.__cnSwrTest.tokenMetadataOverrides[faucetId] === undefined ? _g.__cnSwrTest.metadataCache[faucetId] : undefined
  };
});

jest.mock('../assets', () => ({
  isMidenFaucet: jest.fn(async () => false)
}));

jest.mock('../helpers', () => ({
  toNoteTypeString: () => 'public'
}));

jest.mock('../metadata', () => ({
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
}));

jest.mock('../sdk/helpers', () => ({
  __esModule: true,
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (x: any) => (typeof x === 'string' ? x : 'bech-stub')
}));

jest.mock('./storage', () => ({
  fetchFromStorage: async (key: string) => _g.__cnSwrTest.kv[key] ?? null,
  putToStorage: async (key: string, value: any) => {
    _g.__cnSwrTest.kv[key] = value;
  }
}));

jest.mock('lib/miden-chain/block-timestamps', () => ({
  getBlockTimestamps: async () => new Map()
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'https://rpc.mainnet.miden.io',
  getEffectiveNetworkName: () => 'mainnet',
  getTestNetworkNameKey: () => 'mainnet'
}));

const mockRunWhenClientIdle = jest.fn();

jest.mock('./assets', () => ({
  useTokensMetadata: () => {
    _g.__cnSwrTest.metadataRef.current = _g.__cnSwrTest.metadataCache;
    return {
      allTokensBaseMetadataRef: _g.__cnSwrTest.metadataRef,
      fetchMetadata: (id: string) => _g.__cnSwrTest.fetchMetadata(id),
      setTokensBaseMetadata: (batch: any) => _g.__cnSwrTest.setTokensBaseMetadata(batch)
    };
  }
}));

jest.mock('../sdk/miden-client', () => ({
  getCurrentWasmLockHold: () => ({ id: 'hold-1' }),
  withWasmClientLock: async (fn: (hold: object) => Promise<any>) => fn({ id: 'hold-1' }),
  assertWasmHoldCurrent: jest.fn(),
  runWhenClientIdle: (fn: () => Promise<any>) => mockRunWhenClientIdle(fn)
}));

jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getConsumableNotes: (...a: any[]) => _g.__cnSwrTest.proxyGetConsumableNotes(...a),
    getPswapLineages: jest.fn(async () => [])
  }
}));

jest.mock('lib/miden/activity', () => ({
  getNoteHoldingTransactions: async () => []
}));

jest.mock('lib/miden/note-quarantine', () => ({
  getQuarantinedNoteIds: async () => new Set()
}));

jest.mock('lib/miden/swap/classification', () => ({
  classifySwapOrderNotes: async () => new Map(),
  isHeldBackPeerSwapPayback: () => false,
  isPeerSwapPayback: () => false,
  localSwapOrders: async () => [],
  swapOrderIdsOf: () => new Set()
}));

import { __resetClaimableNotesCacheForTests, useClaimableNotes } from './claimable-notes';
import { requestNotesRefresh } from './note-refresh';

function makeNote(id: string, faucetId = 'miden-faucet', amount = '100') {
  return {
    noteId: id,
    nullifier: `null-${id}`,
    noteType: 0,
    senderAccountId: 'sender-1',
    state: 2,
    assets: [{ faucetId, amount }],
    swapAttachment: null,
    standardPayment: true
  };
}

function createWrapper() {
  const sharedMap = new Map();
  const provider = () => sharedMap;
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <SWRConfig value={{ provider }}>{children}</SWRConfig>;
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe('useLocalClaimableNotes (real SWR integration)', () => {
  let visibilityState = 'visible';

  beforeEach(() => {
    jest.useFakeTimers();
    _resetInteractionPriorityForTest();
    __resetClaimableNotesCacheForTests();
    __resetSyncFuseStateForTests();
    visibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true
    });
    _g.__cnSwrTest.kv = {};
    _g.__cnSwrTest.consumableNotes = [];
    _g.__cnSwrTest.metadataCache = {};
    _g.__cnSwrTest.metadataRef.current = _g.__cnSwrTest.metadataCache;
    _g.__cnSwrTest.tokenMetadataOverrides = {};
    _g.__cnSwrTest.fetchMetadata.mockReset().mockResolvedValue({ decimals: 6, symbol: 'USDC', name: 'USD Coin' });
    _g.__cnSwrTest.setTokensBaseMetadata.mockReset().mockImplementation(async (batch: Record<string, any>) => {
      _g.__cnSwrTest.metadataCache = { ..._g.__cnSwrTest.metadataCache, ...batch };
      _g.__cnSwrTest.metadataRef.current = _g.__cnSwrTest.metadataCache;
    });
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => _g.__cnSwrTest.consumableNotes);
    mockRunWhenClientIdle.mockReset();
  });

  afterEach(async () => {
    // Ensure window is marked online in SWR's module listener before next test.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await flushMicrotasks();
    });
    jest.useRealTimers();
    _resetInteractionPriorityForTest();
  });

  it('recovers polling after an error lands while the app is hidden (Wi-Fi / online unchanged)', async () => {
    let calls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('hidden read failed');
      return [makeNote('note-recovered')];
    });

    visibilityState = 'hidden';
    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-hidden'), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);
    expect(result.current.data).toBeUndefined();

    // App returns to foreground/visible while navigator.onLine remained true.
    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(6_000);
      await flushMicrotasks();
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-recovered']);
  });

  it('recovers polling after an error lands while offline even if the browser misses the online event upon foreground', async () => {
    let calls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('wifi off');
      return [makeNote('note-after-wifi')];
    });

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await flushMicrotasks();
    });

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-offline'), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);
    expect(result.current.data).toBeUndefined();

    // Wi-Fi restored while WKWebView was suspended (navigator.onLine becomes true, focus/visibility fires, no online event).
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(6_000);
      await flushMicrotasks();
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-wifi']);
  });

  it('resumes polling automatically once isSyncFused clears even if an error retry ran while fused', async () => {
    let shouldFail = true;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      if (shouldFail) throw new Error('rpc parked');
      return [makeNote('note-after-fuse')];
    });

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-fused'), { wrapper });

    // First read fails while online/visible: SWR sets cache.error and schedules onErrorRetry.
    await act(async () => {
      await flushMicrotasks();
    });
    expect(_g.__cnSwrTest.proxyGetConsumableNotes).toHaveBeenCalledTimes(1);

    // Before onErrorRetry fires, claimable-notes fuse trips (e.g., from SwapSettlementManager or evictions).
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      noteSyncWatchdogEviction('claimable-notes');
    }
    expect(isSyncFused('claimable-notes')).toBe(true);

    // SWR's pending error retry timer fires during the fuse window and gets dropped by isPaused().
    await act(async () => {
      jest.advanceTimersByTime(20_000);
      await flushMicrotasks();
    });
    expect(_g.__cnSwrTest.proxyGetConsumableNotes).toHaveBeenCalledTimes(1);

    // Fuse expires 30 minutes later and node is healthy again.
    shouldFail = false;
    await act(async () => {
      jest.advanceTimersByTime(FUSED_SYNC_PROBE_INTERVAL_MS + 10_000);
      await flushMicrotasks();
    });

    expect(isSyncFused('claimable-notes')).toBe(false);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-fuse']);
  });

  it('continues recovering after more than 10 consecutive read failures', async () => {
    let calls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      calls++;
      if (calls <= 12) throw new Error(`transient error ${calls}`);
      return [makeNote('note-after-12-failures')];
    });

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-many-errors'), { wrapper });

    // Advance enough steps even if SWR exponential backoff were active (up to 30m+ per step).
    for (let step = 0; step < 30 && result.current.data === undefined; step++) {
      await act(async () => {
        jest.advanceTimersByTime(30 * 60_000);
        await flushMicrotasks();
      });
    }

    expect(calls).toBeGreaterThanOrEqual(13);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-12-failures']);
  });

  it('coalesces onNotesRefresh across multiple subscribers and does not discard an in-flight refresh read', async () => {
    let calls = 0;
    let resolveDeferred: ((notes: any[]) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve([]);
      if (calls === 2) {
        return new Promise<any[]>(resolve => {
          resolveDeferred = resolve;
        });
      }
      return Promise.resolve([makeNote('note-trailing')]);
    });

    const wrapper = createWrapper();
    const h1 = renderHook(() => useClaimableNotes('pk-shared'), { wrapper });
    const h2 = renderHook(() => useClaimableNotes('pk-shared'), { wrapper });
    const h3 = renderHook(() => useClaimableNotes('pk-shared'), { wrapper });
    const h4 = renderHook(() => useClaimableNotes('pk-shared'), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    // One requestNotesRefresh() across 4 active hooks must trigger only ONE fetch (not 4).
    await act(async () => {
      requestNotesRefresh();
      await flushMicrotasks();
    });
    expect(calls).toBe(2);

    // Another refresh arrives before the gated read resolves: must NOT overwrite FETCH[key] & discard note-in-flight.
    await act(async () => {
      requestNotesRefresh();
      await flushMicrotasks();
    });
    expect(calls).toBe(2);

    await act(async () => {
      resolveDeferred?.([makeNote('note-in-flight')]);
      await flushMicrotasks(12);
    });

    expect(h1.result.current.data?.map(n => n.id)).toEqual(['note-trailing']);
    expect(h2.result.current.data?.map(n => n.id)).toEqual(['note-trailing']);
    expect(h3.result.current.data?.map(n => n.id)).toEqual(['note-trailing']);
    expect(h4.result.current.data?.map(n => n.id)).toEqual(['note-trailing']);
    expect(calls).toBe(3);

    // Verify note-in-flight was actually accepted (written to cache) before trailing read landed, OR let's assert via non-overlapping second test:
    h1.unmount();
    h2.unmount();
    h3.unmount();
    h4.unmount();
  });

  it('publishes an in-flight refresh read before running the queued trailing refresh', async () => {
    let calls = 0;
    let resolveFirstRefresh: ((notes: any[]) => void) | null = null;
    let resolveTrailingRefresh: ((notes: any[]) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve([]);
      if (calls === 2) {
        return new Promise<any[]>(resolve => {
          resolveFirstRefresh = resolve;
        });
      }
      return new Promise<any[]>(resolve => {
        resolveTrailingRefresh = resolve;
      });
    });

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-trailing'), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    await act(async () => {
      requestNotesRefresh();
      await flushMicrotasks();
    });
    expect(calls).toBe(2);

    // Overlap a second refresh while call #2 is still in flight.
    await act(async () => {
      requestNotesRefresh();
      await flushMicrotasks();
    });
    expect(calls).toBe(2);

    // Resolving call #2 must publish ['note-first'] immediately (not be discarded by SWR).
    await act(async () => {
      resolveFirstRefresh?.([makeNote('note-first')]);
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['note-first']);
    expect(calls).toBe(3);

    await act(async () => {
      resolveTrailingRefresh?.([makeNote('note-second')]);
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['note-second']);
  });

  it('reads v2 persisted token metadata on cold launch before Zustand hydrates', async () => {
    _g.__cnSwrTest.kv[TOKENS_METADATA_SCHEMA_STORAGE_KEY] = TOKENS_METADATA_SCHEMA_VERSION;
    _g.__cnSwrTest.kv[TOKENS_BASE_METADATA_STORAGE_KEY] = {
      'usdc-faucet': { symbol: 'USDC', name: 'USD Coin', decimals: 6 }
    };
    _g.__cnSwrTest.consumableNotes = [makeNote('usdc-note-1', 'usdc-faucet', '5000000')];

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-meta-a'), { wrapper });

    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['usdc-note-1']);
  });

  it('refreshes immediately when idle metadata prefetch persists new token metadata', async () => {
    _g.__cnSwrTest.consumableNotes = [makeNote('usdc-note-2', 'fresh-usdc', '2500000')];

    const { result } = renderHook(() => useClaimableNotes('pk-meta-b'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);

    // Complete background metadata fetch within SWR's 10s deduping window (100ms << 10_000ms).
    await act(async () => {
      await mockRunWhenClientIdle.mock.calls[0]![0]();
      jest.advanceTimersByTime(100);
      await flushMicrotasks(12);
    });

    expect(result.current.data?.map(n => n.id)).toEqual(['usdc-note-2']);
  });
});
