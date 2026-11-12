import { getBackupBaseUrl } from 'lib/remote-config/values';
import type { BackupRefreshReason } from 'lib/shared/types';

import { syncAccounts } from './features/accounts';
import { syncContacts } from './features/contacts';
import { flushHistory, peerHistoryChunkCount, readHistory } from './features/history';
import {
  GUARDIAN_REREAD_DELAYS_MS,
  deleteBackupProfile,
  onBackupLock,
  restoreHistoryFromBackup,
  runBackupRefresh
} from './refresh';
import {
  type BackupSession,
  BackupSessionClosedError,
  clearBackupSession,
  getBackupSession,
  isSessionLive
} from './session';
import { readBackupState } from './state';
import {
  FakeVault,
  FakeWalletApi,
  MemoryStorage,
  PHRASE_A,
  getActiveStorage,
  installCopyingImportKey,
  installFakeFetch,
  setActiveStorage,
  setActiveVault
} from './testing/backup-harness';

jest.mock('lib/miden/back/store', () => {
  const harness = jest.requireActual<typeof import('./testing/backup-harness')>('./testing/backup-harness');
  return {
    store: { getState: () => harness.fakeStoreState() },
    isUnlocked: harness.isFakeUnlocked,
    accountsUpdated: jest.fn(),
    settingsUpdated: jest.fn()
  };
});
jest.mock('lib/platform/storage-adapter', () => {
  const harness = jest.requireActual<typeof import('./testing/backup-harness')>('./testing/backup-harness');
  return { getStorageProvider: () => harness.getActiveStorage() };
});
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: jest.fn(async () => undefined),
  getBridgeConfigSnapshot: jest.fn()
}));
jest.mock('lib/remote-config/values', () => ({ getBackupBaseUrl: jest.fn(() => 'https://wallet-api.test') }));
jest.mock('./features/accounts', () => ({ syncAccounts: jest.fn() }));
jest.mock('./features/contacts', () => ({ syncContacts: jest.fn() }));
jest.mock('./features/history', () => ({
  flushHistory: jest.fn(),
  peerHistoryChunkCount: jest.fn(),
  readHistory: jest.fn()
}));

const savedDefine = process.env.MIDEN_WALLET_API_URL;
let removeImportShim: () => void;
let server: FakeWalletApi;
let restoreFetch: () => void;
let vault: FakeVault;
let session: BackupSession;

const ALL_REASONS: BackupRefreshReason[] = [
  'unlock',
  'foreground',
  'address-book',
  'contacts-changed',
  'activity-open',
  'guardian-adopt',
  'transaction-completed'
];

beforeAll(() => {
  delete process.env.MIDEN_WALLET_API_URL;
  removeImportShim = installCopyingImportKey();
});

afterAll(() => {
  if (savedDefine !== undefined) process.env.MIDEN_WALLET_API_URL = savedDefine;
  removeImportShim();
});

beforeEach(async () => {
  onBackupLock();
  server = new FakeWalletApi();
  restoreFetch = installFakeFetch(server);
  vault = new FakeVault(PHRASE_A);
  setActiveVault(vault);
  setActiveStorage(new MemoryStorage());
  jest.mocked(syncAccounts).mockReset().mockResolvedValue(false);
  jest.mocked(syncContacts).mockReset().mockResolvedValue(false);
  jest.mocked(readHistory).mockReset().mockResolvedValue(false);
  jest.mocked(flushHistory).mockReset().mockResolvedValue(0);
  jest.mocked(peerHistoryChunkCount).mockReset().mockResolvedValue(0);
  // The session opens with real timers; the schedule tests then take fake ones.
  const opened = await getBackupSession();
  if (!('session' in opened)) throw new Error(`No session: ${opened.unavailable}`);
  session = opened.session;
});

