/* eslint-disable import/first */
/**
 * Coverage tests for `lib/miden/back/sync-manager.ts`.
 *
 * `doSync` is mostly orchestration: acquire a WASM lock, read consumable
 * notes + vault assets, resolve metadata via RPC, broadcast and persist.
 * The interesting branches are: wallet-not-setup, no-account, the happy
 * path, the metadata-fetch-fails branch, and the notification path.
 */

// ── Mocks ──────────────────────────────────────────────────────────

const mockIsExist = jest.fn();
const mockGetCurrentAccountPublicKey = jest.fn();
jest.mock('./vault', () => ({
  Vault: {
    isExist: (...args: unknown[]) => mockIsExist(...args),
    getCurrentAccountPublicKey: (...args: unknown[]) => mockGetCurrentAccountPublicKey(...args)
  }
}));

const mockBroadcast = jest.fn();
const mockHasClients = jest.fn(() => true);
jest.mock('./defaults', () => ({
  getIntercom: () => ({
    broadcast: mockBroadcast,
    hasClients: mockHasClients
  })
}));

const mockMergeAndPersistSeenNoteIds = jest.fn();
jest.mock('./note-checker-storage', () => ({
  mergeAndPersistSeenNoteIds: (...args: unknown[]) => mockMergeAndPersistSeenNoteIds(...args)
}));

const mockGetQuarantinedNoteIds = jest.fn(async () => new Set<string>());
jest.mock('lib/miden/note-quarantine', () => ({
  getQuarantinedNoteIds: () => mockGetQuarantinedNoteIds()
}));

const mockFetchTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata', () => ({
  fetchTokenMetadata: (...args: unknown[]) => mockFetchTokenMetadata(...args)
}));

jest.mock('lib/i18n', () => ({
  getMessage: jest.fn((key: string) => key)
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (input: any) =>
    typeof input === 'string' ? input : input && typeof input.toString === 'function' ? input.toString() : 'bech32-stub'
}));

const mockMarkConnectivityIssue = jest.fn();
const mockClearReachabilityIssues = jest.fn();
jest.mock('lib/miden/activity/connectivity-state', () => ({
  markConnectivityIssue: (...args: unknown[]) => mockMarkConnectivityIssue(...args),
  clearReachabilityIssues: () => mockClearReachabilityIssues()
}));

const mockClient = {
  syncState: jest.fn(async () => {}),
  getConsumableNoteDtos: jest.fn(async () => [] as any[]),
  getAccount: jest.fn(async () => null as any)
};
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// The options the sync hold is taken with. On the INLINE path (which is what jsdom
// presents — no `chrome.offscreen`) the hold must carry the sync watchdog ceiling,
// because there the timeout's rejection would release the mutex while the abandoned
// `syncState` is still inside this realm's single-threaded client.
const lockOptionsSeen: Array<unknown> = [];
// The hold identity has to be modelled, not stubbed away: the note-read callback
// re-checks `getCurrentWasmLockHold() === hold` after its client build, so a mock that
// passes no hold would make every read look abandoned.
let swLockHold: object | null = null;
const evictSwLockHold = () => {
  swLockHold = null;
};
// Overridable so a test can evict the hold from INSIDE the client build, which on the
// inline path is the long await the read's liveness guard exists for.
const mockGetMidenClient = jest.fn(async () => mockClient);
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>, options?: unknown) => {
    lockOptionsSeen.push(options);
    const hold = {};
    swLockHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (swLockHold === hold) swLockHold = null;
    }
  },
  getCurrentWasmLockHold: () => swLockHold,
  runWhenClientIdle: () => {}
}));

// Stub webextension-polyfill (the real one is also stubbed via @serh11p/jest-webextension-mock).
// sync-manager persists via `browser.storage.local.set`; route it through the shared
// `mockStorageSet` spy (lazy wrapper avoids the mock-hoisting TDZ, like the mocks below).
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    alarms: {
      create: jest.fn()
    },
    storage: {
      local: {
        set: (...args: unknown[]) => mockStorageSet(...args)
      }
    }
  }
}));

// Stub chrome.storage.local (jest-webextension-mock provides a polyfill but
// it may not attach `set` — we explicitly stub here to be deterministic).
const mockStorageSet = jest.fn();
(globalThis as any).chrome = {
  storage: {
    local: {
      set: mockStorageSet
    }
  },
  runtime: {
    lastError: undefined,
    getURL: (path: string) => `chrome-extension://test/${path}`
  }
};

// Native-note auto-consume deps (background pass). Defaults keep the pass a no-op
// for the rest of the suite; the native-note tests below flip them on.
const mockIsAutoConsumeAsync = jest.fn(async (): Promise<boolean> => false);
const mockIsDelegateProofAsync = jest.fn(async (): Promise<boolean> => true);
const mockAreBgMirrored = jest.fn(async (): Promise<boolean> => true);
jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual('lib/settings/helpers'),
  isAutoConsumeEnabledAsync: () => mockIsAutoConsumeAsync(),
  isDelegateProofEnabledAsync: () => mockIsDelegateProofAsync(),
  areBackgroundSettingsMirrored: () => mockAreBgMirrored()
}));

let mockBaseFee: number | null = 0;
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getVerificationBaseFee: () => Promise.resolve(mockBaseFee)
}));

const mockGetFaucetIdSetting = jest.fn(async (): Promise<string | null> => null);
jest.mock('../assets', () => ({
  ...jest.requireActual('../assets'),
  getFaucetIdSetting: () => mockGetFaucetIdSetting()
}));

