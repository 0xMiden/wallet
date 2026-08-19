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
// NoteFile.deserialize is tried FIRST (mirroring importNoteBytes). By default it
// throws — i.e. "these bytes are a bare Note, not a NoteFile" — so the Note.deserialize
// path is exercised by the existing tests. NoteFile-format tests override it.
const mockNoteFileDeserialize = jest.fn((_bytes: Uint8Array): any => {
  throw new Error('not a NoteFile');
});
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Note: { deserialize: (bytes: Uint8Array) => mockDeserialize(bytes) },
  NoteFile: { deserialize: (bytes: Uint8Array) => mockNoteFileDeserialize(bytes) }
}));

const mockB64ToU8 = jest.fn((s: string) => new Uint8Array([s.length]));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: (s: string) => mockB64ToU8(s)
}));

const QUARANTINE_KEY = 'simulation_quarantined_note_ids';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = 10_000_000_000;
/** Persisted entry shape: an id plus the wall-clock ms it was quarantined at. */
const entry = (id: string, at: number = NOW) => ({ id, at });

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Pin the clock so the TTL window is deterministic: entries default to `NOW`,
  // which is inside it. Tests that exercise expiry re-pin it themselves.
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  for (const k of Object.keys(STORE)) delete STORE[k];
  mockDeserialize.mockImplementation((bytes: Uint8Array) => ({
    id: () => ({ toString: () => `id:${Array.from(bytes).join('-')}` })
  }));
  mockNoteFileDeserialize.mockImplementation(() => {
    throw new Error('not a NoteFile');
  });
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

  it('derives the id from a NoteFile-serialized note via noteId() (bare-Note parse would throw)', () => {
    // A dApp can hand off notes as a serialized NoteFile (the preferred export
    // format); those must be quarantined too, not silently dropped.
    mockNoteFileDeserialize.mockImplementationOnce(() => ({
      noteId: () => ({ toString: () => 'nf-note-id' }),
      note: () => undefined
    }));
    // If this fell through to Note.deserialize it would produce 'id:...'; assert
    // it used the NoteFile id instead.
    expect(importedNoteIds(['x'])).toEqual(['nf-note-id']);
  });

  it('falls back to NoteFile.note().id() when noteId() is undefined', () => {
    mockNoteFileDeserialize.mockImplementationOnce(() => ({
      noteId: () => undefined,
      note: () => ({ id: () => ({ toString: () => 'nf-via-note' }) })
    }));
    expect(importedNoteIds(['x'])).toEqual(['nf-via-note']);
  });

  it('skips a note that is neither a resolvable NoteFile nor a bare Note', () => {
    // NoteFile parses but yields no id, and Note.deserialize also throws.
    mockNoteFileDeserialize.mockImplementationOnce(() => ({
      noteId: () => undefined,
      note: () => undefined
    }));
    mockDeserialize.mockImplementationOnce(() => {
      throw new Error('not a Note either');
    });
    expect(importedNoteIds(['x'])).toEqual([]);
  });

  it('skips an entry whose base64 fails to decode, without throwing', () => {
    mockB64ToU8.mockImplementationOnce(() => {
      throw new Error('bad base64');
    });
    expect(importedNoteIds(['bad', 'good'])).toEqual(['id:4']);
  });
});

