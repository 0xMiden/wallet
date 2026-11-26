/* eslint-disable import/first */

import React from 'react';

import { act, render, renderHook } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';

import { __resetSyncFuseStateForTests, isSyncFused, noteSyncWatchdogEviction } from 'lib/miden/front/sync-fuse';
import * as nativeMetadata from 'lib/miden/metadata/native';
import {
  TOKENS_BASE_METADATA_STORAGE_KEY,
  TOKENS_METADATA_SCHEMA_STORAGE_KEY,
  TOKENS_METADATA_SCHEMA_VERSION
} from 'lib/miden/metadata/storage';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { FUSED_SYNC_PROBE_INTERVAL_MS, MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';
import { _resetInteractionPriorityForTest, beginInteraction } from 'lib/ui/interaction-priority';

const _g = globalThis as Record<string, any>;
_g.__cnSwrTest = {
  isExtension: false,
  hasExtensionRuntime: false,
  extensionClaimableNotes: null as any,
  nativeAssetId: 'miden-faucet',
  faucetMetadataOfOverride: null as ((faucetId: string) => any) | null,
  kv: {} as Record<string, any>,
  fetchFromStorageCalls: [] as string[],
  fetchFromStorageFailKey: null as string | null,
  fetchFromStorageOverride: null as ((key: string) => Promise<any>) | null,
  classifySwapOrderNotes: jest.fn(async () => new Map()),
  putToStorageCalls: [] as Array<{ key: string; value: any }>,
  consumableNotes: [] as any[],
  proxyGetConsumableNotes: jest.fn(async () => [] as any[]),
  intercomRequest: jest.fn(async () => undefined),
  getNoteHoldingTransactions: jest.fn(async () => [] as any[]),
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
  isExtension: () => _g.__cnSwrTest.isExtension,
  hasExtensionRuntime: () => _g.__cnSwrTest.hasExtensionRuntime,
  isIOS: () => true
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => _g.__cnSwrTest.nativeAssetId,
  getNativeAssetMetadataSync: () => ({ symbol: 'MIDEN', decimals: 6 })
}));

jest.mock('lib/miden/metadata/native', () => {
  const actual = jest.requireActual('lib/miden/metadata/native');
  return {
    __esModule: true,
    ...actual,
    getNativeDisplayMetadataSync: jest.fn((...args: any[]) => actual.getNativeDisplayMetadataSync(...args))
  };
});

