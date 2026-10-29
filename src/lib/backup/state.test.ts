import {
  type BackupState,
  adoptKeyGeneration,
  backupStorageEpoch,
  emptyBackupState,
  emptyMergeRecords,
  getBackupDeviceId,
  loadBackupState,
  onBackupStorageCleared,
  persistBackupState,
  readBackupMergeRecords,
  readBackupState,
  removeBackupState
} from './state';
import { MemoryStorage, setActiveStorage } from './testing/backup-harness';

jest.mock('lib/platform/storage-adapter', () => {
  const harness = jest.requireActual<typeof import('./testing/backup-harness')>('./testing/backup-harness');
  return { getStorageProvider: () => harness.getActiveStorage() };
});

const STATE_KEY = 'backup_state_v1';
const DEVICE_KEY = 'backup_device_id_v1';
let storage: MemoryStorage;

/** A state with a record in every part, as a session leaves it. */
function filledState(publicKey = 'pk'): BackupState {
  const state = emptyBackupState(publicKey);
  state.salt = 'aa'.repeat(16);
  state.profileEtag = 'profile-etag';
  state.features.accounts = {
    etag: 'accounts-etag',
    cursor: 1000,
    entries: { ['a'.repeat(64)]: { revision: 2, updatedAt: 1000, digest: 'd1' } }
  };
  state.features.history.cursor = 0;
  state.history = {
    chunks: [{ n: 0, ids: ['tx-1', 'tx-2'] }],
    assigned: { 'tx-1': { n: 0, digest: 'd2' } },
    dirty: [0]
  };
  return state;
}

beforeEach(() => {
  storage = new MemoryStorage();
  setActiveStorage(storage);
  onBackupStorageCleared();
});

afterEach(() => jest.restoreAllMocks());

describe('adoptKeyGeneration', () => {
  it('keeps every record for the same salt', () => {
    const state = filledState();
    expect(adoptKeyGeneration(state, 'aa'.repeat(16))).toBe(false);
    expect(state).toEqual(filledState());
  });

  it('clears every server record for another salt', () => {
    const state = filledState();
    expect(adoptKeyGeneration(state, 'bb'.repeat(16))).toBe(true);
    expect(state).toEqual({ ...emptyBackupState('pk'), salt: 'bb'.repeat(16) });
  });
});

describe('readBackupState', () => {
  it('reads back a stored state', () => {
    const state = filledState();
    expect(readBackupState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    ['another version', raw => (raw.v = 2)],
    ['no public key', raw => delete raw.publicKey],
    ['a salt that is not a string', raw => (raw.salt = 5)],
    ['no features', raw => delete raw.features],
    ['no history', raw => delete raw.history]
  ])('refuses %s', (_name, change) => {
    const raw: Record<string, unknown> = JSON.parse(JSON.stringify(filledState()));
    change(raw);
    expect(readBackupState(raw)).toBeNull();
  });

  it.each<[string, (state: BackupState) => unknown]>([
    [
      'a negative cursor',
      state => ({ ...state, features: { ...state.features, contacts: { etag: null, cursor: -1, entries: {} } } })
    ],
    [
      'an entry mark without a digest',
      state => ({
        ...state,
        features: {
          ...state.features,
          contacts: { etag: null, cursor: null, entries: { k: { revision: 1, updatedAt: 1 } } }
        }
      })
    ],
    [
      'a chunk id that is not a string',
      state => ({ ...state, history: { ...state.history, chunks: [{ n: 0, ids: [1] }] } })
    ],
    ['a dirty chunk below zero', state => ({ ...state, history: { ...state.history, dirty: [-1] } })],
    [
      'an assignment without a digest',
      state => ({ ...state, history: { ...state.history, assigned: { tx: { n: 0 } } } })
    ]
  ])('refuses %s', (_name, change) => {
    expect(readBackupState(change(filledState()))).toBeNull();
  });
});

describe('readBackupMergeRecords', () => {
  it('reads back stored records', () => {
    const records = { ...emptyMergeRecords('pk'), accountNames: { 'guardian:0': { name: 'Main', nlu: 5 } } };
    expect(readBackupMergeRecords(JSON.parse(JSON.stringify(records)))).toEqual(records);
  });

  it.each([
    ['another version', { ...emptyMergeRecords('pk'), v: 2 }],
    ['a negative nlu', { ...emptyMergeRecords('pk'), accountNames: { k: { name: 'A', nlu: -1 } } }],
    ['a contacts base that is not a string', { ...emptyMergeRecords('pk'), contactsBase: 3 }],
    ['nothing', undefined]
  ])('refuses %s', (_name, value) => {
    expect(readBackupMergeRecords(value)).toBeNull();
  });
});

describe('loadBackupState', () => {
  it('gives an empty state when nothing is stored', async () => {
    await expect(loadBackupState('pk')).resolves.toEqual(emptyBackupState('pk'));
  });

  it('gives the stored state of the same key', async () => {
    await storage.set({ [STATE_KEY]: filledState('pk') });
    await expect(loadBackupState('pk')).resolves.toEqual(filledState('pk'));
  });

  it('discards the state of another key and an unreadable state', async () => {
    await storage.set({ [STATE_KEY]: filledState('other') });
    await expect(loadBackupState('pk')).resolves.toEqual(emptyBackupState('pk'));
    await storage.set({ [STATE_KEY]: { v: 1 } });
    await expect(loadBackupState('pk')).resolves.toEqual(emptyBackupState('pk'));
  });

  it('starts from empty and logs when the storage read fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(storage, 'get').mockRejectedValueOnce(new Error('io'));
    await expect(loadBackupState('pk')).resolves.toEqual(emptyBackupState('pk'));
    expect(warn).toHaveBeenCalled();
  });
});

