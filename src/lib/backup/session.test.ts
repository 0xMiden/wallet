import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { getBackupBaseUrl } from 'lib/remote-config/values';

import { getStorageIndex } from './api-client';
import {
  decryptEntry,
  deriveEncryptionKeyBytes,
  encryptEntry,
  importEncryptionKey,
  packKdfParams,
  DEFAULT_SCRYPT_PARAMS
} from './crypto';
import {
  type BackupSession,
  BackupSessionClosedError,
  assertSessionLive,
  clearBackupSession,
  getBackupSession,
  isSessionLive,
  persistMergeRecords,
  withSessionToken
} from './session';
import { backupStorageEpoch, emptyMergeRecords, onBackupStorageCleared } from './state';
import { deriveSyncSecretKey, signSyncMessage, storageKeyMessage } from './sync-key';
import {
  FakeVault,
  FakeWalletApi,
  MemoryStorage,
  PHRASE_A,
  PHRASE_B,
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

const savedDefine = process.env.MIDEN_WALLET_API_URL;
let server: FakeWalletApi;
let restoreFetch: () => void;
let vault: FakeVault;

/** Open a session and fail the test when none opens. */
async function openSession(): Promise<BackupSession> {
  const result = await getBackupSession();
  if (!('session' in result)) throw new Error(`No session: ${result.unavailable}`);
  return result.session;
}

async function publicKeyOf(target: FakeVault): Promise<string> {
  const publicKey = await target.syncPublicKey();
  if (publicKey === null) throw new Error('The fake vault has no sync key');
  return publicKey;
}

function paths(mark = 0): string[] {
  return server.requestsSince(mark).map(request => `${request.method} ${request.path} ${request.status}`);
}

let removeImportShim: () => void;

beforeAll(() => {
  delete process.env.MIDEN_WALLET_API_URL;
  removeImportShim = installCopyingImportKey();
});

afterAll(() => {
  if (savedDefine !== undefined) process.env.MIDEN_WALLET_API_URL = savedDefine;
  removeImportShim();
});

beforeEach(() => {
  clearBackupSession();
  server = new FakeWalletApi();
  restoreFetch = installFakeFetch(server);
  vault = new FakeVault(PHRASE_A);
  setActiveVault(vault);
  setActiveStorage(new MemoryStorage());
});

afterEach(() => {
  clearBackupSession();
  restoreFetch();
  jest.restoreAllMocks();
});

describe('getBackupSession', () => {
  it('opens a new profile: nonce, login, salt bootstrap, then the keys', async () => {
    const session = await openSession();

    expect(paths()).toEqual(['POST /v1/auth/nonce 200', 'POST /v1/auth/login 200', 'PUT /v1/profile/salt 200']);
    const profile = server.profileOf(session.publicKey);
    expect(profile?.profileId).toBe(session.profileId);
    expect(profile?.salt).toBe(session.salt);
    expect(session.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(session.kdfParams).toBe(packKdfParams(DEFAULT_SCRYPT_PARAMS));
    expect(session.state.salt).toBe(session.salt);
  });

  it('derives storageKey = sha256(signature over the storage-key message) and encKey = scrypt(storageKey, salt)', async () => {
    const session = await openSession();

    const secret = deriveSyncSecretKey(PHRASE_A);
    const signature = signSyncMessage(secret, storageKeyMessage(session.profileId));
    expect(bytesToHex(session.storageKey)).toBe(bytesToHex(sha256(signature)));

    // A key made apart from the session, with the production parameters, opens what the session seals.
    const independent = await importEncryptionKey(
      await deriveEncryptionKeyBytes(sha256(signature), hexToBytes(session.salt))
    );
    const sealed = await encryptEntry(session.encKey, 'plaintext', session.kdfParams);
    await expect(decryptEntry(independent, sealed, 4096)).resolves.toBe('plaintext');
    const otherSalt = await importEncryptionKey(
      await deriveEncryptionKeyBytes(sha256(signature), new Uint8Array(16).fill(1))
    );
    await expect(decryptEntry(otherSalt, sealed, 4096)).rejects.toBeDefined();
  });

  it('gives the same open session to concurrent callers and to later callers', async () => {
    const [first, second] = await Promise.all([getBackupSession(), getBackupSession()]);
    expect(first).toBe(second);
    const later = await getBackupSession();
    expect('session' in later && 'session' in first && later.session === first.session).toBe(true);
    expect(paths().filter(path => path.startsWith('POST /v1/auth/login'))).toHaveLength(1);
  });

  it('uses the salt that the login gives and proposes none', async () => {
    const first = await openSession();
    const salt = first.salt;
    clearBackupSession();
    const mark = server.requests.length;

    const second = await openSession();
    expect(second).not.toBe(first);
    expect(second.salt).toBe(salt);
    expect(paths(mark)).toEqual(['POST /v1/auth/nonce 200', 'POST /v1/auth/login 200']);
  });

  it("takes another device's salt on 409", async () => {
    const otherSalt = 'ab'.repeat(16);
    const publicKey = await publicKeyOf(vault);
    server.onRequest = request => {
      if (request.method === 'PUT' && request.path === '/v1/profile/salt') server.setSalt(publicKey, otherSalt);
    };

    const session = await openSession();
    expect(session.salt).toBe(otherSalt);
    expect(paths()).toContain('PUT /v1/profile/salt 409');
  });

  it('reports disabled without a base URL and sends nothing', async () => {
    jest.mocked(getBackupBaseUrl).mockReturnValueOnce(null);
    await expect(getBackupSession()).resolves.toEqual({ unavailable: 'disabled' });
    expect(server.requests).toHaveLength(0);
  });

  it('reports locked while the store has no vault', async () => {
    setActiveVault(null);
    await expect(getBackupSession()).resolves.toEqual({ unavailable: 'locked' });
    expect(server.requests).toHaveLength(0);
  });

  it('reports no-sync-key for a wallet with no phrase', async () => {
    setActiveVault(new FakeVault(null));
    await expect(getBackupSession()).resolves.toEqual({ unavailable: 'no-sync-key' });
    expect(server.requests).toHaveLength(0);
  });

  it('reports failed and logs it when the login fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    server.failNext('POST', '/v1/auth/login', { status: 500, body: { error: 'service_unavailable', message: 'down' } });
    await expect(getBackupSession()).resolves.toEqual({ unavailable: 'failed' });
    expect(warn).toHaveBeenCalled();
  });

  it('tries a refused nonce once more, and only once', async () => {
    const nonceInvalid = { status: 401, body: { error: 'nonce_invalid', message: 'spent' } };
    server.failNext('POST', '/v1/auth/login', nonceInvalid);
    await openSession();
    expect(paths().filter(path => path.startsWith('POST /v1/auth/nonce'))).toHaveLength(2);

    clearBackupSession();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    server.failNext('POST', '/v1/auth/login', nonceInvalid);
    server.failNext('POST', '/v1/auth/login', nonceInvalid);
    await expect(getBackupSession()).resolves.toEqual({ unavailable: 'failed' });
    expect(warn).toHaveBeenCalled();
  });

  it('discards an open that a lock overtook', async () => {
    // The lock lands while the open waits for the login.
    server.onRequest = request => {
      if (request.path === '/v1/auth/login') clearBackupSession();
    };
    await expect(getBackupSession()).resolves.toEqual({ unavailable: 'locked' });
    server.onRequest = null;

    const session = await openSession();
    expect(isSessionLive(session)).toBe(true);
  });

  it('renews the token at 90 % of its life on the same session', async () => {
    const session = await openSession();
    const token = session.token;
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 3_240_000 + 1);
    const mark = server.requests.length;

    const renewed = await openSession();
    expect(renewed).toBe(session);
    expect(renewed.token).not.toBe(token);
    expect(paths(mark)).toEqual(['POST /v1/auth/nonce 200', 'POST /v1/auth/login 200']);
  });

  it('opens a new session when the renewal finds a profile the server made again', async () => {
    const session = await openSession();
    session.merge.contactsBase = '[]';
    await withSessionToken(session, async token => {
      const response = await fetch('https://wallet-api.test/v1/profile', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.status;
    });
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_240_001);

    const replaced = await openSession();
    expect(replaced).not.toBe(session);
    expect(replaced.salt).not.toBe(session.salt);
    expect(replaced.merge.contactsBase).toBeNull();
    expect(isSessionLive(session)).toBe(false);
  });
});