jest.mock('lib/store', () => {
  const fn = (selector: (s: any) => any) =>
    selector({
      extensionClaimableNotes: _g.__cnSwrTest.extensionClaimableNotes,
      assetsMetadata: _g.__cnSwrTest.metadataCache,
      tokenMetadataOverrides: _g.__cnSwrTest.tokenMetadataOverrides
    });
  (fn as any).getState = () => ({
    tokenMetadataOverrides: _g.__cnSwrTest.tokenMetadataOverrides
  });
  return {
    useWalletStore: fn,
    getIntercom: () => ({ request: (...a: any[]) => _g.__cnSwrTest.intercomRequest(...a) }),
    faucetMetadataOf: (faucetId: string) =>
      _g.__cnSwrTest.faucetMetadataOfOverride
        ? _g.__cnSwrTest.faucetMetadataOfOverride(faucetId)
        : _g.__cnSwrTest.tokenMetadataOverrides &&
            typeof _g.__cnSwrTest.tokenMetadataOverrides === 'object' &&
            Object.prototype.hasOwnProperty.call(_g.__cnSwrTest.tokenMetadataOverrides, faucetId)
          ? undefined
          : _g.__cnSwrTest.metadataCache &&
              typeof _g.__cnSwrTest.metadataCache === 'object' &&
              Object.prototype.hasOwnProperty.call(_g.__cnSwrTest.metadataCache, faucetId)
            ? _g.__cnSwrTest.metadataCache[faucetId]
            : undefined
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
  fetchFromStorage: async (key: string) => {
    _g.__cnSwrTest.fetchFromStorageCalls.push(key);
    if (_g.__cnSwrTest.fetchFromStorageOverride) {
      return _g.__cnSwrTest.fetchFromStorageOverride(key);
    }
    if (_g.__cnSwrTest.fetchFromStorageFailKey === key) {
      throw new Error(`storage read failed: ${key}`);
    }
    return Object.prototype.hasOwnProperty.call(_g.__cnSwrTest.kv, key) ? _g.__cnSwrTest.kv[key] : null;
  },
  putToStorage: async (key: string, value: any) => {
    _g.__cnSwrTest.putToStorageCalls.push({ key, value });
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
  getNoteHoldingTransactions: (...a: any[]) => _g.__cnSwrTest.getNoteHoldingTransactions(...a)
}));

jest.mock('lib/miden/note-quarantine', () => ({
  getQuarantinedNoteIds: async () => new Set()
}));

jest.mock('lib/miden/swap/classification', () => ({
  classifySwapOrderNotes: (...a: any[]) => _g.__cnSwrTest.classifySwapOrderNotes(...a),
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
    _g.__cnSwrTest.isExtension = false;
    _g.__cnSwrTest.hasExtensionRuntime = false;
    _g.__cnSwrTest.extensionClaimableNotes = null;
    _g.__cnSwrTest.nativeAssetId = 'miden-faucet';
    _g.__cnSwrTest.faucetMetadataOfOverride = null;
    _g.__cnSwrTest.kv = {};
    _g.__cnSwrTest.fetchFromStorageCalls = [];
    _g.__cnSwrTest.fetchFromStorageFailKey = null;
    _g.__cnSwrTest.fetchFromStorageOverride = null;
    _g.__cnSwrTest.classifySwapOrderNotes = jest.fn(async () => new Map());
    _g.__cnSwrTest.putToStorageCalls = [];
    _g.__cnSwrTest.consumableNotes = [];
    _g.__cnSwrTest.metadataCache = {};
    _g.__cnSwrTest.metadataRef.current = _g.__cnSwrTest.metadataCache;
    _g.__cnSwrTest.tokenMetadataOverrides = {};
    _g.__cnSwrTest.intercomRequest = jest.fn(async () => undefined);
    _g.__cnSwrTest.getNoteHoldingTransactions = jest.fn(async () => []);
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

    // App returns to foreground/visible while navigator.onLine remained true; recovers below 5_000 ms.
    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(100);
      await flushMicrotasks(12);
    });

    expect(calls).toBe(2);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-recovered']);
  });

  it('recovers polling after an error lands while offline even if the browser misses the online event upon foreground', async () => {
    let calls = 0;
    let pollNote = false;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('wifi off');
      return pollNote ? [makeNote('note-after-wifi'), makeNote('note-next-poll')] : [makeNote('note-after-wifi')];
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

    // Wi-Fi restored while WKWebView was suspended: focus recovers below 5_000 ms without waiting for interval.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(100);
      await flushMicrotasks(12);
    });

    expect(calls).toBe(2);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-wifi']);

    // Ongoing refreshInterval polling must keep working even though SWR's internal online state stayed stale.
    pollNote = true;
    for (let step = 0; step < 3; step++) {
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await flushMicrotasks(12);
      });
    }

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result.current.data?.map(n => n.id)).toContain('note-next-poll');
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

  it('deduplicates mount reads against overlapping refreshInterval, online reconnect, requestNotesRefresh, and mutate()', async () => {
    let calls = 0;
    let resolveMount: ((notes: any[]) => void) | null = null;
    let resolveTrailing: ((notes: any[]) => void) | null = null;
    let resolveMutateOnlyTrailing: ((notes: any[]) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => {
      calls++;
      if (calls === 1) {
        return new Promise<any[]>(resolve => {
          resolveMount = resolve;
        });
      }
      if (calls === 2) {
        return new Promise<any[]>(resolve => {
          resolveTrailing = resolve;
        });
      }
      return new Promise<any[]>(resolve => {
        resolveMutateOnlyTrailing = resolve;
      });
    });

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-concurrent-mount'), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    // Advance past refreshInterval (15s) and dispatch online while mount read is still active.
    await act(async () => {
      jest.advanceTimersByTime(15_000);
      window.dispatchEvent(new Event('online'));
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    // Trigger both event-bus refresh and direct mutate() while mount read is still in flight.
    await act(async () => {
      requestNotesRefresh();
      void result.current.mutate();
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    // Mount read publishes ['note-mount'] immediately; only one trailing read runs afterward.
    await act(async () => {
      resolveMount?.([makeNote('note-mount')]);
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['note-mount']);
    expect(calls).toBe(2);

    // Overlap call #2 with ONLY direct result.current.mutate() (no requestNotesRefresh) to verify coordinatedMutate queueing.
    let mutateOnlyDone = false;
    await act(async () => {
      void result.current.mutate().then(() => {
        mutateOnlyDone = true;
      });
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(mutateOnlyDone).toBe(false);

    await act(async () => {
      resolveTrailing?.([makeNote('note-after-mount')]);
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-mount']);
    expect(calls).toBe(3);
    expect(mutateOnlyDone).toBe(false);

    await act(async () => {
      resolveMutateOnlyTrailing?.([makeNote('note-after-mutate-only')]);
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-mutate-only']);
    expect(mutateOnlyDone).toBe(true);
  });

  it('preserves swrResult.error when an in-flight mount failure overlaps refreshInterval', async () => {
    let calls = 0;
    let rejectMount: ((err: Error) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => {
      calls++;
      if (calls === 1) {
        return new Promise<any[]>((_resolve, reject) => {
          rejectMount = reject;
        });
      }
      return Promise.resolve([makeNote('note-after-mount-err')]);
    });

    const wrapper = createWrapper();
    const { result } = renderHook(() => useClaimableNotes('pk-mount-error'), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(15_000);
      window.dispatchEvent(new Event('online'));
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    await act(async () => {
      rejectMount?.(new Error('mount failed'));
      await flushMicrotasks(12);
    });
    const mountError = 'error' in result.current ? result.current.error : undefined;
    expect(mountError).toBeInstanceOf(Error);
    expect(mountError instanceof Error ? mountError.message : undefined).toBe('mount failed');

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks(12);
    });
    expect(calls).toBe(2);
    expect(result.current.data?.map(n => n.id)).toEqual(['note-after-mount-err']);
  });

  it('guards disabled local and extension mutate() and resets coordinator tracking in __resetClaimableNotesCacheForTests', async () => {
    let calls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      calls++;
      return [makeNote('note-enabled')];
    });

    const wrapper = createWrapper();
    const active = renderHook(() => useClaimableNotes('pk-disabled-guard'), { wrapper });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(calls).toBe(1);

    const disabledLocal = renderHook(() => useClaimableNotes('pk-disabled-guard', false), { wrapper });
    await act(async () => {
      await disabledLocal.result.current.mutate();
      await flushMicrotasks(12);
    });
    expect(calls).toBe(1);
    active.unmount();
    disabledLocal.unmount();

    // Extension realm disabled hook mutate() (and enabled -> disabled toggle) must not emit SyncRequest or query holding txs.
    _g.__cnSwrTest.intercomRequest.mockClear();
    _g.__cnSwrTest.getNoteHoldingTransactions.mockClear();
    _g.__cnSwrTest.isExtension = true;
    _g.__cnSwrTest.hasExtensionRuntime = true;
    const extWrapper = createWrapper();
    const extHook = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) => useClaimableNotes('pk-ext-disabled', isEnabled),
      { initialProps: { isEnabled: true }, wrapper: extWrapper }
    );
    await act(async () => {
      await flushMicrotasks();
    });
    _g.__cnSwrTest.intercomRequest.mockClear();
    _g.__cnSwrTest.getNoteHoldingTransactions.mockClear();
    extHook.rerender({ isEnabled: false });
    await act(async () => {
      await extHook.result.current.mutate();
      await flushMicrotasks();
    });
    expect(_g.__cnSwrTest.intercomRequest).not.toHaveBeenCalled();
    expect(_g.__cnSwrTest.getNoteHoldingTransactions).not.toHaveBeenCalled();
    extHook.unmount();
    _g.__cnSwrTest.isExtension = false;
    _g.__cnSwrTest.hasExtensionRuntime = false;

    // Resolving pending trailing promise on disposeCoordinator / __resetClaimableNotesCacheForTests().
    let resolveNeverSettling: ((notes: any[]) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(
      () =>
        new Promise<any[]>(resolve => {
          resolveNeverSettling = resolve;
        })
    );
    const trailingDisposeWrapper = createWrapper();
    const trailingHook = renderHook(() => useClaimableNotes('pk-dispose-trailing'), {
      wrapper: trailingDisposeWrapper
    });
    await act(async () => {
      await flushMicrotasks();
    });
    let trailingDisposedResolved = false;
    const pendingTrailing = trailingHook.result.current.mutate().then(() => {
      trailingDisposedResolved = true;
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(trailingDisposedResolved).toBe(false);
    __resetClaimableNotesCacheForTests();
    await act(async () => {
      await pendingTrailing;
      resolveNeverSettling?.([]);
      await flushMicrotasks();
    });
    expect(trailingDisposedResolved).toBe(true);
    trailingHook.unmount();

    // Un-unmounted createRoot cleared by __resetClaimableNotesCacheForTests() must abort paused reads cleanly.
    const endInteraction = beginInteraction();
    let resetCalls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      resetCalls++;
      return [makeNote('should-not-run')];
    });
    const leakWrapper = createWrapper();
    function DetachedChild() {
      useClaimableNotes('pk-reset-leak');
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      flushSync(() => {
        root.render(React.createElement(leakWrapper, null, React.createElement(DetachedChild)));
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(resetCalls).toBe(0);

      __resetClaimableNotesCacheForTests();
      endInteraction();
      await act(async () => {
        jest.advanceTimersByTime(50);
        await flushMicrotasks(12);
      });
      expect(resetCalls).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('runs cold-mount and synchronous pre-effect requestNotesRefresh under createRoot and parent useLayoutEffect', async () => {
    let createRootCalls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      createRootCalls++;
      return [makeNote(`root-note-${createRootCalls}`)];
    });

    const rootWrapper = createWrapper();
    function RootReader() {
      useClaimableNotes('pk-create-root');
      return null;
    }
    function LayoutRefreshParent({ children }: { children: React.ReactNode }) {
      React.useLayoutEffect(() => {
        requestNotesRefresh();
      }, []);
      return React.createElement(React.Fragment, null, children);
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      flushSync(() => {
        root.render(React.createElement(rootWrapper, null, React.createElement(RootReader)));
      });
      await act(async () => {
        await flushMicrotasks(20);
      });
      expect(createRootCalls).toBe(1);

      // Unmount RootReader only (keeping SWRConfig cache warm within dedupingInterval), then remount with parent useLayoutEffect.
      flushSync(() => {
        root.render(React.createElement(rootWrapper, null));
      });
      flushSync(() => {
        root.render(
          React.createElement(
            rootWrapper,
            null,
            React.createElement(LayoutRefreshParent, null, React.createElement(RootReader))
          )
        );
      });
      await act(async () => {
        await flushMicrotasks(20);
      });
      expect(createRootCalls).toBe(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('continues feeding co-subscriber h2 when h1 unmounts while paused in whenInteractionIdle()', async () => {
    let cosubCalls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      cosubCalls++;
      return [makeNote('note-cosub')];
    });
    const cosubWrapper = createWrapper();
    let h2Data: any;
    function Sub1() {
      useClaimableNotes('pk-cosub');
      return null;
    }
    function Sub2() {
      h2Data = useClaimableNotes('pk-cosub').data;
      return null;
    }
    const endCosubInteraction = beginInteraction();
    const view = render(React.createElement(cosubWrapper, null, React.createElement(Sub1), React.createElement(Sub2)));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(cosubCalls).toBe(0);

    // Unmount Sub1 only while Sub2 and the shared SWRConfig provider stay mounted.
    view.rerender(React.createElement(cosubWrapper, null, React.createElement(Sub2)));
    endCosubInteraction();
    await act(async () => {
      jest.advanceTimersByTime(50);
      await flushMicrotasks(12);
    });
    expect(cosubCalls).toBe(1);
    expect(h2Data?.map((n: any) => n.id)).toEqual(['note-cosub']);
    view.unmount();
  });

  it('completes idle-gate M1-M2 handoff for mutate() queued while paused in whenInteractionIdle()', async () => {
    let handoffCalls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      handoffCalls++;
      return [makeNote('note-idle-handoff')];
    });
    const handoffWrapper = createWrapper();
    const endHandoffInteraction = beginInteraction();
    const hHandoff = renderHook(() => useClaimableNotes('pk-idle-handoff'), { wrapper: handoffWrapper });
    let refreshSettled = false;
    await act(async () => {
      await flushMicrotasks();
      void hHandoff.result.current.mutate().then(() => {
        refreshSettled = true;
      });
      await flushMicrotasks();
    });
    expect(handoffCalls).toBe(0);
    expect(refreshSettled).toBe(false);

    endHandoffInteraction();
    await act(async () => {
      jest.advanceTimersByTime(50);
      await flushMicrotasks(16);
    });
    expect(handoffCalls).toBe(1);
    expect(hHandoff.result.current.data?.map(n => n.id)).toEqual(['note-idle-handoff']);
    expect(refreshSettled).toBe(true);
    hHandoff.unmount();
  });

  it('aborts idle read on account switch without wiping cached fallback and revalidates immediately on switch-back', async () => {
    const keyA = 'claimable_notes:v1:https://rpc.mainnet.miden.io|mainnet:pk-a';
    const cachedNoteA = {
      id: 'cached-a',
      faucetId: 'miden-faucet',
      amount: '100',
      senderAddress: 'sender-1',
      isBeingClaimed: false,
      type: 'public',
      standardPayment: true,
      metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
    };
    _g.__cnSwrTest.kv[keyA] = [cachedNoteA];

    let activeExpectedPk = 'pk-b';
    const callsByPhase: string[] = [];
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      callsByPhase.push(activeExpectedPk);
      return activeExpectedPk === 'pk-b' ? [makeNote('live-b')] : [makeNote('live-a')];
    });

    const endInteraction = beginInteraction();
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(({ pk }: { pk: string }) => useClaimableNotes(pk), {
      initialProps: { pk: 'pk-a' },
      wrapper
    });

    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(result.current.data?.map(n => n.id)).toEqual(['cached-a']);
    expect(callsByPhase).toEqual([]);

    // Switch to pk-b while pk-a was still waiting in whenInteractionIdle().
    rerender({ pk: 'pk-b' });
    endInteraction();
    await act(async () => {
      jest.advanceTimersByTime(50);
      await flushMicrotasks(12);
    });

    // pk-a aborted before reading client, preserved cached storage, and never wrote [].
    expect(callsByPhase).toEqual(['pk-b']);
    expect(_g.__cnSwrTest.kv[keyA]?.map((n: any) => n.id)).toEqual(['cached-a']);
    expect(
      _g.__cnSwrTest.putToStorageCalls.some(
        (c: { key: string; value: unknown }) => c.key === keyA && Array.isArray(c.value) && c.value.length === 0
      )
    ).toBe(false);

    // Switch back to pk-a well within SWR's 10_000 ms dedupingInterval -> must revalidate immediately.
    activeExpectedPk = 'pk-a';
    await act(async () => {
      jest.advanceTimersByTime(100);
      rerender({ pk: 'pk-a' });
      await flushMicrotasks(12);
    });

    expect(callsByPhase).toEqual(['pk-b', 'pk-a']);
    expect(result.current.data?.map(n => n.id)).toEqual(['live-a']);
  });

  it('does not double-poll on slow (>= 5_000 ms) recovery reads and enforces a 5_000 ms cooldown after slow failures', async () => {
    // 1) Slow recovery success must NOT launch a spurious call #3.
    let calls = 0;
    let resolveSlowSuccess: ((notes: any[]) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('initial err'));
      if (calls === 2) {
        return new Promise<any[]>(resolve => {
          resolveSlowSuccess = resolve;
        });
      }
      return Promise.resolve([makeNote('spurious-third')]);
    });

    const wrapper = createWrapper();
    const hOk = renderHook(() => useClaimableNotes('pk-slow-recovery-ok'), { wrapper });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    // Trigger recovery retry after 5_000 ms, then advance 12_000 ms while call #2 is still running.
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      jest.advanceTimersByTime(12_000);
      await flushMicrotasks();
    });
    expect(calls).toBe(2);

    await act(async () => {
      resolveSlowSuccess?.([makeNote('note-slow-ok')]);
      await flushMicrotasks(12);
    });
    expect(calls).toBe(2);
    expect(hOk.result.current.data?.map(n => n.id)).toEqual(['note-slow-ok']);
    hOk.unmount();

    // 2) Consecutive slow failure waits a full 5_000 ms cooldown AFTER settlement (never 0 ms spin).
    let failCalls = 0;
    let rejectSlowFail: ((err: Error) => void) | null = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => {
      failCalls++;
      if (failCalls === 1) return Promise.reject(new Error('err-1'));
      if (failCalls === 2) {
        return new Promise<any[]>((_resolve, reject) => {
          rejectSlowFail = reject;
        });
      }
      return Promise.resolve([makeNote('note-after-cooldown')]);
    });

    const hFail = renderHook(() => useClaimableNotes('pk-slow-recovery-fail'), { wrapper });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(failCalls).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      jest.advanceTimersByTime(6_000);
      await flushMicrotasks();
    });
    expect(failCalls).toBe(2);

    await act(async () => {
      rejectSlowFail?.(new Error('err-2'));
      await flushMicrotasks(12);
    });
    expect(failCalls).toBe(2);

    await act(async () => {
      jest.advanceTimersByTime(4_900);
      await flushMicrotasks(12);
    });
    expect(failCalls).toBe(2);

    await act(async () => {
      jest.advanceTimersByTime(200);
      await flushMicrotasks(12);
    });
    expect(failCalls).toBe(3);
    expect(hFail.result.current.data?.map(n => n.id)).toEqual(['note-after-cooldown']);
    hFail.unmount();
  });

  it('recovers immediately on online wake (< 5_000 ms) and cleans up wake listeners on recovery and unmount', async () => {
    const winAddSpy = jest.spyOn(window, 'addEventListener');
    const winRemoveSpy = jest.spyOn(window, 'removeEventListener');
    const docAddSpy = jest.spyOn(document, 'addEventListener');
    const docRemoveSpy = jest.spyOn(document, 'removeEventListener');

    try {
      let calls = 0;
      _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('offline err');
        return [makeNote('note-online-wake')];
      });

      const wrapper = createWrapper();
      const { result, unmount } = renderHook(() => useClaimableNotes('pk-wake-online'), { wrapper });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(calls).toBe(1);

      const addedOnlineBefore = winAddSpy.mock.calls.filter(c => String(c[0]) === 'online').map(c => c[1]);
      const addedFocusBefore = winAddSpy.mock.calls.filter(c => String(c[0]) === 'focus').map(c => c[1]);
      const addedVisBefore = docAddSpy.mock.calls.filter(c => String(c[0]) === 'visibilitychange').map(c => c[1]);
      expect(addedOnlineBefore.length).toBeGreaterThanOrEqual(1);
      expect(addedFocusBefore.length).toBeGreaterThanOrEqual(1);
      expect(addedVisBefore.length).toBeGreaterThanOrEqual(1);

      await act(async () => {
        window.dispatchEvent(new Event('online'));
        jest.advanceTimersByTime(100);
        await flushMicrotasks(12);
      });
      expect(calls).toBe(2);
      expect(result.current.data?.map(n => n.id)).toEqual(['note-online-wake']);

      // Listeners added by claimable-notes error recovery must be removed once recovered.
      const onlineListener = addedOnlineBefore[addedOnlineBefore.length - 1];
      const focusListener = addedFocusBefore[addedFocusBefore.length - 1];
      const visListener = addedVisBefore[addedVisBefore.length - 1];
      expect(winRemoveSpy.mock.calls.some(c => String(c[0]) === 'online' && c[1] === onlineListener)).toBe(true);
      expect(winRemoveSpy.mock.calls.some(c => String(c[0]) === 'focus' && c[1] === focusListener)).toBe(true);
      expect(docRemoveSpy.mock.calls.some(c => String(c[0]) === 'visibilitychange' && c[1] === visListener)).toBe(true);
      unmount();

      // Unmount while still errored must also remove all 3 wake listeners and stop retrying.
      winAddSpy.mockClear();
      winRemoveSpy.mockClear();
      docAddSpy.mockClear();
      docRemoveSpy.mockClear();

      let failAlwaysCalls = 0;
      _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
        failAlwaysCalls++;
        throw new Error('persistent err');
      });
      const hUnmount = renderHook(() => useClaimableNotes('pk-wake-unmount'), { wrapper });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(failAlwaysCalls).toBe(1);

      const uOnline = winAddSpy.mock.calls
        .filter(c => String(c[0]) === 'online')
        .map(c => c[1])
        .pop();
      const uFocus = winAddSpy.mock.calls
        .filter(c => String(c[0]) === 'focus')
        .map(c => c[1])
        .pop();
      const uVis = docAddSpy.mock.calls
        .filter(c => String(c[0]) === 'visibilitychange')
        .map(c => c[1])
        .pop();
      expect(uOnline).toBeDefined();
      expect(uFocus).toBeDefined();
      expect(uVis).toBeDefined();

      hUnmount.unmount();
      expect(winRemoveSpy.mock.calls.some(c => String(c[0]) === 'online' && c[1] === uOnline)).toBe(true);
      expect(winRemoveSpy.mock.calls.some(c => String(c[0]) === 'focus' && c[1] === uFocus)).toBe(true);
      expect(docRemoveSpy.mock.calls.some(c => String(c[0]) === 'visibilitychange' && c[1] === uVis)).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(20_000);
        await flushMicrotasks(12);
      });
      expect(failAlwaysCalls).toBe(1);
    } finally {
      winAddSpy.mockRestore();
      winRemoveSpy.mockRestore();
      docAddSpy.mockRestore();
      docRemoveSpy.mockRestore();
    }
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
    expect(mockRunWhenClientIdle).not.toHaveBeenCalled();
    expect(
      _g.__cnSwrTest.fetchFromStorageCalls.filter((key: string) => key === TOKENS_BASE_METADATA_STORAGE_KEY)
    ).toHaveLength(1);
  });

  it('publishes ready native notes without awaiting deferred v2 metadata storage reads or repeating storage queries', async () => {
    let schemaReadCount = 0;
    let resolveSchemaRead: ((val: unknown) => void) | null = null;
    _g.__cnSwrTest.consumableNotes = [
      makeNote('native-ready-1', _g.__cnSwrTest.nativeAssetId, '1000000'),
      makeNote('unknown-token-1', 'unknown-faucet-deferred', '5000000')
    ];
    _g.__cnSwrTest.fetchFromStorageOverride = (key: string) => {
      if (key === TOKENS_METADATA_SCHEMA_STORAGE_KEY) {
        schemaReadCount++;
        return new Promise(resolve => {
          resolveSchemaRead = resolve;
        });
      }
      if (key === TOKENS_BASE_METADATA_STORAGE_KEY) {
        return Promise.resolve({
          'unknown-faucet-deferred': { symbol: 'USDC', name: 'USD Coin', decimals: 6 }
        });
      }
      return Promise.resolve(_g.__cnSwrTest.kv[key] ?? null);
    };

    try {
      const { result } = renderHook(() => useClaimableNotes('pk-native-not-blocked'), {
        wrapper: createWrapper()
      });

      await act(async () => {
        await flushMicrotasks(16);
      });

      expect(result.current.data?.map(n => n.id)).toEqual(['native-ready-1']);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFallback).toBe(false);
      expect(result.current.data?.[0]?.fromCache).toBeUndefined();
      expect(schemaReadCount).toBe(1);

      await act(async () => {
        requestNotesRefresh();
        jest.advanceTimersByTime(6_000);
        await flushMicrotasks(16);
      });
      expect(result.current.data?.map(n => n.id)).toEqual(['native-ready-1']);
      expect(result.current.isFallback).toBe(false);
      expect(result.current.data?.[0]?.fromCache).toBeUndefined();
      expect(schemaReadCount).toBe(1);

      await act(async () => {
        resolveSchemaRead?.(TOKENS_METADATA_SCHEMA_VERSION);
        await flushMicrotasks(32);
      });
      expect(schemaReadCount).toBe(1);
      expect(result.current.data?.map(n => n.id)).toEqual(['native-ready-1', 'unknown-token-1']);
      expect(result.current.data?.find(n => n.id === 'unknown-token-1')?.metadata).toEqual({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6
      });
      expect(result.current.isFallback).toBe(false);
      expect(result.current.data?.every(n => !n.fromCache)).toBe(true);
      expect(mockRunWhenClientIdle).not.toHaveBeenCalled();
    } finally {
      _g.__cnSwrTest.fetchFromStorageOverride = null;
    }
  });

  it('does not leak or spuriously refresh when deferred v2 metadata resolves after account switch', async () => {
    let schemaReadCount = 0;
    let resolveSchemaRead: ((val: unknown) => void) | null = null;
    const notesCallsByAccount: string[] = [];
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async (address: string) => {
      notesCallsByAccount.push(address);
      if (address === 'pk-switch-a') {
        return [
          makeNote('native-a', _g.__cnSwrTest.nativeAssetId, '1000000'),
          makeNote('unknown-a', 'faucet-switch-a', '5000000')
        ];
      }
      return [makeNote('native-b', _g.__cnSwrTest.nativeAssetId, '2000000')];
    });
    _g.__cnSwrTest.fetchFromStorageOverride = (key: string) => {
      if (key === TOKENS_METADATA_SCHEMA_STORAGE_KEY) {
        schemaReadCount++;
        return new Promise(resolve => {
          resolveSchemaRead = resolve;
        });
      }
      if (key === TOKENS_BASE_METADATA_STORAGE_KEY) {
        return Promise.resolve({
          'faucet-switch-a': { symbol: 'SW', name: 'Switch', decimals: 6 }
        });
      }
      return Promise.resolve(_g.__cnSwrTest.kv[key] ?? null);
    };

    try {
      const wrapper = createWrapper();
      const { result, rerender } = renderHook(({ addr }) => useClaimableNotes(addr), {
        initialProps: { addr: 'pk-switch-a' },
        wrapper
      });

      await act(async () => {
        await flushMicrotasks(16);
      });
      expect(result.current.data?.map(n => n.id)).toEqual(['native-a']);
      expect(result.current.isLoading).toBe(false);
      expect(schemaReadCount).toBe(1);

      rerender({ addr: 'pk-switch-b' });
      await act(async () => {
        await flushMicrotasks(16);
      });
      expect(result.current.data?.map(n => n.id)).toEqual(['native-b']);
      expect(result.current.isLoading).toBe(false);
      const callsBeforeResolve = [...notesCallsByAccount];

      await act(async () => {
        resolveSchemaRead?.(TOKENS_METADATA_SCHEMA_VERSION);
        await flushMicrotasks(32);
      });

      expect(result.current.data?.map(n => n.id)).toEqual(['native-b']);
      expect(notesCallsByAccount).toEqual(callsBeforeResolve);
      expect(schemaReadCount).toBe(1);
    } finally {
      _g.__cnSwrTest.fetchFromStorageOverride = null;
    }
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

  it('drops corrupted v2 schema versions, array caches, and malformed AssetMetadata entries', async () => {
    // 1) NaN schema version must be rejected (Number.isFinite guard).
    _g.__cnSwrTest.kv[TOKENS_METADATA_SCHEMA_STORAGE_KEY] = Number.NaN;
    _g.__cnSwrTest.kv[TOKENS_BASE_METADATA_STORAGE_KEY] = {
      'usdc-nan': { symbol: 'USDC', name: 'USD Coin', decimals: 6 }
    };
    _g.__cnSwrTest.consumableNotes = [makeNote('n-nan', 'usdc-nan', '100')];
    const hNan = renderHook(() => useClaimableNotes('pk-meta-nan'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hNan.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hNan.unmount();

    // 2) Legacy < 2 schema version must be rejected.
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.kv[TOKENS_METADATA_SCHEMA_STORAGE_KEY] = TOKENS_METADATA_SCHEMA_VERSION - 1;
    _g.__cnSwrTest.kv[TOKENS_BASE_METADATA_STORAGE_KEY] = {
      'usdc-v1': { symbol: 'OLD', name: 'Old Coin', decimals: 6 }
    };
    _g.__cnSwrTest.consumableNotes = [makeNote('n-v1', 'usdc-v1', '100')];
    const hV1 = renderHook(() => useClaimableNotes('pk-meta-v1'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hV1.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hV1.unmount();

    // 3) Array in TOKENS_BASE_METADATA_STORAGE_KEY must be ignored (!Array.isArray).
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.kv[TOKENS_METADATA_SCHEMA_STORAGE_KEY] = TOKENS_METADATA_SCHEMA_VERSION;
    _g.__cnSwrTest.kv[TOKENS_BASE_METADATA_STORAGE_KEY] = [{ symbol: 'ARR', name: 'Array Coin', decimals: 6 }];
    _g.__cnSwrTest.consumableNotes = [makeNote('n-arr', '0', '100')];
    const hArr = renderHook(() => useClaimableNotes('pk-meta-arr'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hArr.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hArr.unmount();

    // 4) Malformed AssetMetadata entries (decimals < 0, float, > 255, non-string symbol) must be dropped.
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.kv[TOKENS_METADATA_SCHEMA_STORAGE_KEY] = TOKENS_METADATA_SCHEMA_VERSION;
    _g.__cnSwrTest.kv[TOKENS_BASE_METADATA_STORAGE_KEY] = {
      'bad-neg': { symbol: 'NEG', name: 'Neg', decimals: -1 },
      'bad-float': { symbol: 'FLT', name: 'Float', decimals: 6.5 },
      'bad-max': { symbol: 'MAX', name: 'Max', decimals: 256 },
      'bad-sym': { symbol: 123, name: 'Sym', decimals: 6 }
    };
    _g.__cnSwrTest.consumableNotes = [
      makeNote('n-neg', 'bad-neg', '100'),
      makeNote('n-flt', 'bad-float', '100'),
      makeNote('n-max', 'bad-max', '100'),
      makeNote('n-sym', 'bad-sym', '100')
    ];
    const hBad = renderHook(() => useClaimableNotes('pk-meta-bad'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hBad.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hBad.unmount();

    // 5) Storage read error in readStoredV2Metadata must safely return an empty Map.
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.fetchFromStorageFailKey = TOKENS_METADATA_SCHEMA_STORAGE_KEY;
    _g.__cnSwrTest.consumableNotes = [makeNote('n-storage-err', 'f-err', '100')];
    const hErr = renderHook(() => useClaimableNotes('pk-meta-storage-err'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hErr.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hErr.unmount();
    _g.__cnSwrTest.fetchFromStorageFailKey = null;
  });

  it('validates faucetMetadataOf return, guards native arm and overrides, blocks prototype keys, and round-trips own __proto__', async () => {
    // 1) Non-AssetMetadata truthy faucetMetadataOf return must not suppress background fetch.
    _g.__cnSwrTest.faucetMetadataOfOverride = () => Object.prototype.constructor;
    _g.__cnSwrTest.consumableNotes = [makeNote('n-truthy-fallback', 'truthy-bad', '100')];
    const hTruthy = renderHook(() => useClaimableNotes('pk-meta-truthy'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hTruthy.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hTruthy.unmount();
    _g.__cnSwrTest.faucetMetadataOfOverride = null;

    // 2) Native arm must read ownRecordValue(cache, faucetId) so prototype 'constructor' cannot leak.
    const nativeSpy = jest.spyOn(nativeMetadata, 'getNativeDisplayMetadataSync');
    try {
      _g.__cnSwrTest.nativeAssetId = 'constructor';
      _g.__cnSwrTest.metadataCache = {};
      _g.__cnSwrTest.consumableNotes = [makeNote('n-native-ctor', 'constructor', '100')];
      const hNativeCtor = renderHook(() => useClaimableNotes('pk-native-ctor'), { wrapper: createWrapper() });
      await act(async () => {
        await flushMicrotasks(12);
      });
      expect(nativeSpy).toHaveBeenCalledWith(undefined, 'constructor');
      hNativeCtor.unmount();
    } finally {
      nativeSpy.mockRestore();
      _g.__cnSwrTest.nativeAssetId = 'miden-faucet';
    }

    // 3) Null and undefined tokenMetadataOverrides must not throw in local or extension hooks.
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.tokenMetadataOverrides = null as any;
    _g.__cnSwrTest.metadataCache = { 'f-null-ovrd': { symbol: 'TOK', name: 'Token', decimals: 6 } };
    _g.__cnSwrTest.consumableNotes = [makeNote('n-null-ovrd', 'f-null-ovrd', '100')];
    const hNullOvrd = renderHook(() => useClaimableNotes('pk-null-ovrd'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hNullOvrd.result.current.data?.map(n => n.id)).toEqual(['n-null-ovrd']);
    hNullOvrd.unmount();

    _g.__cnSwrTest.isExtension = true;
    _g.__cnSwrTest.tokenMetadataOverrides = undefined as any;
    _g.__cnSwrTest.extensionClaimableNotes = [
      {
        id: 'ext-undef-ovrd',
        faucetId: 'f-null-ovrd',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public',
        standardPayment: true
      },
      {
        id: 'ext-valid-meta-null-ovrd',
        faucetId: 'f-null-ovrd',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public',
        standardPayment: true,
        metadata: { symbol: 'EXTMETA', name: 'Ext Meta', decimals: 6 }
      },
      {
        id: 'ext-malformed-meta-fallback',
        faucetId: 'f-null-ovrd',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public',
        standardPayment: true,
        metadata: { symbol: 123 }
      }
    ];
    const hExtUndef = renderHook(() => useClaimableNotes('pk-ext-undef-ovrd'), { wrapper: createWrapper() });
    expect(hExtUndef.result.current.data?.map(n => [n.id, n.metadata.symbol])).toEqual([
      ['ext-malformed-meta-fallback', 'TOK'],
      ['ext-undef-ovrd', 'TOK'],
      ['ext-valid-meta-null-ovrd', 'EXTMETA']
    ]);
    hExtUndef.unmount();
    _g.__cnSwrTest.isExtension = false;
    _g.__cnSwrTest.extensionClaimableNotes = null;
    _g.__cnSwrTest.tokenMetadataOverrides = {};

    // 4) Non-native 'constructor' faucetId must never resolve Object.prototype.constructor in local or extension hooks.
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.kv = {};
    _g.__cnSwrTest.metadataCache = {};
    _g.__cnSwrTest.consumableNotes = [makeNote('n-ctor', 'constructor', '100')];
    const hCtor = renderHook(() => useClaimableNotes('pk-ctor'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hCtor.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hCtor.unmount();

    _g.__cnSwrTest.isExtension = true;
    _g.__cnSwrTest.extensionClaimableNotes = [
      {
        id: 'ext-ctor',
        faucetId: 'constructor',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public',
        standardPayment: true
      }
    ];
    const hExtCtor = renderHook(() => useClaimableNotes('pk-ext-ctor'), { wrapper: createWrapper() });
    expect(hExtCtor.result.current.data).toEqual([]);
    hExtCtor.unmount();
    _g.__cnSwrTest.isExtension = false;
    _g.__cnSwrTest.extensionClaimableNotes = null;

    // 5) Valid own '__proto__' entry in v2 storage and Zustand cache round-trips cleanly via Map/ownRecordValue.
    mockRunWhenClientIdle.mockReset();
    _g.__cnSwrTest.kv[TOKENS_METADATA_SCHEMA_STORAGE_KEY] = TOKENS_METADATA_SCHEMA_VERSION;
    _g.__cnSwrTest.kv[TOKENS_BASE_METADATA_STORAGE_KEY] = JSON.parse(
      '{"__proto__":{"symbol":"PROTO","name":"Proto Token","decimals":8}}'
    );
    _g.__cnSwrTest.consumableNotes = [makeNote('n-proto', '__proto__', '100')];
    const hProto = renderHook(() => useClaimableNotes('pk-proto'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hProto.result.current.data?.map(n => [n.id, n.metadata.symbol])).toEqual([['n-proto', 'PROTO']]);
    expect(mockRunWhenClientIdle).not.toHaveBeenCalled();
    hProto.unmount();

    _g.__cnSwrTest.isExtension = true;
    _g.__cnSwrTest.metadataCache = JSON.parse('{"__proto__":{"symbol":"EXTPROTO","name":"Ext Proto","decimals":6}}');
    _g.__cnSwrTest.extensionClaimableNotes = [
      {
        id: 'ext-proto',
        faucetId: '__proto__',
        amountBaseUnits: '100',
        senderAddress: 's',
        noteType: 'public',
        standardPayment: true
      }
    ];
    const hExtProto = renderHook(() => useClaimableNotes('pk-ext-proto'), { wrapper: createWrapper() });
    expect(hExtProto.result.current.data?.map(n => [n.id, n.metadata.symbol])).toEqual([['ext-proto', 'EXTPROTO']]);
    hExtProto.unmount();
    _g.__cnSwrTest.isExtension = false;
    _g.__cnSwrTest.extensionClaimableNotes = null;
  });

  it('preserves background metadata prefetch for override-only faucets lacking a base record', async () => {
    _g.__cnSwrTest.kv = {};
    _g.__cnSwrTest.metadataCache = {};
    _g.__cnSwrTest.tokenMetadataOverrides = {
      'overridden-faucet': { symbol: 'OVRD' }
    };
    _g.__cnSwrTest.consumableNotes = [makeNote('n-ovrd', 'overridden-faucet', '100')];
    const hOvrd = renderHook(() => useClaimableNotes('pk-override-only'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hOvrd.result.current.data).toEqual([]);
    expect(mockRunWhenClientIdle).toHaveBeenCalledTimes(1);
    hOvrd.unmount();
  });

  it('shares iOS debugInfo across coalesced subscribers, isolates !enabled hooks, and records classifySwapOrderNotes errors', async () => {
    let calls = 0;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      calls++;
      if (calls === 1) return [makeNote('n-dbg-1')];
      return [makeNote('n-dbg-1'), makeNote('n-dbg-2')];
    });

    let sub1Debug: any;
    let sub2Debug: any;
    function Sub1() {
      sub1Debug = useClaimableNotes('pk-shared-debug').debugInfo;
      return null;
    }
    function Sub2() {
      sub2Debug = useClaimableNotes('pk-shared-debug').debugInfo;
      return null;
    }

    const wrapper = createWrapper();
    const view = render(React.createElement(wrapper, null, React.createElement(Sub1), React.createElement(Sub2)));
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(calls).toBe(1);
    expect(sub1Debug?.lastFetchTime).not.toBe('never');
    expect(sub1Debug?.notesWithMetadataCount).toBe(1);
    expect(sub2Debug?.lastFetchTime).not.toBe('never');
    expect(sub2Debug?.notesWithMetadataCount).toBe(1);

    // Disabled hook on the same cacheKey must not expose the active subscriber telemetry.
    const disabledHook = renderHook(() => useClaimableNotes('pk-shared-debug', false), { wrapper });
    expect(disabledHook.result.current.debugInfo?.lastFetchTime).toBe('never');
    expect(disabledHook.result.current.debugInfo?.notesWithMetadataCount).toBe(0);
    disabledHook.unmount();

    // Leader-dispatched requestNotesRefresh() updates debugInfo on Sub2 as well.
    await act(async () => {
      requestNotesRefresh();
      await flushMicrotasks(12);
    });
    expect(calls).toBe(2);
    expect(sub2Debug?.notesWithMetadataCount).toBe(2);
    view.unmount();

    // classifySwapOrderNotes catch must record debugInfo.error even when the failure trips isSyncFused and pauses SWR onError.
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
      noteSyncWatchdogEviction('claimable-notes');
    }
    expect(isSyncFused('claimable-notes')).toBe(false);
    _g.__cnSwrTest.classifySwapOrderNotes = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog', new Error('lineage hang'));
    });
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => [makeNote('n-swap-err')]);
    const hErr = renderHook(() => useClaimableNotes('pk-swap-dbg-err'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(isSyncFused('claimable-notes')).toBe(true);
    expect(hErr.result.current.debugInfo?.error).toContain('classifySwapOrderNotes failed:');
    hErr.unmount();
  });

  it('suppresses redundant setCachedFallback renders on concurrent co-subscribers after live landing and resets on unmount', async () => {
    const keyLive = 'claimable_notes:v1:https://rpc.mainnet.miden.io|mainnet:pk-shared-live';
    const cachedLive = {
      id: 'cached-live',
      faucetId: 'miden-faucet',
      amount: '100',
      senderAddress: 'sender-1',
      isBeingClaimed: false,
      type: 'public',
      standardPayment: true,
      metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
    };
    _g.__cnSwrTest.kv[keyLive] = [cachedLive];
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => [makeNote('live-win')]);

    let resolveStorage: ((val: any) => void) | null = null;
    _g.__cnSwrTest.fetchFromStorageOverride = (key: string) => {
      if (key === keyLive) {
        return new Promise(resolve => {
          resolveStorage = resolve;
        });
      }
      return Promise.resolve(null);
    };

    let sub2Renders = 0;
    function Sub1() {
      useClaimableNotes('pk-shared-live');
      return null;
    }
    function Sub2() {
      sub2Renders++;
      useClaimableNotes('pk-shared-live');
      return null;
    }

    const wrapper = createWrapper();
    const view = render(React.createElement(wrapper, null, React.createElement(Sub1), React.createElement(Sub2)));
    await act(async () => {
      await flushMicrotasks(12);
    });
    const rendersAtLiveSettle = sub2Renders;

    // Resolving deferred storage AFTER live data landed must not cause an extra setCachedFallback render on Sub2.
    await act(async () => {
      resolveStorage?.([cachedLive]);
      await flushMicrotasks(12);
    });
    expect(sub2Renders).toBe(rendersAtLiveSettle);
    view.unmount();

    // Remounting after unmount without resetting memCache must still surface live-win rather than overwritten cached-live.
    _g.__cnSwrTest.fetchFromStorageOverride = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => new Promise(() => {}));
    const hPostLive = renderHook(() => useClaimableNotes('pk-shared-live'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hPostLive.result.current.data?.map(n => n.id)).toEqual(['live-win']);
    hPostLive.unmount();

    // After full unmount and cache reset, fresh mount with pending live read still surfaces cached fallback.
    __resetClaimableNotesCacheForTests();
    _g.__cnSwrTest.kv[keyLive] = [cachedLive];
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => new Promise(() => {}));
    const hFresh = renderHook(() => useClaimableNotes('pk-shared-live'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hFresh.result.current.data?.map(n => n.id)).toEqual(['cached-live']);
    hFresh.unmount();
  });

  it('does not overwrite claimableNotesMemCache when deferred storage resolves after live write and unmount', async () => {
    const keyMem = 'claimable_notes:v1:https://rpc.mainnet.miden.io|mainnet:pk-mem-after-unmount';
    const cachedStale = {
      id: 'cached-stale',
      faucetId: 'miden-faucet',
      amount: '100',
      senderAddress: 'sender-1',
      isBeingClaimed: false,
      type: 'public',
      standardPayment: true,
      metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
    };
    _g.__cnSwrTest.kv[keyMem] = [cachedStale];
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => [makeNote('live-after-unmount')]);

    let resolveStorage: ((val: any) => void) | null = null;
    _g.__cnSwrTest.fetchFromStorageOverride = (key: string) => {
      if (key === keyMem) {
        return new Promise(resolve => {
          resolveStorage = resolve;
        });
      }
      return Promise.resolve(null);
    };

    const h1 = renderHook(() => useClaimableNotes('pk-mem-after-unmount'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(h1.result.current.data?.map(n => n.id)).toEqual(['live-after-unmount']);

    // Dispose coordinator first so liveLanded is false before deferred storage resolves.
    h1.unmount();
    await act(async () => {
      resolveStorage?.([cachedStale]);
      await flushMicrotasks(12);
    });

    _g.__cnSwrTest.fetchFromStorageOverride = null;
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(() => new Promise(() => {}));
    const h2 = renderHook(() => useClaimableNotes('pk-mem-after-unmount'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(h2.result.current.data?.map(n => n.id)).toEqual(['live-after-unmount']);
    h2.unmount();
  });

  it('preserves stage-specific debugInfo.error labels when not fused and records SWR error for unguarded steps', async () => {
    let sub1Error: string | undefined;
    let sub2Error: string | undefined;
    function Sub1() {
      const res = useClaimableNotes('pk-nonfused-stage');
      sub1Error = res.debugInfo?.error;
      return null;
    }
    function Sub2() {
      const res = useClaimableNotes('pk-nonfused-stage');
      sub2Error = res.debugInfo?.error;
      return null;
    }

    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => {
      throw new Error('rpc hold fail');
    });
    const wrapper = createWrapper();
    const viewErr = render(React.createElement(wrapper, null, React.createElement(Sub1), React.createElement(Sub2)));
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(isSyncFused('claimable-notes')).toBe(false);
    expect(sub1Error).toContain('getConsumableNotes failed:');
    expect(sub2Error).toContain('getConsumableNotes failed:');

    // Subsequent retry that clears getConsumableNotes and fails in an unguarded step must record SWR error.
    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => [makeNote('n-after-stage')]);
    _g.__cnSwrTest.getNoteHoldingTransactions = jest.fn(async () => {
      throw new Error('holding query fail');
    });
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks(12);
    });
    expect(sub1Error).toContain('SWR error:');
    viewErr.unmount();

    _g.__cnSwrTest.proxyGetConsumableNotes = jest.fn(async () => [makeNote('n-nonfused-cls')]);
    _g.__cnSwrTest.getNoteHoldingTransactions = jest.fn(async () => []);
    _g.__cnSwrTest.classifySwapOrderNotes = jest.fn(async () => {
      throw new Error('lineage parse fail');
    });
    const hCls = renderHook(() => useClaimableNotes('pk-nonfused-classify'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(isSyncFused('claimable-notes')).toBe(false);
    expect(hCls.result.current.debugInfo?.error).toContain('classifySwapOrderNotes failed:');
    hCls.unmount();

    // After unmount disposes the coordinator, a fresh mount failing in an unguarded step records SWR error.
    _g.__cnSwrTest.classifySwapOrderNotes = jest.fn(async () => new Map());
    _g.__cnSwrTest.getNoteHoldingTransactions = jest.fn(async () => {
      throw new Error('holding fail after unmount');
    });
    const hAfterUnmount = renderHook(() => useClaimableNotes('pk-nonfused-classify'), { wrapper: createWrapper() });
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(hAfterUnmount.result.current.debugInfo?.error).toContain('SWR error:');
    hAfterUnmount.unmount();
  });
});