describe('quarantineNoteIds', () => {
  it('adds ids to an empty quarantine set, stamped with the current time', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await quarantineNoteIds(['n1', 'n2']);
    expect(mockPutToStorage).toHaveBeenCalledWith(QUARANTINE_KEY, [
      { id: 'n1', at: 1_000 },
      { id: 'n2', at: 1_000 }
    ]);
  });

  it('dedups when an id is already quarantined, keeping the newest position and stamp', async () => {
    STORE[QUARANTINE_KEY] = [entry('n1', 500), entry('n2', 500)];
    jest.spyOn(Date, 'now').mockReturnValue(2_000);
    await quarantineNoteIds(['n2', 'n3']);
    expect(STORE[QUARANTINE_KEY]).toEqual([
      { id: 'n1', at: 500 },
      { id: 'n2', at: 2_000 },
      { id: 'n3', at: 2_000 }
    ]);
  });

  it('caps to the last MAX_QUARANTINED (500) entries', async () => {
    STORE[QUARANTINE_KEY] = Array.from({ length: 500 }, (_, i) => entry(`old-${i}`));
    await quarantineNoteIds(['new-1']);
    const stored: { id: string }[] = STORE[QUARANTINE_KEY];
    expect(stored).toHaveLength(500);
    expect(stored[0]!.id).toBe('old-1');
    expect(stored.at(-1)!.id).toBe('new-1');
  });

  it('is a no-op for an empty ids array (no storage write)', async () => {
    await quarantineNoteIds([]);
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('prunes entries older than the TTL as it writes', async () => {
    STORE[QUARANTINE_KEY] = [entry('stale', NOW - TTL_MS - 1), entry('fresh', NOW - 1_000)];
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    await quarantineNoteIds(['new']);
    expect((STORE[QUARANTINE_KEY] as { id: string }[]).map(e => e.id)).toEqual(['fresh', 'new']);
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
    STORE[QUARANTINE_KEY] = [entry('n1'), entry('n2'), entry('n3')];
    await releaseNoteIds(['n2']);
    expect((STORE[QUARANTINE_KEY] as { id: string }[]).map(e => e.id)).toEqual(['n1', 'n3']);
  });

  it('is a no-op for an empty ids array (no storage write)', async () => {
    await releaseNoteIds([]);
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('tolerates releasing an id that is not quarantined', async () => {
    STORE[QUARANTINE_KEY] = [entry('n1')];
    await releaseNoteIds(['does-not-exist']);
    expect((STORE[QUARANTINE_KEY] as { id: string }[]).map(e => e.id)).toEqual(['n1']);
  });

  it('never throws when storage read fails', async () => {
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage down'));
    await expect(releaseNoteIds(['n1'])).resolves.toBeUndefined();
  });

  it('never throws when storage write fails', async () => {
    STORE[QUARANTINE_KEY] = [entry('n1')];
    mockPutToStorage.mockRejectedValueOnce(new Error('storage down'));
    await expect(releaseNoteIds(['n1'])).resolves.toBeUndefined();
  });
});

describe('getQuarantinedNoteIds', () => {
  it('returns a Set built from the persisted entries', async () => {
    STORE[QUARANTINE_KEY] = [entry('n1'), entry('n2')];
    const set = await getQuarantinedNoteIds();
    expect(set).toEqual(new Set(['n1', 'n2']));
  });

  it('returns an empty Set when nothing is persisted', async () => {
    const set = await getQuarantinedNoteIds();
    expect(set).toEqual(new Set());
  });

  it('stops hiding an entry once it is older than the TTL', async () => {
    // A declined dApp simulation releases nothing, so without this bound the
    // note would be hidden from every claim path for the life of the wallet.
    STORE[QUARANTINE_KEY] = [entry('expired', NOW - TTL_MS - 1), entry('live', NOW - TTL_MS + 1_000)];
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    expect(await getQuarantinedNoteIds()).toEqual(new Set(['live']));
  });

  it('ignores legacy bare-string entries written before the TTL existed', async () => {
    STORE[QUARANTINE_KEY] = ['legacy-id', entry('current')];
    expect(await getQuarantinedNoteIds()).toEqual(new Set(['current']));
  });

  it('returns an empty Set for a non-array persisted value', async () => {
    STORE[QUARANTINE_KEY] = { not: 'an array' };
    expect(await getQuarantinedNoteIds()).toEqual(new Set());
  });

  it('returns an empty Set (never throws) when storage read fails', async () => {
    mockFetchFromStorage.mockRejectedValueOnce(new Error('storage down'));
    const set = await getQuarantinedNoteIds();
    expect(set).toEqual(new Set());
  });
});