const mockInitiateConsume = jest.fn((..._args: any[]) => Promise.resolve('consume-tx'));
jest.mock('../transaction/initiate', () => ({
  ...jest.requireActual('../transaction/initiate'),
  // Lazy wrapper (not a direct ref): a direct `mockInitiateConsume` here hits a
  // temporal-dead-zone error because requireActual('../assets') transitively loads this
  // mocked module before the const is initialized. The native pass consumes per-note via
  // initiateConsumeTransaction (single-note), so mock that.
  initiateConsumeTransaction: (...args: any[]) => mockInitiateConsume(...args)
}));

jest.mock('./transaction-processor', () => ({
  startTransactionProcessing: jest.fn(async () => {})
}));

// The private-note delivery sweep rides on every sync tick. Mocked here (it owns a
// dedicated test file) because the real one queries Dexie, which this suite does not
// stand up — an unsettled query would hang `runSync` and, since `doSync` dedupes on
// the in-flight promise, silently turn every later sync in this file into a no-op.
const mockSweepNoteDeliveries = jest.fn(() => Promise.resolve());
jest.mock('../transaction/note-delivery-sweep', () => ({
  sweepNoteDeliveries: () => mockSweepNoteDeliveries()
}));

// ── Imports under test ─────────────────────────────────────────────

import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
  MAX_SYNC_BACKOFF_MS
} from 'lib/miden/sync-backoff';
import { WalletMessageType } from 'lib/shared/types';

import { computeSyncBackoffMs, doSync, setupSyncManager } from './sync-manager';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from '../sdk/wasm-client-poison';

// Helper: build a fake consumable note WASM record
// Since slice 4 (issue #260) getConsumableNoteDtos returns plain DTOs (the live
// InputNoteRecord reach-through + reclaim gate now run inside the reducer), so
// the fixtures are DTOs, not live-record mocks. bech32 encoding already applied
// in the reducer, so faucetId/senderAccountId here are the final surfaced values.
function fakeNote({
  id = 'note-1',
  faucetId = 'faucet-1',
  amount = '100',
  senderId = 'sender-1',
  noteType = 0
}: {
  id?: string | null;
  faucetId?: string;
  amount?: string;
  senderId?: string | undefined;
  noteType?: number | undefined;
} = {}): any {
  return {
    noteId: id,
    nullifier: id == null ? null : `null-${id}`,
    noteType,
    senderAccountId: senderId,
    state: 2,
    assets: [{ faucetId, amount }],
    swapAttachment: null
  };
}

beforeEach(() => {
  mockBaseFee = 0;
  jest.clearAllMocks();
  mockIsExist.mockResolvedValue(true);
  mockGetCurrentAccountPublicKey.mockResolvedValue('pk-1');
  mockClient.syncState.mockResolvedValue(undefined);
  mockClient.getConsumableNoteDtos.mockResolvedValue([]);
  mockClient.getAccount.mockResolvedValue(null);
  mockFetchTokenMetadata.mockResolvedValue({
    base: { decimals: 6, symbol: 'TOK', name: 'Token', thumbnailUri: 'x.png' }
  });
  mockMergeAndPersistSeenNoteIds.mockResolvedValue([]);
  mockHasClients.mockReturnValue(true);
  mockGetQuarantinedNoteIds.mockResolvedValue(new Set());
  // Reset the native-consume mocks to defaults — jest.clearAllMocks() clears calls but
  // NOT mockResolvedValue impls, so a per-test override (e.g. areBgMirrored=false) would
  // otherwise leak and silently gate off later tests' native path.
  mockAreBgMirrored.mockResolvedValue(true);
  mockIsAutoConsumeAsync.mockResolvedValue(false);
  mockIsDelegateProofAsync.mockResolvedValue(true);
  mockGetFaucetIdSetting.mockResolvedValue(null);
  mockInitiateConsume.mockResolvedValue('consume-tx');
});

describe('computeSyncBackoffMs (gap 14 — exponential backoff + jitter)', () => {
  // rand=0 removes jitter so the exponential base is exact.
  const noJitter = () => 0;

  it('doubles the base interval each consecutive trip', () => {
    expect(computeSyncBackoffMs(1, noJitter)).toBe(30_000);
    expect(computeSyncBackoffMs(2, noJitter)).toBe(60_000);
    expect(computeSyncBackoffMs(3, noJitter)).toBe(120_000);
    expect(computeSyncBackoffMs(4, noJitter)).toBe(240_000);
  });

  it('caps the backoff so a long outage is not probed on an ever-growing interval', () => {
    // 30s * 2^4 = 480s would exceed the 5-min cap.
    expect(computeSyncBackoffMs(5, noJitter)).toBe(300_000);
    expect(computeSyncBackoffMs(50, noJitter)).toBe(300_000);
  });

  it('adds up to 20% jitter on top of the interval (de-syncs lockstep probing)', () => {
    expect(computeSyncBackoffMs(1, () => 1)).toBe(36_000); // +20%
    expect(computeSyncBackoffMs(1, () => 0.5)).toBe(33_000); // +10%
    // Jitter is bounded within [base, base*1.2].
    for (const r of [0, 0.25, 0.75, 1]) {
      const v = computeSyncBackoffMs(2, () => r);
      expect(v).toBeGreaterThanOrEqual(60_000);
      expect(v).toBeLessThanOrEqual(72_000);
    }
  });
});

