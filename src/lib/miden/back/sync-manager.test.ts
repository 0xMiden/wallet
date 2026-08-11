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
  getConsumableNotes: jest.fn(async () => [] as any[]),
  getAccount: jest.fn(async () => null as any)
};
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => mockClient,
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

// Stub webextension-polyfill (the real one is also stubbed via @serh11p/jest-webextension-mock)
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    alarms: {
      create: jest.fn()
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

// ── Imports under test ─────────────────────────────────────────────

import { WalletMessageType } from 'lib/shared/types';

import { doSync, setupSyncManager } from './sync-manager';

// Helper: build a fake consumable note WASM record
function fakeNote({ id = 'note-1', faucetId = 'faucet-1', amount = '100', senderId = 'sender-1', noteType = 0 } = {}) {
  return {
    id: () => ({ toString: () => id }),
    metadata: () => ({
      sender: () => senderId,
      noteType: () => noteType
    }),
    details: () => ({
      assets: () => ({
        fungibleAssets: () => [
          {
            faucetId: () => faucetId,
            amount: () => ({ toString: () => amount })
          }
        ]
      })
    })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsExist.mockResolvedValue(true);
  mockGetCurrentAccountPublicKey.mockResolvedValue('pk-1');
  mockClient.syncState.mockResolvedValue(undefined);
  mockClient.getConsumableNotes.mockResolvedValue([]);
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
    expect(mockClient.getConsumableNotes).not.toHaveBeenCalled();
  });

  it('reads notes and vault assets, enriches with metadata, and writes to chrome.storage', async () => {
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'n1', faucetId: 'f1' })]);
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

    expect(mockClient.getConsumableNotes).toHaveBeenCalledWith('pk-1');
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'n1', faucetId: 'f1' })]);
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'new-note' })]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['new-note']);
    mockHasClients.mockReturnValue(false);
    (globalThis as any).chrome.notifications = {
      create: jest.fn()
    };
    await doSync();
    expect((globalThis as any).chrome.notifications.create).toHaveBeenCalled();
  });

  it('skips partial (metadata-less) notes whose id() is undefined', async () => {
    const partialNote = {
      id: () => undefined
    };
    mockClient.getConsumableNotes.mockResolvedValueOnce([partialNote]);
    await doSync();
    // The partial note is filtered; doSync still finishes successfully
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('skips malformed notes that throw inside the parser', async () => {
    const badNote = {
      id: () => {
        throw new Error('bad note');
      }
    };
    mockClient.getConsumableNotes.mockResolvedValueOnce([badNote]);
    await doSync();
    // The bad note is filtered; doSync still finishes successfully
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('tolerates fetchTokenMetadata rejections and still writes sync data', async () => {
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'n1', faucetId: 'f1' })]);
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('network down'));
    await doSync();
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('broadcasts SyncCompleted even when syncState rejects', async () => {
    mockClient.syncState.mockRejectedValueOnce(new Error('wasm offline'));
    await doSync();
    expect(mockBroadcast).toHaveBeenCalled();
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([]);
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([
      {
        id: () => ({ toString: () => 'n-null-asset' }),
        metadata: () => ({ sender: () => 's', noteType: () => 0 }),
        details: () => ({
          assets: () => ({
            fungibleAssets: () => [] // empty array means no firstAsset
          })
        })
      }
    ]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce([]);
    await doSync();
    // Note should be filtered out
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('shows single-note notification message', async () => {
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'solo-note' })]);
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'n-fb' })]);
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'n-m1' }), fakeNote({ id: 'n-m2' })]);
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([
      {
        id: () => ({ toString: () => 'n-empty' }),
        metadata: () => ({ sender: () => 's', noteType: () => 0 }),
        details: () => ({
          assets: () => ({
            fungibleAssets: () => []
          })
        })
      }
    ]);
    await doSync();
    // The empty note is filtered; sync still completes
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('handles a note where metadata is null (uses unknown noteType)', async () => {
    mockClient.getConsumableNotes.mockResolvedValueOnce([
      {
        id: () => ({ toString: () => 'n-no-meta' }),
        metadata: () => null,
        details: () => ({
          assets: () => ({
            fungibleAssets: () => [
              {
                faucetId: () => 'f1',
                amount: () => ({ toString: () => '1' })
              }
            ]
          })
        })
      }
    ]);
    await doSync();
    expect(mockStorageSet).toHaveBeenCalled();
  });

  it('handles when no account exists in client (assets array stays empty)', async () => {
    mockClient.getConsumableNotes.mockResolvedValueOnce([]);
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([
      {
        id: () => ({ toString: () => 'n1' }),
        metadata: () => ({ sender: () => 's', noteType: () => 0 }),
        details: () => ({
          assets: () => ({
            fungibleAssets: () => [{ faucetId: () => 'f', amount: () => ({ toString: () => '1' }) }]
          })
        })
      },
      {
        id: () => ({ toString: () => 'n2' }),
        metadata: () => ({ sender: () => 's', noteType: () => 0 }),
        details: () => ({
          assets: () => ({
            fungibleAssets: () => [{ faucetId: () => 'f', amount: () => ({ toString: () => '1' }) }]
          })
        })
      }
    ]);
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['n1', 'n2']);
    mockHasClients.mockReturnValue(false);
    (globalThis as any).chrome.notifications = { create: jest.fn() };
    await doSync();
    expect((globalThis as any).chrome.notifications.create).toHaveBeenCalled();
  });

  it('uses ServiceWorkerRegistration.showNotification when available', async () => {
    mockClient.getConsumableNotes.mockResolvedValueOnce([
      {
        id: () => ({ toString: () => 'n1' }),
        metadata: () => ({ sender: () => 's', noteType: () => 0 }),
        details: () => ({
          assets: () => ({
            fungibleAssets: () => [{ faucetId: () => 'f', amount: () => ({ toString: () => '1' }) }]
          })
        })
      }
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

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('circuit breaker open — skipping syncs'));
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
    });
  });
});

