/* eslint-disable import/first */
/**
 * Tests for the parked dApp session persistence layer.
 *
 * Critical regression guard: the S9 fix from the review round 1 capped
 * the persisted list at MAX_PERSISTED_SESSIONS (= 8) and evicts the
 * oldest entries on overflow, fire-and-forgetting a snapshot cleanup
 * for each evicted id. This file locks both behaviors.
 *
 * jest.mock calls are hoisted above imports at runtime — the
 * `import/first` ESLint rule doesn't know that, hence the disable.
 */

const store: Record<string, string> = {};
const mockGet = jest.fn(async ({ key }: { key: string }) => ({ value: store[key] ?? null }));
const mockSet = jest.fn(async ({ key, value }: { key: string; value: string }) => {
  store[key] = value;
});
const mockRemove = jest.fn(async ({ key }: { key: string }) => {
  delete store[key];
});

jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (...args: unknown[]) => mockGet(...(args as [{ key: string }])),
    set: (...args: unknown[]) => mockSet(...(args as [{ key: string; value: string }])),
    remove: (...args: unknown[]) => mockRemove(...(args as [{ key: string }]))
  }
}));

const mockRemoveSnapshot = jest.fn(async (_id: string) => undefined);
jest.mock('./snapshot-persistence', () => ({
  removeSnapshotFromDisk: (...args: unknown[]) => mockRemoveSnapshot(...(args as [string]))
}));

import type { DappSession } from './dapp-session';
import {
  MAX_PERSISTED_SESSIONS,
  clearAllPersistedSessions,
  fromPersisted,
  loadPersistedSessions,
  removePersistedSession,
  savePersistedSessions,
  toPersisted,
  upsertPersistedSession,
  type PersistedSession
} from './session-persistence';

const STORAGE_KEY = 'miden.dapp.persistedSessions.v1';

function makePersisted(id: string, parkedAt = 100): PersistedSession {
  return {
    id,
    url: `https://${id}.test/`,
    origin: `https://${id}.test`,
    title: id,
    favicon: null,
    openedAt: 1,
    parkedAt
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mockGet.mockClear();
  mockSet.mockClear();
  mockRemove.mockClear();
  mockRemoveSnapshot.mockClear();
});

