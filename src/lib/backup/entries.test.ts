import { DEFAULT_BLOB_CAP, HISTORY_BLOB_CAP, encryptEntry, hashedEntryKey, plaintextDigest } from './crypto';
import { type IncomingEntry, blobCapOf, hashedKeyOf, readFeature, uploadEntries } from './entries';
import { type BackupSession, BackupSessionClosedError, clearBackupSession, getBackupSession } from './session';
import { readBackupState } from './state';
import {
  type FakeFeature,
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

const savedDefine = process.env.MIDEN_WALLET_API_URL;
let removeImportShim: () => void;
let server: FakeWalletApi;
let restoreFetch: () => void;
let session: BackupSession;

beforeAll(() => {
  delete process.env.MIDEN_WALLET_API_URL;
  removeImportShim = installCopyingImportKey();
});

afterAll(() => {
  if (savedDefine !== undefined) process.env.MIDEN_WALLET_API_URL = savedDefine;
  removeImportShim();
});

beforeEach(async () => {
  clearBackupSession();
  server = new FakeWalletApi();
  restoreFetch = installFakeFetch(server);
  setActiveVault(new FakeVault(PHRASE_A));
  setActiveStorage(new MemoryStorage());
  const opened = await getBackupSession();
  if (!('session' in opened)) throw new Error(`No session: ${opened.unavailable}`);
  session = opened.session;
});

afterEach(() => {
  clearBackupSession();
  restoreFetch();
  jest.restoreAllMocks();
});

/** Make this device forget what it read of a feature, as a device that never read it. */
function forget(feature: FakeFeature): void {
  session.state.features[feature] = { etag: null, cursor: null, entries: {} };
}

function entryKeys(count: number): { entryKey: string; plaintext: string }[] {
  return Array.from({ length: count }, (_value, index) => ({ entryKey: `key-${index}`, plaintext: `value-${index}` }));
}

function featureReads(mark: number, feature: FakeFeature) {
  return server
    .requestsSince(mark)
    .filter(request => request.method === 'GET' && request.path === `/v1/storage/${feature}`);
}

/** A read that records what it was given. */
function recordingApply(): { apply: (entries: IncomingEntry[]) => Promise<void>; calls: IncomingEntry[][] } {
  const calls: IncomingEntry[][] = [];
  return {
    calls,
    apply: async entries => {
      calls.push(entries);
    }
  };
}

describe('readFeature', () => {
  it('applies new entries, then moves the ETag, the cursor and the records, and persists them', async () => {
    await uploadEntries(session, 'accounts', entryKeys(3));
    forget('accounts');
    const recorder = recordingApply();

    await expect(readFeature(session, 'accounts', { since: false, apply: recorder.apply })).resolves.toBe('applied');

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.map(entry => entry.plaintext).sort()).toEqual(['value-0', 'value-1', 'value-2']);
    const featureState = session.state.features.accounts;
    expect(featureState.etag).toBe(server.featureEtagOf(session.publicKey, 'accounts'));
    const onServer = server.entriesOf(session.publicKey, 'accounts');
    expect(featureState.cursor).toBe(Math.max(...onServer.map(entry => entry.updatedAt)));
    for (const entry of onServer) {
      expect(featureState.entries[entry.hashedKey]?.revision).toBe(entry.revision);
    }
    expect(featureState.entries[hashedKeyOf(session, 'key-0')]?.digest).toBe(plaintextDigest('value-0'));
    // Entries go out under the hashed key, never the entry key.
    expect(onServer.map(entry => entry.hashedKey)).toContain(hashedEntryKey('key-0', session.storageKey));
    const stored = readBackupState(getActiveStorage().read('backup_state_v1'));
    expect(stored?.features.accounts.etag).toBe(featureState.etag);
  });

  it('reads nothing on a 304', async () => {
    await uploadEntries(session, 'accounts', entryKeys(2));
    forget('accounts');
    await readFeature(session, 'accounts', { since: false, apply: async () => {} });
    const etag = session.state.features.accounts.etag;
    const mark = server.requests.length;
    const recorder = recordingApply();

    await expect(readFeature(session, 'accounts', { since: false, apply: recorder.apply })).resolves.toBe(
      'not-modified'
    );
    expect(recorder.calls).toHaveLength(0);
    expect(server.requestsSince(mark).map(request => [request.path, request.ifNoneMatch, request.status])).toEqual([
      ['/v1/storage/accounts', etag, 304]
    ]);
  });

  it('applies only an entry whose revision is higher than the copy this device holds', async () => {
    await uploadEntries(session, 'accounts', entryKeys(3));
    forget('accounts');
    await readFeature(session, 'accounts', { since: false, apply: async () => {} });
    const target = hashedKeyOf(session, 'key-1');
    server.rewriteEntry(session.publicKey, 'accounts', target);
    const recorder = recordingApply();

    await expect(readFeature(session, 'accounts', { since: false, apply: recorder.apply })).resolves.toBe('applied');
    expect(recorder.calls[0]?.map(entry => [entry.hashedKey, entry.revision])).toEqual([[target, 2]]);
    expect(session.state.features.accounts.entries[target]?.revision).toBe(2);
  });

  it('gives no-new-entries for a 200 that holds only copies this device has', async () => {
    await uploadEntries(session, 'accounts', entryKeys(2));
    // The upload recorded the revisions; the ETag is still unknown, so the read is a 200.
    const recorder = recordingApply();
    await expect(readFeature(session, 'accounts', { since: false, apply: recorder.apply })).resolves.toBe(
      'no-new-entries'
    );
    expect(recorder.calls).toEqual([[]]);
  });

  it('reads every page, sends If-None-Match only on the first one and keeps its ETag', async () => {
    server.pageSize = 2;
    await uploadEntries(session, 'accounts', entryKeys(5));
    forget('accounts');
    let mark = server.requests.length;
    const first = recordingApply();
    await readFeature(session, 'accounts', { since: false, apply: first.apply });
    expect(first.calls[0]).toHaveLength(5);
    const firstReads = featureReads(mark, 'accounts');
    const keys = server.entriesOf(session.publicKey, 'accounts').map(entry => entry.hashedKey);
    // Pages follow the hashed-key order: each one starts after the last key of the page before.
    expect(firstReads.map(request => request.query.after ?? null)).toEqual([null, keys[1], keys[3]]);
    expect(firstReads.every(request => request.ifNoneMatch === null)).toBe(true);

    // A peer writes twice: once before the read, and once between its first and second page, to an entry of the
    // first page. The read does not see the second write.
    const [late, , , , early] = keys;
    if (early === undefined || late === undefined) throw new Error('Five entries expected');
    server.rewriteEntry(session.publicKey, 'accounts', early);
    let wrote = false;
    server.onRequest = request => {
      if (!wrote && request.path === '/v1/storage/accounts' && request.query.after !== undefined) {
        wrote = true;
        server.rewriteEntry(session.publicKey, 'accounts', late);
      }
    };
    const knownEtag = session.state.features.accounts.etag;
    mark = server.requests.length;
    await readFeature(session, 'accounts', { since: false, apply: async () => {} });
    server.onRequest = null;

    const secondReads = featureReads(mark, 'accounts');
    expect(secondReads.map(request => request.ifNoneMatch)).toEqual([knownEtag, null, null]);
    const firstPageEtag = secondReads[0]?.etag;
    expect(session.state.features.accounts.etag).toBe(firstPageEtag);
    expect(secondReads[2]?.etag).toBe(server.featureEtagOf(session.publicKey, 'accounts'));
    expect(firstPageEtag).not.toBe(server.featureEtagOf(session.publicKey, 'accounts'));

    // The first page's ETag does not match the server, so the next read is a 200 that brings the late write.
    const third = recordingApply();
    await expect(readFeature(session, 'accounts', { since: false, apply: third.apply })).resolves.toBe('applied');
    expect(third.calls[0]?.map(entry => entry.hashedKey)).toContain(late);
  });

  it('refuses a feature that does not end within 16 pages', async () => {
    server.pageSize = 1;
    await uploadEntries(session, 'accounts', entryKeys(17));
    forget('accounts');
    const recorder = recordingApply();
    await expect(readFeature(session, 'accounts', { since: false, apply: recorder.apply })).rejects.toThrow(
      'The accounts read did not end within 16 pages'
    );
    expect(recorder.calls).toHaveLength(0);
    expect(session.state.features.accounts.etag).toBeNull();
  });

  it('reads 16 pages in full', async () => {
    server.pageSize = 1;
    await uploadEntries(session, 'accounts', entryKeys(16));
    forget('accounts');
    await expect(readFeature(session, 'accounts', { since: false, apply: async () => {} })).resolves.toBe('applied');
  });

  it('asks only for entries since the cursor when `since` is set', async () => {
    await uploadEntries(session, 'history', entryKeys(1));
    forget('history');
    await readFeature(session, 'history', { since: true, apply: async () => {} });
    const cursor = session.state.features.history.cursor;
    expect(cursor).not.toBeNull();

    await uploadEntries(session, 'history', [{ entryKey: 'key-new', plaintext: 'new' }]);
    const mark = server.requests.length;
    const recorder = recordingApply();
    await readFeature(session, 'history', { since: true, apply: recorder.apply });
    expect(featureReads(mark, 'history')[0]?.query.since).toBe(String(cursor));
    // The boundary entry comes again and is skipped by its revision; the new one was recorded by its upload.
    expect(recorder.calls).toEqual([[]]);

    const plain = server.requests.length;
    await readFeature(session, 'history', { since: false, apply: async () => {} });
    expect(featureReads(plain, 'history')[0]?.query.since).toBeUndefined();
  });

  it('never applies the hashed keys this device writes itself, but moves the cursor past them', async () => {
    await uploadEntries(session, 'history', entryKeys(2));
    forget('history');
    const own = hashedKeyOf(session, 'key-0');
    const recorder = recordingApply();
    await readFeature(session, 'history', { since: true, ownHashedKeys: new Set([own]), apply: recorder.apply });
    expect(recorder.calls[0]?.map(entry => entry.hashedKey)).toEqual([hashedKeyOf(session, 'key-1')]);
    expect(session.state.features.history.entries[own]).toBeUndefined();
    expect(session.state.features.history.cursor).toBe(
      Math.max(...server.entriesOf(session.publicKey, 'history').map(entry => entry.updatedAt))
    );
  });

  it('keeps the ETag, the cursor and the records when the apply fails', async () => {
    await uploadEntries(session, 'accounts', entryKeys(2));
    forget('accounts');
    await expect(
      readFeature(session, 'accounts', {
        since: false,
        apply: async () => {
          throw new Error('apply failed');
        }
      })
    ).rejects.toThrow('apply failed');
    expect(session.state.features.accounts).toEqual({ etag: null, cursor: null, entries: {} });
  });

  it('skips and logs an entry this key cannot open, and still moves the cursor', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await uploadEntries(session, 'contacts', [{ entryKey: 'contacts', plaintext: '[]' }]);
    const foreignKey = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(4), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt'
    ]);
    server.insertEntry(
      session.publicKey,
      'contacts',
      'c'.repeat(64),
      await encryptEntry(foreignKey, 'foreign', session.kdfParams)
    );
    server.insertEntry(
      session.publicKey,
      'contacts',
      'd'.repeat(64),
      await encryptEntry(session.encKey, 'other parameters', session.kdfParams + 16)
    );
    forget('contacts');
    const recorder = recordingApply();

    await readFeature(session, 'contacts', { since: false, apply: recorder.apply });
    expect(recorder.calls[0]?.map(entry => entry.plaintext)).toEqual(['[]']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(session.state.features.contacts.cursor).toBe(
      Math.max(...server.entriesOf(session.publicKey, 'contacts').map(entry => entry.updatedAt))
    );
  });

  it('applies nothing for a session that closed while the read waited', async () => {
    await uploadEntries(session, 'accounts', entryKeys(1));
    forget('accounts');
    server.onRequest = request => {
      if (request.path === '/v1/storage/accounts') clearBackupSession();
    };
    const recorder = recordingApply();
    await expect(readFeature(session, 'accounts', { since: false, apply: recorder.apply })).rejects.toBeInstanceOf(
      BackupSessionClosedError
    );
    expect(recorder.calls).toHaveLength(0);
    expect(session.state.features.accounts.etag).toBeNull();
  });
});