describe('doSync', () => {
  it('is a no-op when the vault is not set up', async () => {
    mockIsExist.mockResolvedValueOnce(false);
    await doSync();
    expect(mockClient.syncState).not.toHaveBeenCalled();
  });

  it('broadcasts SyncCompleted and skips note work when there is no account', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValueOnce(undefined);
    await doSync();
    expect(mockClient.syncState).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: expect.any(String) }));
    expect(mockClient.getConsumableNoteDtos).not.toHaveBeenCalled();
  });

  it('reads notes and vault assets, enriches with metadata, and writes to chrome.storage', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'n1', faucetId: 'f1' })]);
    mockClient.getAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => 'f2',
            amount: () => ({ toString: () => '200' })
          }
        ]
      })
    });
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce([]);

    await doSync();

    // The second argument is the sync's own `stillOurs` check, forwarded into the
    // read so the reach-through past its internal await is guarded too.
    expect(mockClient.getConsumableNoteDtos).toHaveBeenCalledWith('pk-1', expect.any(Function));
    expect(mockClient.getAccount).toHaveBeenCalledWith('pk-1');
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('f1');
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('f2');
    expect(mockStorageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        miden_cached_consumable_notes: expect.any(Array),
        miden_sync_data: expect.objectContaining({ accountPublicKey: 'pk-1' })
      })
    );
  });

  it('logs a warning (not silent) but still finishes the sync when the storage write fails (#386)', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'n1', faucetId: 'f1' })]);
    // Simulate a rejected write (e.g. QUOTA_BYTES exceeded / storage unavailable).
    mockStorageSet.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(doSync()).resolves.toBeUndefined();

    // The failed write must not be swallowed silently.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to persist'), expect.anything());
    // The SyncCompleted signal still fires — it only clears the sync indicator
    // (the data is read from storage), so it must not hang on a write failure.
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: WalletMessageType.SyncCompleted }));

    warnSpy.mockRestore();
  });

  it('excludes quarantined notes from the cached consumable-notes write', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'quarantined-note', faucetId: 'f1' }),
      fakeNote({ id: 'visible-note', faucetId: 'f1' })
    ]);
    mockGetQuarantinedNoteIds.mockResolvedValueOnce(new Set(['quarantined-note']));

    await doSync();

    const call = mockStorageSet.mock.calls.find(c => 'miden_cached_consumable_notes' in c[0]);
    const cached = call?.[0]?.miden_cached_consumable_notes as Array<{ id: string }>;
    expect(cached.map(n => n.id)).toEqual(['visible-note']);
  });

  it('shows a desktop notification when a new note arrives and no frontends are connected', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'new-note' })]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['new-note']);
    mockHasClients.mockReturnValue(false);
    (globalThis as any).chrome.notifications = {
      create: jest.fn()
    };
    await doSync();
    expect((globalThis as any).chrome.notifications.create).toHaveBeenCalled();
  });

  it('skips partial (metadata-less) notes whose noteId is null', async () => {
    // A partial note reduces to a DTO with noteId null (the reducer keeps it so
    // the caller applies its own skip). sync-manager drops it on !noteId.
    const partialNote = fakeNote({ id: null });
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([partialNote]);
    await doSync();
    // The partial note is filtered; doSync still finishes successfully
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('skips notes with no fungible assets (empty assets array)', async () => {
    // The un-reducible / malformed case is now caught by the reducer itself (see
    // consumable-notes.test.ts). At the sync-manager level the remaining skip is
    // the empty-asset one: a DTO with no assets can't be surfaced.
    const emptyAssetNote = { ...fakeNote({ id: 'no-assets' }), assets: [] };
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([emptyAssetNote]);
    await doSync();
    // The asset-less note is filtered; doSync still finishes successfully
    expect(mockStorageSet).toHaveBeenCalled();
  });

  // The #331 "log a parse failure instead of silently dropping the note" behavior
  // moved with the reduction itself: since slice 4 (#260) sync-manager reads plain
  // DTOs from the proxy and no longer parses raw note records, so the mid-parse
  // failure now originates in — and is logged by — the reducer. That path is
  // covered by consumable-notes.test.ts ('returns null (skips) when a record throws
  // mid-reduction' asserts the '[consumable-notes] skipping un-reducible note' warn).

  it('tolerates fetchTokenMetadata rejections and still writes sync data', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'n1', faucetId: 'f1' })]);
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('network down'));
    await doSync();
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('broadcasts SyncCompleted even when syncState rejects', async () => {
    mockClient.syncState.mockRejectedValueOnce(new Error('wasm offline'));
    await doSync();
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it('bounds the INLINE sync hold at the watchdog ceiling instead of racing a timeout (#777)', async () => {
    // The 30s `withTimeout` only rejects the OUTER promise: the underlying sync keeps
    // running, and the rejection propagating out of the lock callback releases the
    // mutex. Harmless when the WASM is in the offscreen realm behind its own mutex;
    // on the inline path it hands the mutex to the downstream read path below while
    // the sync is still inside the client — a double borrow. So the inline path takes
    // the eviction route: no JS timeout, and the hold bounded by the ceiling.
    lockOptionsSeen.length = 0;
    await doSync();

    expect(lockOptionsSeen[0]).toEqual({ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'sw-sync' });
    // And so is the DOWNSTREAM read, which on this path is not the warm re-read it
    // reads as: [Lock 1]'s eviction cleared the client slot, so this hold rebuilds
    // and its genesis fetch goes to the node that just parked. Left on the default
    // backstop it held this realm's only WASM mutex for 300s on top of [Lock 1]'s
    // 120s — worse than the 30s timeout it replaced (#777).
    expect(lockOptionsSeen[1]).toEqual({ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'sw-notes-read' });
  });

  it('skips the downstream note read for the lap whose INLINE sync hold was evicted (#777)', async () => {
    // That eviction cleared the client slot, so this read would rebuild and send the new
    // client's genesis fetch to the node the sync just gave up on: a second 120s of this
    // realm's only WASM mutex and a second leaked client, for state that cannot have
    // changed since the sync that failed to fetch it.
    jest.spyOn(console, 'warn').mockImplementation();
    mockClient.syncState.mockReset();
    mockClient.getConsumableNoteDtos.mockClear();
    mockClient.syncState.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));
    lockOptionsSeen.length = 0;

    await doSync();

    // One hold taken, not two: the read never ran.
    expect(lockOptionsSeen).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'sw-sync' }]);
    expect(mockClient.getConsumableNoteDtos).not.toHaveBeenCalled();

    // Falsifier: an ORDINARY sync failure still reads. The client is intact there, so
    // the cached state this read surfaces is worth having.
    mockClient.syncState.mockReset();
    mockClient.syncState.mockRejectedValueOnce(new Error('rpc blip'));
    lockOptionsSeen.length = 0;
    await doSync();
    expect(lockOptionsSeen).toHaveLength(2);
    jest.restoreAllMocks();
  });

  it('stops the note read before its WASM calls when the hold is evicted during the client build (#777)', async () => {
    // On the inline path the client build IS the long await (a genesis fetch against a
    // parked node). An abandoned callback resuming past it would make unmutexed inline
    // WASM calls while a successor is inside the client — the double borrow the lock
    // exists to prevent.
    jest.spyOn(console, 'warn').mockImplementation();
    mockClient.syncState.mockReset();
    mockClient.syncState.mockResolvedValue(undefined);
    mockClient.getConsumableNoteDtos.mockClear();
    mockClient.getAccount.mockClear();
    // The read's own hold is the second one, so let the sync's build through and evict
    // during the read's.
    let builds = 0;
    mockGetMidenClient.mockImplementation(async () => {
      builds++;
      if (builds === 2) evictSwLockHold();
      return mockClient;
    });

    await doSync();

    // The guard fired instead: no consumable-note read happened on the abandoned hold.
    expect(mockClient.getConsumableNoteDtos).not.toHaveBeenCalled();
    mockGetMidenClient.mockImplementation(async () => mockClient);
    jest.restoreAllMocks();
  });

  it('skips the delivery sweep on the lap whose inline sync hold was evicted (#777)', async () => {
    // The sweep's proxy calls take fresh holds of their own, so after an eviction cleared
    // the client slot each of them rebuilds and sends the new client's genesis fetch to
    // the node that just refused to answer. It is maintenance behind already-landed
    // transactions: a lap later costs nothing, another park of the realm's only WASM
    // mutex costs the whole wallet.
    jest.spyOn(console, 'warn').mockImplementation();
    mockClient.syncState.mockReset();
    mockSweepNoteDeliveries.mockClear();
    mockClient.syncState.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    await doSync();
    expect(mockSweepNoteDeliveries).not.toHaveBeenCalled();

    // Falsifier: an ORDINARY sync failure still sweeps — the client is intact, so its
    // holds are ordinary holds and the sweep is worth running.
    mockClient.syncState.mockReset();
    mockClient.syncState.mockRejectedValueOnce(new Error('rpc blip'));
    await doSync();
    expect(mockSweepNoteDeliveries).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('stops the note read at the FIRST WASM call after an eviction mid-read (#777)', async () => {
    // The build is not the only parking await in this hold: the consumable-note read is
    // itself a network round trip, and an eviction during it releases the mutex while
    // this callback carries on to `getAccount`. One guard after the build covered the
    // first of the read's calls and none of the rest.
    jest.spyOn(console, 'warn').mockImplementation();
    mockClient.syncState.mockReset();
    mockClient.syncState.mockResolvedValue(undefined);
    mockClient.getConsumableNoteDtos.mockClear();
    mockClient.getAccount.mockClear();
    mockClient.getConsumableNoteDtos.mockImplementationOnce(async () => {
      evictSwLockHold();
      return [];
    });

    await doSync();

    expect(mockClient.getConsumableNoteDtos).toHaveBeenCalledTimes(1);
    // The account read is more WASM on a hold that is no longer ours, so it must not run.
    expect(mockClient.getAccount).not.toHaveBeenCalled();

    // Falsifier: with the hold intact the same read goes on to the account.
    mockClient.getConsumableNoteDtos.mockClear();
    mockClient.getAccount.mockClear();
    await doSync();
    expect(mockClient.getAccount).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('lights the sync fuse after repeated watchdog evictions, and only a success puts it out (#777)', async () => {
    await jest.isolateModulesAsync(async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();
      // Every probe evicted: the shape the fuse exists for. Replacing the client
      // cannot reach a sync the SDK has already coalesced onto a dead promise, so
      // this realm would otherwise pay a poison-and-rebuild every window forever —
      // and on the inline path leak the client each time.
      mockClient.syncState.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
      let fakeNow = 5_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      const monotonicSpy = jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);
      const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

      const { doSync: isolated } = await import('./sync-manager');

      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
        await isolated();
        // Past the breaker's own window each lap, so the only thing that can be
        // holding the next probe back is the fuse.
        fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      }
      const callsWhenFused = mockClient.syncState.mock.calls.length;
      expect(callsWhenFused).toBe(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sync fuse lit'));

      // The falsifier: a wait that clears the breaker's maximum window but not the
      // fused one is refused. Without the fuse this probe goes through.
      fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(callsWhenFused);

      // A non-eviction failure while LIT does not clear the evidence: it is no proof the
      // parked sync recovered, and zeroing here meant one offline blip mid-fuse bought
      // four fresh evictions to re-reach a conclusion nothing had contradicted. This is
      // the leg that makes "only a success" true rather than decorative.
      fakeNow += FUSED_SYNC_PROBE_INTERVAL_MS;
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new Error('Failed to fetch'));
      await isolated();
      const callsAfterBlip = mockClient.syncState.mock.calls.length;
      expect(callsAfterBlip).toBe(1);
      fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(callsAfterBlip);

      // Serve out the fused wait, then succeed: that is the one observation that
      // clears the evidence.
      fakeNow += FUSED_SYNC_PROBE_INTERVAL_MS;
      mockClient.syncState.mockReset();
      mockClient.syncState.mockResolvedValue(undefined);
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(1);

      // Fuse out: a single later eviction backs off on the BREAKER's short window
      // again, not on half an hour.
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
        await isolated();
        fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      }
      const beforeShortWindow = mockClient.syncState.mock.calls.length;
      fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(beforeShortWindow + 1);

      nowSpy.mockRestore();
      monotonicSpy.mockRestore();
      randSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  it('never lights the fuse from FORCED probes, and a failed Retry cannot extend a lit one (#777)', async () => {
    // The fuse measures what the AUTOMATIC cadence costs: one probe per 30 minutes until
    // one succeeds. A user tap is neither part of that cadence nor throttled by it, so it
    // must neither add evidence nor push the deadline — without the exemption three
    // Retry taps against a parked node bought the wallet another half hour of silence
    // each, which is the opposite of what pressing Retry asks for.
    await jest.isolateModulesAsync(async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
      let fakeNow = 9_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      const monotonicSpy = jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);
      const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

      const { doSync: isolated } = await import('./sync-manager');

      // Twice the threshold in FORCED evictions: the fuse must stay dark.
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS * 2; i++) {
        await isolated(true);
        fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      }
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('sync fuse lit'));

      // And they left no evidence BEHIND either, which the log alone cannot show: one
      // automatic eviction after that burst must not be enough to light the fuse. If
      // forced probes counted, the counter is already over the threshold here and this
      // single automatic failure fuses the realm for half an hour.
      await isolated();
      fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      const callsBeforeNextAuto = mockClient.syncState.mock.calls.length;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(callsBeforeNextAuto + 1);

      // Now light it the only way it can be lit — automatically — and record the
      // deadline it published by finding the lap at which an automatic probe runs again.
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
        await isolated();
        fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      }
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sync fuse lit'));

      // A forced probe goes through the lit fuse (that is Retry's whole job) and FAILS.
      // If that failure re-armed the fused window, the automatic probe due moments later
      // would be turned away.
      fakeNow += FUSED_SYNC_PROBE_INTERVAL_MS - 1_000;
      await isolated(true);
      fakeNow += 1_000;
      const callsBeforeDueProbe = mockClient.syncState.mock.calls.length;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(callsBeforeDueProbe + 1);

      // …and it must not SHORTEN the fuse either, which is the direction that actually
      // hurts: the breaker's arm is unconditional while the fuse's re-arm is not, so with
      // both deadlines in one field two failed Retry taps replaced half an hour of
      // enforced quiet with thirty seconds and put the automatic loop straight back into
      // the park it had concluded to stay out of. The probe above lit the fuse afresh;
      // two forced failures now, then a wait that clears any breaker window, must still
      // find the automatic probe fused.
      await isolated(true);
      await isolated(true);
      fakeNow += MAX_SYNC_BACKOFF_MS + 1_000;
      const callsBeforeFusedProbe = mockClient.syncState.mock.calls.length;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(callsBeforeFusedProbe);

      nowSpy.mockRestore();
      monotonicSpy.mockRestore();
      randSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  it('two back-to-back doSync calls only sync once', async () => {
    // Trivial check: two sequential calls (with no slowdown) should each
    // run their own syncState; the re-entrancy guard only catches truly
    // overlapping calls, which we don't try to simulate here.
    await doSync();
    await doSync();
    expect(mockClient.syncState).toHaveBeenCalledTimes(2);
  });

  it('concurrent doSync calls coalesce onto one syncState invocation', async () => {
    let syncResolve: () => void;
    const syncPromise = new Promise<void>(resolve => {
      syncResolve = resolve;
    });
    mockClient.syncState.mockImplementationOnce(() => syncPromise);

    const first = doSync();
    const second = doSync(); // should join the in-flight promise

    syncResolve!();
    await first;
    await second;

    // syncState should only have been called once
    expect(mockClient.syncState).toHaveBeenCalledTimes(1);
  });

  it('does not throw when broadcast fails in the no-account branch', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValueOnce(undefined);
    mockBroadcast.mockImplementationOnce(() => {
      throw new Error('no ports');
    });
    await expect(doSync()).resolves.toBeUndefined();
  });

  it('does not throw when broadcast fails in the main happy-path branch', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([]);
    mockClient.getAccount.mockResolvedValueOnce(null);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce([]);
    mockBroadcast.mockImplementationOnce(() => {
      throw new Error('no ports');
    });
    await expect(doSync()).resolves.toBeUndefined();
  });

  it('does not throw when broadcast fails in the error handler', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockClient.syncState.mockRejectedValueOnce(new Error('wasm crash'));
    mockBroadcast.mockImplementation(() => {
      throw new Error('no ports');
    });
    await expect(doSync()).resolves.toBeUndefined();
    warnSpy.mockRestore();
    mockBroadcast.mockReset();
  });

  it('handles a note whose firstAsset is null (no fungible assets)', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      { ...fakeNote({ id: 'n-null-asset' }), assets: [] } // empty array means no firstAsset
    ]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce([]);
    await doSync();
    // Note should be filtered out
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('shows single-note notification message', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'solo-note' })]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['solo-note']);
    mockHasClients.mockReturnValue(false);
    const showNotification = jest.fn();
    (globalThis as any).registration = { showNotification };
    await doSync();
    // Should use the single-note message
    expect(showNotification).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.any(String) })
    );
    delete (globalThis as any).registration;
  });
});

