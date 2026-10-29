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
    const stored = JSON.parse(store[STORAGE_KEY]!);
    expect(stored.map((s: PersistedSession) => s.id)).toEqual(['a', 'b']);
  });
});

describe('upsertPersistedSession', () => {
  it('adds a new entry when the store is empty', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    const loaded = await loadPersistedSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('a');
  });

  it('replaces an entry with the same id', async () => {
    await upsertPersistedSession(makePersisted('a', 100));
    await upsertPersistedSession({ ...makePersisted('a', 200), title: 'updated' });
    const loaded = await loadPersistedSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.title).toBe('updated');
    expect(loaded[0]!.parkedAt).toBe(200);
  });

  it('does not overwrite parked sessions when a read fails before upsert', async () => {
    const original = JSON.stringify([makePersisted('prior')]);
    store[STORAGE_KEY] = original;
    mockGet.mockRejectedValueOnce(new Error('read failed'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await upsertPersistedSession(makePersisted('new'));
      expect(store[STORAGE_KEY]).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not overwrite parked sessions when normalization fails before upsert', async () => {
    const original = JSON.stringify([makePersisted('prior')], null, 2);
    store[STORAGE_KEY] = original;
    mockSet.mockRejectedValueOnce(new Error('normalization failed'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await upsertPersistedSession(makePersisted('new'));
      expect(store[STORAGE_KEY]).toBe(original);
    } finally {
      warn.mockRestore();
    }
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

  it('logs warning but does not throw when Preferences.remove rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRemove.mockRejectedValueOnce(new Error('storage error'));
    await expect(clearAllPersistedSessions()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('savePersistedSessions error handling', () => {
  it('logs warning but does not throw when Preferences.set rejects', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSet.mockRejectedValueOnce(new Error('write error'));
    await expect(savePersistedSessions([makePersisted('a')])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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

describe('ordered persistence mutations', () => {
  it('deletes after an outstanding write and preserves concurrent unrelated sessions', async () => {
    store[STORAGE_KEY] = JSON.stringify([makePersisted('keep')]);
    let release: () => void = () => {
      throw new Error('write has not started');
    };
    let started: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const writing = new Promise<void>(resolve => {
      started = resolve;
    });
    mockSet.mockImplementationOnce(async ({ key, value }) => {
      started();
      await gate;
      store[key] = value;
    });
    const park = upsertPersistedSession(makePersisted('closed'));
    await writing;
    const other = upsertPersistedSession(makePersisted('other'));
    const close = removePersistedSession('closed');
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([park, other, close]);
    expect((await loadPersistedSessions()).map(s => s.id).sort()).toEqual(['keep', 'other']);
  });

  it('serializes concurrent read-modify-write operations on the shared list', async () => {
    await Promise.all([upsertPersistedSession(makePersisted('a')), upsertPersistedSession(makePersisted('b'))]);
    expect((await loadPersistedSessions()).map(s => s.id).sort()).toEqual(['a', 'b']);
  });

  it('runs reset after an outstanding direct list save', async () => {
    let release: () => void = () => {
      throw new Error('save has not started');
    };
    let started: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const writing = new Promise<void>(resolve => {
      started = resolve;
    });
    mockSet.mockImplementationOnce(async ({ key, value }) => {
      started();
      await gate;
      store[key] = value;
    });
    const save = savePersistedSessions([makePersisted('closed')]);
    await writing;
    const reset = clearAllPersistedSessions();
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([save, reset]);
    expect(store[STORAGE_KEY]).toBeUndefined();
  });

  it('repairs a corrupt list inside upsert without recursively waiting on its queue', async () => {
    store[STORAGE_KEY] = '{"not":"an array"}';
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await upsertPersistedSession(makePersisted('a'));
    expect((await loadPersistedSessions()).map(s => s.id)).toEqual(['a']);
    warning.mockRestore();
  });
});

describe('Task5 cache mobile sessions', () => {
  it('enforces the existing eight-session cap during a legacy load and repairs the stored list', async () => {
    store[STORAGE_KEY] = JSON.stringify(Array.from({ length: 11 }, (_, i) => makePersisted(`dapp-${i}`, i)));
    const loaded = await loadPersistedSessions();
    expect(loaded).toHaveLength(8);
    expect(loaded.some(session => session.id === 'dapp-10')).toBe(true);
    expect(JSON.parse(store[STORAGE_KEY]!).length).toBe(8);
  });

  it('bounds whole session bytes without truncating retained URLs or origins', async () => {
    const active = makePersisted('dapp-active', 100);
    const oversized = { ...makePersisted('dapp-large'), title: '界'.repeat(6000) };
    await savePersistedSessions([oversized, active]);
    const content = store[STORAGE_KEY]!;
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(131_072);
    const loaded = await loadPersistedSessions();
    expect(loaded).toEqual([active]);
    expect(mockRemoveSnapshot).toHaveBeenCalledWith('dapp-large');
  });

  it('enforces the cap on direct save and suppresses an unchanged serialized save', async () => {
    const sessions = Array.from({ length: 9 }, (_, i) => makePersisted(`dapp-${i}`, i));
    await savePersistedSessions(sessions);
    const first = await loadPersistedSessions();
    expect(first).toHaveLength(8);
    mockSet.mockClear();
    await savePersistedSessions(first);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