describe('uploadEntries', () => {
  it('uploads changed entries only, and records the acknowledged revisions', async () => {
    await expect(uploadEntries(session, 'accounts', entryKeys(2))).resolves.toEqual(['key-0', 'key-1']);
    const mark = server.requests.length;
    await expect(uploadEntries(session, 'accounts', entryKeys(2))).resolves.toEqual([]);
    expect(server.requestsSince(mark)).toHaveLength(0);

    const changed = [{ entryKey: 'key-0', plaintext: 'renamed' }, ...entryKeys(2).slice(1)];
    await expect(uploadEntries(session, 'accounts', changed)).resolves.toEqual(['key-0']);
    const mark0 = session.state.features.accounts.entries[hashedKeyOf(session, 'key-0')];
    expect(mark0).toMatchObject({ revision: 2, digest: plaintextDigest('renamed') });
  });

  it('never moves the ETag or the cursor', async () => {
    await uploadEntries(session, 'accounts', entryKeys(1));
    expect(session.state.features.accounts.etag).toBeNull();
    expect(session.state.features.accounts.cursor).toBeNull();
  });

  it('skips and logs an entry over the blob cap of its feature', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'x'.repeat(DEFAULT_BLOB_CAP);
    await expect(uploadEntries(session, 'contacts', [{ entryKey: 'contacts', plaintext: big }])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    // The same plaintext fits the history cap.
    await expect(uploadEntries(session, 'history', [{ entryKey: 'chunk', plaintext: big }])).resolves.toEqual([
      'chunk'
    ]);
  });

  it('splits at 100 entries per batch', async () => {
    const mark = server.requests.length;
    await expect(uploadEntries(session, 'accounts', entryKeys(150))).resolves.toHaveLength(150);
    const puts = server.requestsSince(mark).filter(request => request.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(server.entriesOf(session.publicKey, 'accounts')).toHaveLength(150);
  });

  it('splits at the request body budget', async () => {
    const mark = server.requests.length;
    const chunks = Array.from({ length: 30 }, (_value, index) => ({
      entryKey: `history:dev:${index}`,
      plaintext: 'y'.repeat(18000)
    }));
    await expect(uploadEntries(session, 'history', chunks)).resolves.toHaveLength(30);
    const puts = server.requestsSince(mark).filter(request => request.method === 'PUT');
    expect(puts.length).toBeGreaterThan(1);
    expect(puts.every(request => request.status === 200)).toBe(true);
  });

  it('refuses a closed session before it sends anything', async () => {
    clearBackupSession();
    const mark = server.requests.length;
    await expect(uploadEntries(session, 'accounts', entryKeys(1))).rejects.toBeInstanceOf(BackupSessionClosedError);
    expect(server.requestsSince(mark)).toHaveLength(0);
  });

  it('runs uploads one at a time, so a later upload sees the records of an earlier one', async () => {
    const [first, second] = await Promise.all([
      uploadEntries(session, 'accounts', entryKeys(1)),
      uploadEntries(session, 'accounts', entryKeys(1))
    ]);
    expect(first).toEqual(['key-0']);
    expect(second).toEqual([]);
  });
});

describe('blob caps and hashed keys', () => {
  it('caps history at 25600 bytes and the other features at 4096', () => {
    expect(blobCapOf('history')).toBe(HISTORY_BLOB_CAP);
    expect(blobCapOf('accounts')).toBe(DEFAULT_BLOB_CAP);
    expect(blobCapOf('contacts')).toBe(DEFAULT_BLOB_CAP);
  });

  it("hashes an entry key with the session's storage key", () => {
    expect(hashedKeyOf(session, 'contacts')).toBe(hashedEntryKey('contacts', session.storageKey));
  });
});
