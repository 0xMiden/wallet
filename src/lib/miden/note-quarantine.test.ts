/**
 * Behavior tests for the simulation-note quarantine (lib/miden/note-quarantine.ts).
 */
import { getQuarantinedNoteIds, importedNoteIds, quarantineNoteIds, releaseNoteIds } from 'lib/miden/note-quarantine';

const STORE: Record<string, any> = {};

const mockFetchFromStorage = jest.fn(async (key: string) => (key in STORE ? STORE[key] : null));
const mockPutToStorage = jest.fn(async (key: string, value: any) => {
  STORE[key] = value;
});

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: (key: string) => mockFetchFromStorage(key),
  putToStorage: (key: string, value: any) => mockPutToStorage(key, value)
}));

const mockDeserialize = jest.fn((bytes: Uint8Array) => ({
  id: () => ({ toString: () => `id:${Array.from(bytes).join('-')}` })
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Note: { deserialize: (bytes: Uint8Array) => mockDeserialize(bytes) }
}));

jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length]))
}));

const QUARANTINE_KEY = 'simulation_quarantined_note_ids';

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(STORE)) delete STORE[k];
  mockDeserialize.mockImplementation((bytes: Uint8Array) => ({
    id: () => ({ toString: () => `id:${Array.from(bytes).join('-')}` })
  }));
});

describe('importedNoteIds', () => {
  it('derives ids from base64 note bytes via Note.deserialize(...).id().toString()', () => {
    const ids = importedNoteIds(['aa', 'bbb']);
    expect(ids).toEqual(['id:2', 'id:3']);
  });

  it('returns [] for an undefined importNotes list', () => {
    expect(importedNoteIds(undefined)).toEqual([]);
  });

  it('returns [] for an empty importNotes list', () => {
    expect(importedNoteIds([])).toEqual([]);
  });

  it('tolerates a note that fails to deserialize by skipping it', () => {
    mockDeserialize.mockImplementationOnce(() => {
      throw new Error('bad note bytes');
    });
    const ids = importedNoteIds(['bad', 'good']);
    expect(ids).toEqual(['id:4']);
  });
});

describe('quarantineNoteIds', () => {
  it('adds ids to an empty quarantine set', async () => {
    await quarantineNoteIds(['n1', 'n2']);
    expect(mockPutToStorage).toHaveBeenCalledWith(QUARANTINE_KEY, ['n1', 'n2']);
  });

  it('dedups when an id is already quarantined, keeping the newest position', async () => {
    STORE[QUARANTINE_KEY] = ['n1', 'n2'];
    await quarantineNoteIds(['n2', 'n3']);
    expect(STORE[QUARANTINE_KEY]).toEqual(['n1', 'n2', 'n3']);
  });

  it('caps to the last MAX_QUARANTINED (500) entries', async () => {
    STORE[QUARANTINE_KEY] = Array.from({ length: 500 }, (_, i) => `old-${i}`);
    await quarantineNoteIds(['new-1']);
    const stored: string[] = STORE[QUARANTINE_KEY];
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe('old-1');
    expect(stored.at(-1)).toBe('new-1');
  });

  it('is a no-op for an empty ids array (no storage write)', async () => {
    await quarantineNoteIds([]);
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('never throws when storage read fails', async () => {
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage down'));
    await expect(quarantineNoteIds(['n1'])).resolves.toBeUndefined();
  });

  it('never throws when storage write fails', async () => {
    mockPutToStorage.mockRejectedValueOnce(new Error('storage down'));
    await expect(quarantineNoteIds(['n1'])).resolves.toBeUndefined();
  });
});

describe('releaseNoteIds', () => {
  it('removes ids from the quarantine set', async () => {
    STORE[QUARANTINE_KEY] = ['n1', 'n2', 'n3'];
    await releaseNoteIds(['n2']);
    expect(STORE[QUARANTINE_KEY]).toEqual(['n1', 'n3']);
  });

  it('is a no-op for an empty ids array (no storage write)', async () => {
    await releaseNoteIds([]);
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('tolerates releasing an id that is not quarantined', async () => {
    STORE[QUARANTINE_KEY] = ['n1'];
    await releaseNoteIds(['does-not-exist']);
    expect(STORE[QUARANTINE_KEY]).toEqual(['n1']);
  });

  it('never throws when storage read fails', async () => {
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage down'));
    await expect(releaseNoteIds(['n1'])).resolves.toBeUndefined();
  });

  it('never throws when storage write fails', async () => {
    STORE[QUARANTINE_KEY] = ['n1'];
    mockPutToStorage.mockRejectedValueOnce(new Error('storage down'));
    await expect(releaseNoteIds(['n1'])).resolves.toBeUndefined();
  });
});

describe('getQuarantinedNoteIds', () => {
  it('returns a Set built from the persisted array', async () => {
    STORE[QUARANTINE_KEY] = ['n1', 'n2'];
    const set = await getQuarantinedNoteIds();
    expect(set).toEqual(new Set(['n1', 'n2']));
  });

  it('returns an empty Set when nothing is persisted', async () => {
    const set = await getQuarantinedNoteIds();
    expect(set).toEqual(new Set());
  });

  it('returns an empty Set (never throws) when storage read fails', async () => {
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage down'));
    const set = await getQuarantinedNoteIds();
    expect(set).toEqual(new Set());
  });
});