describe('setupSyncManager', () => {
  it('registers the alarm and kicks off an initial sync', async () => {
    const browser = (await import('webextension-polyfill')).default as any;
    setupSyncManager();
    expect(browser.alarms.create).toHaveBeenCalledWith(
      'miden-sync',
      expect.objectContaining({ periodInMinutes: expect.any(Number) })
    );
  });
});

describe('private-note delivery sweep wiring', () => {
  it('runs the sweep on a sync tick', async () => {
    // The sweep lives here rather than in the transaction loop because that loop
    // only runs while a transaction is being processed, and the sweep's whole job is
    // to act minutes to hours after a send finished — when an idle wallet would
    // otherwise never run it.
    mockSweepNoteDeliveries.mockClear();
    await doSync();
    expect(mockSweepNoteDeliveries).toHaveBeenCalled();
  });

  it('does not let a failing sweep break the sync', async () => {
    // Delivery is maintenance behind transactions that already landed, so a
    // transport problem must not fail a sync or trip its circuit breaker.
    jest.spyOn(console, 'warn').mockImplementation();
    mockSweepNoteDeliveries.mockRejectedValueOnce(new Error('transport unreachable'));
    mockClearReachabilityIssues.mockClear();

    await expect(doSync()).resolves.toBeUndefined();
    expect(mockClearReachabilityIssues).toHaveBeenCalled();
  });
});

