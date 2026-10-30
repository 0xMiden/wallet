/* eslint-disable import/first */

const _g = globalThis as any;
_g.__nckTest = {
  storage: {} as Record<string, any>
};

const mockGet = jest.fn(async (key: string) => {
  const out: Record<string, any> = {};
  if (key in _g.__nckTest.storage) out[key] = _g.__nckTest.storage[key];
  return out;
});
const mockSet = jest.fn(async (items: Record<string, any>) => {
  Object.assign(_g.__nckTest.storage, items);
});
const mockRemove = jest.fn(async (key: string) => {
  delete _g.__nckTest.storage[key];
});

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: {
        get: (...args: unknown[]) => mockGet(...(args as [string])),
        set: (...args: unknown[]) => mockSet(...(args as [Record<string, any>])),
        remove: (...args: unknown[]) => mockRemove(...(args as [string]))
      }
    }
  }
}));

import {
  MAX_SEEN_NOTE_IDS,
  clearPersistedSeenNoteIds,
  getPersistedSeenNoteIds,
  mergeAndPersistSeenNoteIds,
  persistSeenNoteIds
} from './note-checker-storage';

beforeEach(() => {
  for (const k of Object.keys(_g.__nckTest.storage)) delete _g.__nckTest.storage[k];
  jest.clearAllMocks();
});

describe('getPersistedSeenNoteIds', () => {
  it('returns an empty set when nothing is stored', async () => {
    const result = await getPersistedSeenNoteIds();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('hydrates a set from the persisted array', async () => {
    _g.__nckTest.storage['miden_seen_note_ids'] = ['n1', 'n2', 'n3'];
    const result = await getPersistedSeenNoteIds();
    expect(Array.from(result).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('keeps only the newest IDs when stored history exceeds the cap', async () => {
    const ids = Array.from({ length: MAX_SEEN_NOTE_IDS + 1 }, (_, index) => `seen-${index}`);
    _g.__nckTest.storage['miden_seen_note_ids'] = ids;

    const result = await getPersistedSeenNoteIds();

    expect(result.size).toBe(MAX_SEEN_NOTE_IDS);
    expect(result.has('seen-0')).toBe(false);
    expect(result.has('seen-1')).toBe(true);
    expect(result.has(`seen-${MAX_SEEN_NOTE_IDS}`)).toBe(true);
  });
});

describe('persistSeenNoteIds', () => {
  it('serializes the set to an array', async () => {
    await persistSeenNoteIds(new Set(['a', 'b']));
    expect(_g.__nckTest.storage['miden_seen_note_ids']).toEqual(['a', 'b']);
  });

  it('persists an empty set as an empty array', async () => {
    await persistSeenNoteIds(new Set());
    expect(_g.__nckTest.storage['miden_seen_note_ids']).toEqual([]);
  });

  it('recycles the oldest IDs before writing an oversized set', async () => {
    const ids = new Set(Array.from({ length: MAX_SEEN_NOTE_IDS + 1 }, (_, index) => `seen-${index}`));

    await persistSeenNoteIds(ids);

    const stored = _g.__nckTest.storage['miden_seen_note_ids'] as string[];
    expect(stored).toHaveLength(MAX_SEEN_NOTE_IDS);
    expect(stored[0]).toBe('seen-1');
    expect(stored.at(-1)).toBe(`seen-${MAX_SEEN_NOTE_IDS}`);
  });
});

describe('mergeAndPersistSeenNoteIds', () => {
  it('returns IDs that are new (not in the persisted set)', async () => {
    _g.__nckTest.storage['miden_seen_note_ids'] = ['old1', 'old2'];
    const newIds = await mergeAndPersistSeenNoteIds(['old1', 'new1', 'new2']);
    expect(newIds.sort()).toEqual(['new1', 'new2']);
  });

  it('prunes the persisted set to only the current IDs', async () => {
    _g.__nckTest.storage['miden_seen_note_ids'] = ['old1', 'old2', 'old3'];
    await mergeAndPersistSeenNoteIds(['old1']);
    expect(_g.__nckTest.storage['miden_seen_note_ids']).toEqual(['old1']);
  });

  it('returns empty when nothing new arrived', async () => {
    _g.__nckTest.storage['miden_seen_note_ids'] = ['n1'];
    const newIds = await mergeAndPersistSeenNoteIds(['n1']);
    expect(newIds).toEqual([]);
  });

  it('persists only the newest current IDs when the consumable set exceeds the cap', async () => {
    const ids = Array.from({ length: MAX_SEEN_NOTE_IDS + 1 }, (_, index) => `seen-${index}`);

    const newIds = await mergeAndPersistSeenNoteIds(ids);

    expect(newIds).toHaveLength(MAX_SEEN_NOTE_IDS + 1);
    expect(_g.__nckTest.storage['miden_seen_note_ids']).toHaveLength(MAX_SEEN_NOTE_IDS);
    expect((_g.__nckTest.storage['miden_seen_note_ids'] as string[])[0]).toBe('seen-1');
  });
});

describe('clearPersistedSeenNoteIds', () => {
  it('removes the storage key', async () => {
    _g.__nckTest.storage['miden_seen_note_ids'] = ['x'];
    await clearPersistedSeenNoteIds();
    expect(mockRemove).toHaveBeenCalledWith('miden_seen_note_ids');
    expect(_g.__nckTest.storage['miden_seen_note_ids']).toBeUndefined();
  });
});