describe('persistBackupState', () => {
  it('writes the snapshot of the call, in call order', async () => {
    const state = filledState();
    const first = persistBackupState(state);
    state.profileEtag = 'second';
    const second = persistBackupState(state);
    state.profileEtag = 'not written';
    await Promise.all([first, second]);
    expect(readBackupState(storage.read(STATE_KEY))?.profileEtag).toBe('second');
  });

  it('logs a failed write, and the next write saves the full state', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(storage, 'set').mockRejectedValueOnce(new Error('quota'));
    const state = filledState();
    await expect(persistBackupState(state)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(storage.has(STATE_KEY)).toBe(false);

    await persistBackupState(state);
    expect(readBackupState(storage.read(STATE_KEY))).toEqual(state);
  });

  it('removes the state and keeps the device id', async () => {
    const deviceId = await getBackupDeviceId();
    await persistBackupState(filledState());
    await removeBackupState();
    expect(storage.has(STATE_KEY)).toBe(false);
    expect(storage.read(DEVICE_KEY)).toBe(deviceId);
  });

  it('logs a failed removal', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('io'));
    await expect(removeBackupState()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('device id', () => {
  it('makes 16 random bytes in hex once and keeps them', async () => {
    const deviceId = await getBackupDeviceId();
    expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.read(DEVICE_KEY)).toBe(deviceId);
    await expect(getBackupDeviceId()).resolves.toBe(deviceId);

    // A new realm reads the stored id.
    onBackupStorageCleared();
    await expect(getBackupDeviceId()).resolves.toBe(deviceId);
  });

  it('replaces a stored value that is not a device id', async () => {
    await storage.set({ [DEVICE_KEY]: 'not-hex' });
    const deviceId = await getBackupDeviceId();
    expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.read(DEVICE_KEY)).toBe(deviceId);
  });

  it('gives a new id after a storage wipe, and counts the wipe', async () => {
    const before = await getBackupDeviceId();
    const epoch = backupStorageEpoch();
    const wiped = new MemoryStorage();
    setActiveStorage(wiped);
    onBackupStorageCleared();
    expect(backupStorageEpoch()).toBe(epoch + 1);
    const after = await getBackupDeviceId();
    expect(after).not.toBe(before);
    expect(wiped.read(DEVICE_KEY)).toBe(after);
  });

  it('reads again after a failed read', async () => {
    jest.spyOn(storage, 'get').mockRejectedValueOnce(new Error('io'));
    await expect(getBackupDeviceId()).rejects.toThrow('io');
    await expect(getBackupDeviceId()).resolves.toMatch(/^[0-9a-f]{32}$/);
  });
});