afterEach(() => {
  onBackupLock();
  restoreFetch();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('runBackupRefresh dispatch', () => {
  it.each(ALL_REASONS)('reports disabled for %s without a base URL, and sends nothing', async reason => {
    jest.mocked(getBackupBaseUrl).mockReturnValueOnce(null);
    const mark = server.requests.length;
    await expect(runBackupRefresh(reason)).resolves.toBe('disabled');
    expect(server.requestsSince(mark)).toHaveLength(0);
    expect(syncAccounts).not.toHaveBeenCalled();
  });

  it.each<BackupRefreshReason>(['unlock', 'foreground'])(
    '%s reads the storage index, then every changed feature, then flushes the history',
    async reason => {
      const mark = server.requests.length;
      await expect(runBackupRefresh(reason)).resolves.toBe('unchanged');

      expect(server.requestsSince(mark).map(request => `${request.method} ${request.path}`)).toEqual([
        'GET /v1/storage'
      ]);
      expect(syncAccounts).toHaveBeenCalledWith(session, true);
      expect(syncContacts).toHaveBeenCalledWith(session, true);
      expect(readHistory).toHaveBeenCalledWith(session, true);
      expect(flushHistory).toHaveBeenCalledWith(session);
      // Every changed feature is applied, so the profile ETag moves and is saved.
      const etag = server.requestsSince(mark)[0]?.etag;
      expect(session.state.profileEtag).toBe(etag);
      expect(readBackupState(getActiveStorage().read('backup_state_v1'))?.profileEtag).toBe(etag);
    }
  );

  it('unlock after a 304 reads no feature, uploads the local changes and keeps the profile ETag', async () => {
    await runBackupRefresh('unlock');
    const etag = session.state.profileEtag;
    jest.mocked(syncAccounts).mockClear();
    jest.mocked(syncContacts).mockClear();
    jest.mocked(readHistory).mockClear();
    const mark = server.requests.length;

    await expect(runBackupRefresh('foreground')).resolves.toBe('unchanged');
    expect(server.requestsSince(mark).map(request => [request.path, request.ifNoneMatch, request.status])).toEqual([
      ['/v1/storage', etag, 304]
    ]);
    expect(syncAccounts).toHaveBeenCalledWith(session, false);
    expect(syncContacts).toHaveBeenCalledWith(session, false);
    expect(readHistory).not.toHaveBeenCalled();
    expect(flushHistory).toHaveBeenCalledTimes(2);
    expect(session.state.profileEtag).toBe(etag);
  });

  it('unlock reads only the feature whose ETag changed', async () => {
    server.insertEntry(session.publicKey, 'contacts', 'c'.repeat(64), { envelope: 1, kdfParams: 1, blob: 'AAAA' });
    const unchanged: ('accounts' | 'history')[] = ['accounts', 'history'];
    for (const feature of unchanged) {
      session.state.features[feature].etag = server.featureEtagOf(session.publicKey, feature);
    }
    jest.mocked(syncContacts).mockResolvedValue(true);

    await expect(runBackupRefresh('unlock')).resolves.toBe('updated');
    expect(syncAccounts).toHaveBeenCalledWith(session, false);
    expect(syncContacts).toHaveBeenCalledWith(session, true);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it.each<BackupRefreshReason>(['address-book', 'contacts-changed'])(
    '%s reads and uploads the contacts only',
    async reason => {
      jest.mocked(syncContacts).mockResolvedValue(true);
      const mark = server.requests.length;
      await expect(runBackupRefresh(reason)).resolves.toBe('updated');
      expect(syncContacts).toHaveBeenCalledWith(session, true);
      expect(syncAccounts).not.toHaveBeenCalled();
      expect(readHistory).not.toHaveBeenCalled();
      expect(server.requestsSince(mark)).toHaveLength(0);
    }
  );

  it('activity-open reads the history with since once, and schedules no re-read', async () => {
    jest.useFakeTimers();
    await expect(runBackupRefresh('activity-open')).resolves.toBe('unchanged');
    await jest.advanceTimersByTimeAsync(600_000);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(readHistory).toHaveBeenCalledWith(session, true);
    expect(flushHistory).toHaveBeenCalledTimes(1);
  });

  it('transaction-completed flushes the history at once', async () => {
    jest.mocked(flushHistory).mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await expect(runBackupRefresh('transaction-completed')).resolves.toBe('updated');
    await expect(runBackupRefresh('transaction-completed')).resolves.toBe('unchanged');
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('reports locked for a session that closed under the refresh, and logs no failure', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(syncContacts).mockRejectedValueOnce(new BackupSessionClosedError('locked'));
    await expect(runBackupRefresh('contacts-changed')).resolves.toBe('locked');
    expect(info).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports failed and logs any other error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(syncContacts).mockRejectedValueOnce(new Error('boom'));
    await expect(runBackupRefresh('address-book')).resolves.toBe('failed');
    expect(warn).toHaveBeenCalled();
  });

  it('gives the reason no session opened', async () => {
    clearBackupSession();
    setActiveVault(new FakeVault(null));
    await expect(runBackupRefresh('unlock')).resolves.toBe('no-sync-key');
    setActiveVault(null);
    await expect(runBackupRefresh('unlock')).resolves.toBe('locked');
  });
});

describe('Guardian adoption re-reads', () => {
  it('pins the delays at 10, 30 and 60 seconds', () => {
    expect(GUARDIAN_REREAD_DELAYS_MS).toEqual([10_000, 30_000, 60_000]);
  });

  it('reads again after 10, 30 and 60 s while each read finds nothing, then stops', async () => {
    jest.useFakeTimers();
    await expect(runBackupRefresh('guardian-adopt')).resolves.toBe('unchanged');
    expect(readHistory).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(9_999);
    expect(readHistory).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(readHistory).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(readHistory).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(readHistory).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(4);
  });

  it('stops once a re-read finds the peer history', async () => {
    jest.useFakeTimers();
    jest.mocked(readHistory).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await runBackupRefresh('guardian-adopt');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(readHistory).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(2);
  });

  it('schedules nothing when the first read finds the peer history', async () => {
    jest.useFakeTimers();
    jest.mocked(readHistory).mockResolvedValueOnce(true);
    await expect(runBackupRefresh('guardian-adopt')).resolves.toBe('updated');
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(1);
  });

  it('stops after a re-read that fails', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(readHistory).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('network'));
    await runBackupRefresh('guardian-adopt');
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('restarts the schedule on a new adoption and never stacks a second one', async () => {
    jest.useFakeTimers();
    await runBackupRefresh('guardian-adopt');
    await jest.advanceTimersByTimeAsync(5_000);
    await runBackupRefresh('guardian-adopt');
    expect(readHistory).toHaveBeenCalledTimes(2);

    // The first schedule's 10 s mark passes with no read: the new adoption replaced it.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(readHistory).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(readHistory).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(5);
  });

  it('stops the pending re-reads and drops the keys on lock', async () => {
    jest.useFakeTimers();
    await runBackupRefresh('guardian-adopt');
    onBackupLock();
    expect(isSessionLive(session)).toBe(false);
    expect(session.storageKey.every(byte => byte === 0)).toBe(true);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(1);
  });
});

describe('restoreHistoryFromBackup', () => {
  it('is true only when a peer chunk was applied', async () => {
    jest.mocked(peerHistoryChunkCount).mockResolvedValueOnce(1);
    await expect(restoreHistoryFromBackup()).resolves.toBe(true);
    expect(readHistory).toHaveBeenCalledWith(session, true);

    jest.mocked(peerHistoryChunkCount).mockResolvedValueOnce(0);
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);
  });

  it('is false while the backup is off or no session opens', async () => {
    jest.mocked(getBackupBaseUrl).mockReturnValueOnce(null);
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);
    setActiveVault(null);
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('never throws: a failed read is logged and gives false', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(readHistory).mockRejectedValueOnce(new Error('network'));
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();

    warn.mockClear();
    jest.mocked(readHistory).mockRejectedValueOnce(new BackupSessionClosedError('locked'));
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('deleteBackupProfile', () => {
  it('deletes the server profile, closes the session and removes the local records', async () => {
    session.merge.contactsBase = '[]';
    await runBackupRefresh('unlock');
    expect(getActiveStorage().has('backup_state_v1')).toBe(true);
    jest.useFakeTimers();
    await runBackupRefresh('guardian-adopt');
    const reads = jest.mocked(readHistory).mock.calls.length;

    await expect(deleteBackupProfile()).resolves.toBe('updated');
    expect(server.profileOf(session.publicKey)).toBeUndefined();
    expect(isSessionLive(session)).toBe(false);
    expect(getActiveStorage().has('backup_state_v1')).toBe(false);
    expect(JSON.parse(vault.mergeRecords ?? '{}').contactsBase).toBeNull();
    // The pending Guardian re-reads stop with the profile.
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(readHistory).toHaveBeenCalledTimes(reads);
  });

  it('reports disabled, locked and failed', async () => {
    jest.mocked(getBackupBaseUrl).mockReturnValueOnce(null);
    await expect(deleteBackupProfile()).resolves.toBe('disabled');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    server.failNext('DELETE', '/v1/profile', { status: 503, body: { error: 'service_unavailable', message: 'down' } });
    await expect(deleteBackupProfile()).resolves.toBe('failed');
    expect(warn).toHaveBeenCalled();
    expect(server.profileOf(session.publicKey)).toBeDefined();

    // The token is refused and the wallet locks before the login again.
    server.failNext('DELETE', '/v1/profile', { status: 401, body: { error: 'unauthorized', message: 'expired' } });
    server.onRequest = request => {
      if (request.method === 'DELETE') setActiveVault(null);
    };
    await expect(deleteBackupProfile()).resolves.toBe('locked');
    server.onRequest = null;

    await expect(deleteBackupProfile()).resolves.toBe('locked');
  });
});