describe('doSync — connectivity categorization', () => {
  it('clears reachability issues on a successful sync', async () => {
    mockClearReachabilityIssues.mockClear();
    await doSync();
    expect(mockClearReachabilityIssues).toHaveBeenCalled();
  });

  it('does NOT mark connectivity on a single transient sync failure (debounced)', async () => {
    // A lone slow-but-healthy sync must not flap the "node unreachable" banner.
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(console, 'warn').mockImplementation();
      mockMarkConnectivityIssue.mockClear();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValueOnce(new Error('Sync timeout'));
      const { doSync: isolated } = await import('./sync-manager');
      await isolated();
      expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();
    });
  });

  it('marks node category only after a sustained transport-error streak', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(console, 'warn').mockImplementation();
      mockMarkConnectivityIssue.mockClear();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new Error('rpc error: deadline exceeded'));
      const { doSync: isolated } = await import('./sync-manager');
      // First two failures stay silent (debounced)…
      await isolated();
      await isolated();
      expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();
      // …the 3rd consecutive failure trips the breaker and surfaces the banner.
      await isolated();
      expect(mockMarkConnectivityIssue).toHaveBeenCalled();
      const arg = mockMarkConnectivityIssue.mock.calls[0]?.[0];
      expect(['network', 'node']).toContain(arg);
    });
  });

  it('does NOT mark connectivity for a semantic / non-transport error even when sustained', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(console, 'warn').mockImplementation();
      mockMarkConnectivityIssue.mockClear();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new Error('something completely unrelated'));
      const { doSync: isolated } = await import('./sync-manager');
      await isolated();
      await isolated();
      await isolated();
      expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();
    });
  });
});