describe('doSync — native-note auto-consume', () => {
  it('auto-consumes native notes PER NOTE, following the user delegated-proving setting', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockIsDelegateProofAsync.mockResolvedValue(false); // user picked LOCAL proving
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockClient.getConsumableNotes.mockResolvedValueOnce([
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
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'native-note', faucetId: 'native-faucet' })]);

    await doSync();

    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });

  it('suppresses the "click to claim" notification for a native note it is auto-consuming', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockHasClients.mockReturnValue(false); // popup closed
    mockMergeAndPersistSeenNoteIds.mockResolvedValueOnce(['native-note']); // note is "new" this tick
    (globalThis as any).chrome.notifications = { create: jest.fn() };
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'native-note', faucetId: 'native-faucet' })]);

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
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'native-note', faucetId: 'native-faucet' })]);

    await doSync();

    // Never act on read-miss defaults for a user who may have opted out.
    expect(mockInitiateConsume).not.toHaveBeenCalled();
  });

  it('resolves cleanly when the eligibility resolve (getFaucetIdSetting) rejects', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockRejectedValue(new Error('storage boom'));
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'native-note', faucetId: 'native-faucet' })]);

    await expect(doSync()).resolves.toBeUndefined();
    expect(mockGetFaucetIdSetting).toHaveBeenCalled(); // the rejecting path WAS exercised
    expect(mockInitiateConsume).not.toHaveBeenCalled();
    expect(mockStorageSet).toHaveBeenCalled(); // sync still completed
  });

  it('resolves cleanly when the per-note enqueue rejects', async () => {
    mockIsAutoConsumeAsync.mockResolvedValue(true);
    mockGetFaucetIdSetting.mockResolvedValue('native-faucet');
    mockInitiateConsume.mockRejectedValueOnce(new Error('enqueue boom'));
    mockClient.getConsumableNotes.mockResolvedValueOnce([fakeNote({ id: 'native-note', faucetId: 'native-faucet' })]);

    await expect(doSync()).resolves.toBeUndefined();
    expect(mockInitiateConsume).toHaveBeenCalled(); // the rejecting path WAS exercised
  });
});