describe('session liveness', () => {
  it('closes the session on lock, with the reason locked', async () => {
    const session = await openSession();
    setActiveVault(null);
    expect(isSessionLive(session)).toBe(false);
    expect(() => assertSessionLive(session)).toThrow(new BackupSessionClosedError('locked'));
  });

  it('closes the session when another vault takes the store, and opens one for that vault', async () => {
    const session = await openSession();
    const other = new FakeVault(PHRASE_B);
    setActiveVault(other);
    expect(isSessionLive(session)).toBe(false);

    const next = await openSession();
    expect(next.vault).toBe(other);
    expect(next.publicKey).not.toBe(session.publicKey);
  });

  it('closes the session on a storage wipe, with the reason replaced', async () => {
    const session = await openSession();
    const before = backupStorageEpoch();
    onBackupStorageCleared();
    expect(backupStorageEpoch()).toBe(before + 1);
    expect(isSessionLive(session)).toBe(false);
    let reason: string | null = null;
    try {
      assertSessionLive(session);
    } catch (error) {
      reason = error instanceof BackupSessionClosedError ? error.reason : null;
    }
    expect(reason).toBe('replaced');

    const next = await openSession();
    expect(next).not.toBe(session);
  });

  it('zeroes the storage key on clear', async () => {
    const session = await openSession();
    expect(session.storageKey.some(byte => byte !== 0)).toBe(true);
    clearBackupSession();
    expect(session.storageKey.every(byte => byte === 0)).toBe(true);
  });
});