describe('loadPersistedSessions', () => {
  it('returns [] when nothing is stored', async () => {
    expect(await loadPersistedSessions()).toEqual([]);
  });

  it('returns [] and logs a warn when the stored value is not an array', async () => {
    store[STORAGE_KEY] = JSON.stringify({ not: 'array' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadPersistedSessions()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clears the corrupt store when the stored value is not an array', async () => {
    store[STORAGE_KEY] = JSON.stringify({ not: 'array' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await loadPersistedSessions();
    expect(mockRemove).toHaveBeenCalledWith({ key: STORAGE_KEY });
  });

  it('returns [] when the stored value is invalid JSON', async () => {
    store[STORAGE_KEY] = '{{{ broken';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadPersistedSessions()).toEqual([]);
  });

  it('filters out malformed entries', async () => {
    store[STORAGE_KEY] = JSON.stringify([
      makePersisted('ok1'),
      { id: 42, url: 'x' }, // malformed
      makePersisted('ok2'),
      null, // malformed
      { notARealEntry: true } // malformed
    ]);
    const result = await loadPersistedSessions();
    expect(result.map(r => r.id)).toEqual(['ok1', 'ok2']);
  });
});

describe('savePersistedSessions', () => {
  it('writes a stringified array to Preferences', async () => {
    await savePersistedSessions([makePersisted('a'), makePersisted('b')]);
    expect(mockSet).toHaveBeenCalledWith({
      key: STORAGE_KEY,
      value: expect.any(String)
    });
    const stored = JSON.parse(store[STORAGE_KEY]);
    expect(stored.map((s: PersistedSession) => s.id)).toEqual(['a', 'b']);
  });
});

describe('upsertPersistedSession', () => {
  it('adds a new entry when the store is empty', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    const loaded = await loadPersistedSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('a');
  });

  it('replaces an entry with the same id', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    await upsertPersistedSession({ ...makePersisted('a', 200), title: 'updated' });
    const loaded = await loadPersistedSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe('updated');
    expect(loaded[0].parkedAt).toBe(200);
  });

  it('preserves other entries when upserting', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    await upsertPersistedSession(makePersisted('b', 200));
    await upsertPersistedSession({ ...makePersisted('a', 300), title: 'updated' });
    const loaded = await loadPersistedSessions();
    expect(loaded.map(s => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('S9 regression: LRU eviction at MAX_PERSISTED_SESSIONS', () => {
  it('caps the list at MAX_PERSISTED_SESSIONS even as new entries are added', async () => {
    for (let i = 0; i < MAX_PERSISTED_SESSIONS + 5; i++) {
      await upsertPersistedSession(makePersisted(`s${i}`, i * 10));
    }
    const loaded = await loadPersistedSessions();
    expect(loaded).toHaveLength(MAX_PERSISTED_SESSIONS);
  });

  it('evicts the oldest entries by parkedAt when overflowing', async () => {
    // Insert 10 sessions with parkedAt = 100 * index so s0 is oldest.
    for (let i = 0; i < 10; i++) {
      await upsertPersistedSession(makePersisted(`s${i}`, i * 100));
    }
    const loaded = await loadPersistedSessions();
    const ids = loaded.map(s => s.id);
    // The 8 most-recent (s2..s9) should survive.
    expect(ids).toContain('s9');
    expect(ids).toContain('s2');
    expect(ids).not.toContain('s0');
    expect(ids).not.toContain('s1');
  });

  it('calls removeSnapshotFromDisk for every evicted entry', async () => {
    for (let i = 0; i < 10; i++) {
      await upsertPersistedSession(makePersisted(`s${i}`, i * 100));
    }
    // Allow any fire-and-forget work to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRemoveSnapshot).toHaveBeenCalledWith('s0');
    expect(mockRemoveSnapshot).toHaveBeenCalledWith('s1');
    expect(mockRemoveSnapshot).not.toHaveBeenCalledWith('s9');
  });

  it('does not call removeSnapshotFromDisk when under the cap', async () => {
    for (let i = 0; i < MAX_PERSISTED_SESSIONS; i++) {
      await upsertPersistedSession(makePersisted(`s${i}`, i * 100));
    }
    await Promise.resolve();
    expect(mockRemoveSnapshot).not.toHaveBeenCalled();
  });
});

describe('removePersistedSession', () => {
  it('removes an entry by id', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    await upsertPersistedSession(makePersisted('b', 200));
    await removePersistedSession('a');
    const loaded = await loadPersistedSessions();
    expect(loaded.map(s => s.id)).toEqual(['b']);
  });

  it('does not rewrite the store when no entry matches (avoids extra writes)', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    mockSet.mockClear();
    await removePersistedSession('nonexistent');
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('clearAllPersistedSessions', () => {
  it('removes the storage key entirely', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    await clearAllPersistedSessions();
    expect(mockRemove).toHaveBeenCalledWith({ key: STORAGE_KEY });
  });
});

describe('toPersisted / fromPersisted round-trip', () => {
  it('converts a DappSession → PersistedSession → DappSession keeping durable fields', () => {
    const session: DappSession = {
      id: 'dapp-abc',
      url: 'https://miden.xyz/',
      origin: 'https://miden.xyz',
      title: 'Miden',
      favicon: 'data:image/png;base64,AAA',
      status: 'active',
      openedAt: 1000
    };
    const persisted = toPersisted(session, 2000);
    expect(persisted).toEqual({
      id: 'dapp-abc',
      url: 'https://miden.xyz/',
      origin: 'https://miden.xyz',
      title: 'Miden',
      favicon: 'data:image/png;base64,AAA',
      openedAt: 1000,
      parkedAt: 2000
    });
    const rehydrated = fromPersisted(persisted);
    expect(rehydrated.id).toBe('dapp-abc');
    expect(rehydrated.status).toBe('parked');
    expect(rehydrated.openedAt).toBe(1000);
  });
});