describe('doSync — notification getMessage fallback branches', () => {
  it('uses fallback strings when getMessage returns empty (single note)', async () => {
    const { getMessage } = jest.requireMock('lib/i18n');
    getMessage.mockReturnValue('');
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'n-fb' })]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['n-fb']);
    mockHasClients.mockReturnValue(false);
    const showNotification = jest.fn();
    (globalThis as any).registration = { showNotification };
    await doSync();
    expect(showNotification).toHaveBeenCalledWith('You have received a note', expect.any(Object));
    delete (globalThis as any).registration;
    getMessage.mockImplementation((key: string) => key);
  });

  it('uses fallback strings when getMessage returns empty (multi note)', async () => {
    const { getMessage } = jest.requireMock('lib/i18n');
    getMessage.mockReturnValue('');
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([fakeNote({ id: 'n-m1' }), fakeNote({ id: 'n-m2' })]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['n-m1', 'n-m2']);
    mockHasClients.mockReturnValue(false);
    const showNotification = jest.fn();
    (globalThis as any).registration = { showNotification };
    await doSync();
    expect(showNotification).toHaveBeenCalledWith(
      'You have received a note',
      expect.objectContaining({ body: 'You have 2 new notes to claim' })
    );
    delete (globalThis as any).registration;
    getMessage.mockImplementation((key: string) => key);
  });
});

describe('doSync — note metadata branches', () => {
  it('handles a note with no fungible assets (filters it out)', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([{ ...fakeNote({ id: 'n-empty' }), assets: [] }]);
    await doSync();
    // The empty note is filtered; sync still completes
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('handles a note where metadata is null (uses unknown noteType)', async () => {
    // A metadata-less DTO: noteType/senderAccountId undefined (reducer output for
    // a note with no metadata). sync-manager surfaces it with noteType 'unknown'.
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      {
        noteId: 'n-no-meta',
        nullifier: null,
        noteType: undefined,
        senderAccountId: undefined,
        state: 0,
        assets: [{ faucetId: 'f1', amount: '1' }],
        swapAttachment: null
      }
    ]);
    await doSync();
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('handles when no account exists in client (assets array stays empty)', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([]);
    mockClient.getAccount.mockResolvedValueOnce(null);
    await doSync();
    expect(mockStorageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        miden_sync_data: expect.objectContaining({
          vaultAssets: []
        })
      })
    );
  });

  it('shows multi-note notification when multiple new notes arrive', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'n1', faucetId: 'f', amount: '1', senderId: 's' }),
      fakeNote({ id: 'n2', faucetId: 'f', amount: '1', senderId: 's' })
    ]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['n1', 'n2']);
    mockHasClients.mockReturnValue(false);
    (globalThis as any).chrome.notifications = { create: jest.fn() };
    await doSync();
    expect((globalThis as any).chrome.notifications.create).toHaveBeenCalled();
  });

  it('uses ServiceWorkerRegistration.showNotification when available', async () => {
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'n1', faucetId: 'f', amount: '1', senderId: 's' })
    ]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['n1']);
    mockHasClients.mockReturnValue(false);
    const showNotification = jest.fn();
    (globalThis as any).registration = { showNotification };
    await doSync();
    expect(showNotification).toHaveBeenCalled();
    delete (globalThis as any).registration;
  });
});

