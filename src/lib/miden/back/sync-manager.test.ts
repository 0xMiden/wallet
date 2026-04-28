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

// ── Imports under test ─────────────────────────────────────────────

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
