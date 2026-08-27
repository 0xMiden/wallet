/* eslint-disable import/first */

const _g = globalThis as any;
_g.__dlTest = { store: {} as Record<string, any> };

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const t = (globalThis as any).__dlTest;
      if (t.failReads) throw new Error('storage read failed');
      const out: Record<string, any> = {};
      for (const k of keys) if (k in t.store) out[k] = t.store[k];
      return out;
    },
    set: async (items: Record<string, any>) => {
      const t = (globalThis as any).__dlTest;
      if (t.beforeSet) await t.beforeSet(items);
      Object.assign(t.store, items);
    }
  })
}));

jest.mock('shared/logger', () => ({ logger: { error: jest.fn(), warning: jest.fn(), info: jest.fn() } }));

import {
  addToNoteDeadletter,
  clearNoteDeadletter,
  hasDeadletteredNotes,
  listDeadletteredNotes,
  removeFromNoteDeadletter,
  type DeadletteredNote
} from './note-deadletter';

const entry = (bytes: string, over: Partial<DeadletteredNote> = {}): DeadletteredNote => ({
  bytes,
  reason: 'transport',
  failedAt: 1000,
  attempts: 3,
  ...over
});

beforeEach(() => {
  for (const k of Object.keys(_g.__dlTest.store)) delete _g.__dlTest.store[k];
  _g.__dlTest.failReads = false;
  _g.__dlTest.beforeSet = undefined;
});

describe('note-deadletter', () => {
  it('adds and lists notes', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await addToNoteDeadletter(entry('bbb', { reason: 'malformed' }));
    const list = await listDeadletteredNotes();
    expect(list.map(n => n.bytes)).toEqual(['aaa', 'bbb']);
    expect(await hasDeadletteredNotes()).toBe(true);
  });

  it('dedupes by bytes (re-give-up refreshes, does not duplicate)', async () => {
    await addToNoteDeadletter(entry('aaa', { attempts: 3 }));
    await addToNoteDeadletter(entry('aaa', { attempts: 9 }));
    const list = await listDeadletteredNotes();
    expect(list).toHaveLength(1);
    expect(list[0]?.attempts).toBe(9);
  });

  it('refuses a new note at capacity rather than evicting an older one', async () => {
    // The cap bounds storage against a pathological run, but honouring it by dropping
    // the oldest record destroys note bytes that may be the only copy of the funds
    // they carry — the exact loss this store exists to prevent — and it did so while
    // returning success, so the import queue stopped carrying a DIFFERENT note in the
    // same breath. Two notes gone from both stores per add. Refusing keeps the new one
    // on the import queue, where it is still carried and still retried.
    for (let i = 0; i < 200; i++) expect(await addToNoteDeadletter(entry(`note-${i}`))).toBe(true);

    expect(await addToNoteDeadletter(entry('note-200'))).toBe(false);

    const list = await listDeadletteredNotes();
    expect(list).toHaveLength(200);
    expect(list[0]?.bytes).toBe('note-0');
    expect(list.at(-1)?.bytes).toBe('note-199');
    expect(list.some(n => n.bytes === 'note-200')).toBe(false);
  });

  it('still refreshes an existing record at capacity', async () => {
    // A re-give-up on a note already in the store replaces its record, so it does not
    // grow the store and must not be refused.
    for (let i = 0; i < 200; i++) await addToNoteDeadletter(entry(`note-${i}`));

    expect(await addToNoteDeadletter(entry('note-7', { attempts: 42 }))).toBe(true);

    const list = await listDeadletteredNotes();
    expect(list).toHaveLength(200);
    expect(list.find(n => n.bytes === 'note-7')?.attempts).toBe(42);
  });

  it('refuses when the store cannot be read, instead of overwriting it with one entry', async () => {
    // A failed read used to fall back to `[]`, and the write that followed replaced
    // the whole store with just the new entry. Every previously dead-lettered note
    // gone, and none of them still on the import queue to re-derive from.
    await addToNoteDeadletter(entry('keep-me'));
    _g.__dlTest.failReads = true;

    expect(await addToNoteDeadletter(entry('new-one'))).toBe(false);

    _g.__dlTest.failReads = false;
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['keep-me']);
  });

  it('reports failure when the write does not land', async () => {
    _g.__dlTest.beforeSet = async () => {
      throw new Error('QuotaExceededError');
    };
    expect(await addToNoteDeadletter(entry('aaa'))).toBe(false);
    _g.__dlTest.beforeSet = undefined;
    expect(await listDeadletteredNotes()).toEqual([]);
  });

  it('serializes concurrent adds so neither note is erased by the other', async () => {
    // Two adds overlap in production: an import pass evicted by the WASM-lock
    // watchdog is ABANDONED, not cancelled, so its callback keeps running and can
    // give up on one note while its successor gives up on another. Unserialized, both
    // read the same snapshot and the second write erases the first note's record —
    // after the import queue has already stopped carrying it on a `true` return.
    const results = await Promise.all([addToNoteDeadletter(entry('aaa')), addToNoteDeadletter(entry('bbb'))]);

    expect(results).toEqual([true, true]);
    expect((await listDeadletteredNotes()).map(n => n.bytes).sort()).toEqual(['aaa', 'bbb']);
  });

  it('serializes a remove against a concurrent add', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await Promise.all([removeFromNoteDeadletter('aaa'), addToNoteDeadletter(entry('bbb'))]);
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['bbb']);
  });

  it('removes a single note by bytes', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await addToNoteDeadletter(entry('bbb'));
    await removeFromNoteDeadletter('aaa');
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['bbb']);
  });

  it('clears the whole store', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await clearNoteDeadletter();
    expect(await listDeadletteredNotes()).toEqual([]);
    expect(await hasDeadletteredNotes()).toBe(false);
  });

  it('is a no-op (empty) when storage has never been written', async () => {
    expect(await listDeadletteredNotes()).toEqual([]);
    expect(await hasDeadletteredNotes()).toBe(false);
  });
});