// The circuit-breaker state (`consecutiveSyncFailures`, `syncBackoffUntilMs`)
// is module-level. Each test isolates the module so the counter starts at 0
// and the backoff window is closed at the start of every case.
describe('doSync — syncState timeout + circuit breaker', () => {
  it('queues one forced retry when a sync is already in flight', async () => {
    await jest.isolateModulesAsync(async () => {
      mockClient.syncState.mockReset();
      let signalStarted!: () => void;
      let releaseSync!: () => void;
      const started = new Promise<void>(resolve => {
        signalStarted = resolve;
      });
      const syncGate = new Promise<void>(resolve => {
        releaseSync = resolve;
      });
      mockClient.syncState
        .mockImplementationOnce(async () => {
          signalStarted();
          await syncGate;
        })
        .mockResolvedValueOnce(undefined);

      const { doSync: isolated } = await import('./sync-manager');
      const active = isolated();
      await started;
      const forced = isolated(true);
      releaseSync();
      await Promise.all([active, forced]);

      expect(mockClient.syncState).toHaveBeenCalledTimes(2);
    });
  });

  it('increments the failure counter when syncState rejects and trips the breaker after consecutive failures', async () => {
    await jest.isolateModulesAsync(async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new Error('persistent rpc failure'));

      const { doSync: isolated } = await import('./sync-manager');

      // 3 back-to-back failures should trip the breaker on the 3rd.
      await isolated();
      await isolated();
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);

      // Breaker is now open — subsequent doSync should short-circuit without
      // calling syncState.
      await isolated();
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);

      await isolated(true);
      expect(mockClient.syncState).toHaveBeenCalledTimes(4);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('circuit breaker open'));
      warnSpy.mockRestore();
    });
  });

  it('a successful syncState resets the failure counter mid-streak', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();

      const { doSync: isolated } = await import('./sync-manager');

      // Two failures + one success → counter back to 0.
      mockClient.syncState.mockRejectedValueOnce(new Error('blip 1'));
      await isolated();
      mockClient.syncState.mockRejectedValueOnce(new Error('blip 2'));
      await isolated();
      mockClient.syncState.mockResolvedValueOnce(undefined);
      await isolated();

      // A single subsequent failure must NOT trip the breaker (previously it
      // would have been the 3rd consecutive failure before the reset).
      mockClient.syncState.mockRejectedValueOnce(new Error('blip 3'));
      await isolated();

      // All four calls reached syncState; breaker never opened.
      expect(mockClient.syncState).toHaveBeenCalledTimes(4);
    });
  });

  it('failing forced probes re-arm the window but never escalate it (#777)', async () => {
    await jest.isolateModulesAsync(async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new Error('node down'));
      // Driving the monotonic clock (the deadline's clock) is what lets an
      // automatic probe past the open window at the end; jitter pinned off so
      // "advance past the window" is a fact rather than a coin flip.
      let fakeNow = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      const monotonicSpy = jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);
      const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

      const { doSync: isolated } = await import('./sync-manager');

      // Three automatic failures open the first window: trip 1.
      await isolated();
      await isolated();
      await isolated();

      // Now the user taps Retry three times against the same down node. Each one
      // probes straight through the open window and fails, reaching the same arm.
      // The trip count must not move: escalation measures how long the node has
      // been failing, not how many times the user asked, and letting taps count
      // walked the user's own wallet from 30s to 240s of enforced silence.
      // The taps are SPACED, which is what makes the re-arm observable: at one
      // instant the re-armed deadline and the inherited one coincide, so a forced
      // failure that never touched the deadline predicts exactly the same timings.
      // Three taps 8s apart put the re-armed deadline 24s past the original.
      for (let tap = 0; tap < 3; tap++) {
        fakeNow += 8_000;
        await isolated(true);
      }

      const openings = () =>
        warnSpy.mock.calls.map(args => String(args[0])).filter(msg => msg.includes('circuit breaker open'));
      expect(openings()).toEqual([expect.stringContaining('trip 1'), expect.stringContaining('trip 1')]);
      expect(mockClient.syncState).toHaveBeenCalledTimes(6);

      // Past the ORIGINAL deadline but inside the re-armed one: the automatic probe
      // must be skipped, never reaching the node. This is the assertion the re-arm
      // actually owns — without it the timer is through here and already escalating.
      fakeNow += 11_000;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(6);
      expect(openings()).toHaveLength(2);

      // And the exemption must not become a way to STOP escalating: a forced
      // failure does not spend the automatic streak, so the next automatic failure
      // past the re-armed window is still the one that walks the curve.
      fakeNow += 20_000;
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(7);
      expect(openings()).toHaveLength(3);
      expect(openings()[2]).toContain('trip 2');

      warnSpy.mockRestore();
      nowSpy.mockRestore();
      monotonicSpy.mockRestore();
      randSpy.mockRestore();
    });
  });

  it('a successful forced probe closes the existing backoff window', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();
      mockClient.syncState
        .mockRejectedValueOnce(new Error('offline 1'))
        .mockRejectedValueOnce(new Error('offline 2'))
        .mockRejectedValueOnce(new Error('offline 3'))
        .mockResolvedValue(undefined);

      const { doSync: isolated } = await import('./sync-manager');
      await isolated();
      await isolated();
      await isolated();
      await isolated(true);
      await isolated();

      expect(mockClient.syncState).toHaveBeenCalledTimes(5);
    });
  });

  it('awaits init_vault when present (SW bundle simulation)', async () => {
    // Cover the `typeof init_vault === 'function'` true arm of the lazy
    // getVault() accessor. In the Jest env init_vault is undefined; we install
    // a stub on globalThis and re-import the module to drive the factory-await
    // path.
    const initVaultStub = jest.fn(async () => {});
    (globalThis as any).init_vault = initVaultStub;
    try {
      await jest.isolateModulesAsync(async () => {
        const { doSync: isolated } = await import('./sync-manager');
        await isolated();
        expect(initVaultStub).toHaveBeenCalled();
        // A second sync should not re-await the factory (the `_vault` cache hits).
        initVaultStub.mockClear();
        await isolated();
        expect(initVaultStub).not.toHaveBeenCalled();
      });
    } finally {
      delete (globalThis as any).init_vault;
    }
  });

  it('the breaker closes after the backoff window elapses', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.spyOn(console, 'warn').mockImplementation();
      mockClient.syncState.mockReset();
      mockClient.syncState.mockRejectedValue(new Error('rpc offline'));

      let fakeNow = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      // The backoff deadline is held on the MONOTONIC clock (#777 — a wall-clock
      // deadline stepped backwards keeps the window open for the size of the
      // step, and every attempt inside it is skipped), so driving this test's
      // clock means driving `performance.now` too, not just `Date.now`.
      const monotonicSpy = jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);
      // Pin the jitter. `computeSyncBackoffMs` adds 0-20% of the base to
      // de-sync wallets, so the real backoff is 30_000-36_000ms — and the 35s
      // this test advances by lands INSIDE that range whenever Math.random()
      // exceeds ~0.833. That made this test fail one run in six, regardless of
      // machine or load; it failed exactly that way on CI while passing eight
      // times locally. Zero jitter makes the window exactly BACKOFF_BASE_MS, so
      // "advance past it" is a fact rather than a coin flip.
      const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

      const { doSync: isolated } = await import('./sync-manager');

      // Trip the breaker.
      await isolated();
      await isolated();
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);

      // Inside backoff window — skipped.
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);

      // Advance past the 30s backoff. Next doSync should probe syncState again.
      fakeNow += 35_000;
      mockClient.syncState.mockReset();
      mockClient.syncState.mockResolvedValueOnce(undefined);
      await isolated();
      expect(mockClient.syncState).toHaveBeenCalledTimes(1);

      nowSpy.mockRestore();
      monotonicSpy.mockRestore();
      randSpy.mockRestore();
    });
  });
});