describe('withSessionToken', () => {
  it('logs in again once on a refused token and runs the call again', async () => {
    const session = await openSession();
    const firstToken = session.token;
    server.failNext('GET', '/v1/storage', { status: 401, body: { error: 'unauthorized', message: 'expired' } });

    const index = await withSessionToken(session, token => getStorageIndex(token, null));
    expect(index?.features.accounts).toBeDefined();
    expect(session.token).not.toBe(firstToken);
  });

  it('gives any other error to the caller', async () => {
    const session = await openSession();
    server.failNext('GET', '/v1/storage', { status: 503, body: { error: 'service_unavailable', message: 'down' } });
    await expect(withSessionToken(session, token => getStorageIndex(token, null))).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable'
    });
  });

  it('closes the session when the token refresh finds a profile the server made again', async () => {
    const session = await openSession();
    await withSessionToken(session, token =>
      fetch('https://wallet-api.test/v1/profile', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    );
    await expect(withSessionToken(session, token => getStorageIndex(token, null))).rejects.toEqual(
      new BackupSessionClosedError('replaced')
    );
    expect(isSessionLive(session)).toBe(false);
  });

  it('refuses a closed session before any request', async () => {
    const session = await openSession();
    clearBackupSession();
    const mark = server.requests.length;
    const call = jest.fn(async () => 1);
    await expect(withSessionToken(session, call)).rejects.toBeInstanceOf(BackupSessionClosedError);
    expect(call).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(mark);
  });
});

describe('merge records', () => {
  it('loads the records of this sync key and ignores the records of another key', async () => {
    const first = await openSession();
    vault.mergeRecords = JSON.stringify({ ...emptyMergeRecords(first.publicKey), contactsBase: '[["A","x","t"]]' });
    clearBackupSession();
    expect((await openSession()).merge.contactsBase).toBe('[["A","x","t"]]');

    vault.mergeRecords = JSON.stringify({ ...emptyMergeRecords('another-key'), contactsBase: '[]' });
    clearBackupSession();
    const third = await openSession();
    expect(third.merge).toEqual(emptyMergeRecords(third.publicKey));
  });

  it('clears the contacts base on a new key generation', async () => {
    vault.mergeRecords = JSON.stringify({ ...emptyMergeRecords(await publicKeyOf(vault)), contactsBase: '[]' });
    const session = await openSession();
    expect(session.merge.contactsBase).toBeNull();
    expect(vault.mergeRecords).not.toBeNull();
    expect(JSON.parse(vault.mergeRecords ?? '{}').contactsBase).toBeNull();
  });

  it('logs a failed write and does not throw', async () => {
    const session = await openSession();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(vault, 'saveBackupMergeRecords').mockRejectedValueOnce(new Error('disk full'));
    await expect(persistMergeRecords(session)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