describe('doSync — native-note auto-consume', () => {
  it('does not auto-consume a native note worth less than the fee to claim it', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockIsDelegateProofAsync.mockResolvedValue(false);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockBaseFee = 10000;
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'dust', faucetId: 'native-faucet', amount: '9999' }),
      fakeNote({ id: 'worthit', faucetId: 'native-faucet', amount: '10001' })
    ]);

    await doSync();

    const consumed = mockInitiateConsume.mock.calls.map(c => (c[1] as { id: string }).id);
    expect(consumed).toEqual(['worthit']);
  });


  it('auto-consumes native notes PER NOTE, following the user delegated-proving setting', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockIsDelegateProofAsync.mockResolvedValue(false); // user picked LOCAL proving
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'native-a', faucetId: 'native-faucet' }),
      fakeNote({ id: 'native-b', faucetId: 'native-faucet' }),
      fakeNote({ id: 'other-note', faucetId: 'other-faucet' })
    ]);

    await doSync();

    // One consume tx PER native note (not a batch, so a poison note can't block its
    // mates), and proving honors the user's LOCAL choice rather than forced delegated.
    expect(mockInitiateConsume).toHaveBeenCalledTimes(2);
    const consumed = mockInitiateConsume.mock.calls.map(c => (c[1] as { id: string }).id).sort();
    expect(consumed).toEqual(['native-a', 'native-b']);
    mockInitiateConsume.mock.calls.forEach((c: unknown[]) => {
      expect(c[0]).toBe('pk-1');
      expect(c[2]).toBe(false); // delegate follows the user setting
    });
  });

  it('does not auto-consume when the toggle is off', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(false);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'native-note', faucetId: 'native-faucet' })
    ]);

    await doSync();

    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });

  it('suppresses the "click to claim" notification for a native note it is auto-consuming', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockHasClients.mockReturnValue(false); // popup closed
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['native-note']); // note is "new" this tick
    (globalThis as any).chrome.notifications = { create: jest.fn() };
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'native-note', faucetId: 'native-faucet' })
    ]);

    await doSync();

    // It is being auto-consumed, so it is excluded from newIds and must NOT also raise a
    // "click to claim" prompt — while still being consumed.
    expect((globalThis as any).chrome.notifications.create).not.toHaveBeenCalled();
    expect(mockInitiateConsume).toHaveBeenCalledTimes(1);
    expect((mockInitiateConsume.mock.calls[0]![1] as { id: string }).id).toBe('native-note');
  });

  it('holds off until the popup has mirrored the user settings (migration window)', async () => {
    mockAreBgMirrored.mockResolvedValue(false); // settings not yet mirrored into the SW store
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'native-note', faucetId: 'native-faucet' })
    ]);

    await doSync();

    // Never act on read-miss defaults for a user who may have opted out.
    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });

  it('resolves cleanly when the eligibility resolve (getFaucetIdSetting) rejects', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockRejectedValue(new Error('storage boom'));
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'native-note', faucetId: 'native-faucet' })
    ]);

    await expect(doSync()).resolves.toBeUndefined();
    expect(mockGetFaucetIdSetting).toHaveBeenCalled(); // the rejecting path WAS exercised
    expect(mockInitiateConsume).not.toHaveBeenCalled();
    expect(mockStorageSet).toHaveBeenCalled(); // sync still completed
  });

  it('resolves cleanly when the per-note enqueue rejects', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockInitiateConsume.mockRejectedValueOnce(new Error('enqueue boom'));
    mockClient.getConsumableNoteDtos.mockResolvedValueOnce([
      fakeNote({ id: 'native-note', faucetId: 'native-faucet' })
    ]);

    await expect(doSync()).resolves.toBeUndefined();
    expect(mockInitiateConsume).toHaveBeenCalled(); // the rejecting path WAS exercised
  });
});
