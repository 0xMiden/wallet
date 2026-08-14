/* eslint-disable import/first */

const _g = globalThis as any;
_g.__dlTest = { store: {} as Record<string, any> };

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) if (k in (globalThis as any).__dlTest.store) out[k] = (globalThis as any).__dlTest.store[k];
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__dlTest.store, items);
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

  it('caps the store at the most recent MAX entries', async () => {
    for (let i = 0; i < 250; i++) await addToNoteDeadletter(entry(`note-${i}`));
    const list = await listDeadletteredNotes();
    expect(list).toHaveLength(200);
    // oldest evicted; newest retained
    expect(list.at(-1)?.bytes).toBe('note-249');
    expect(list[0]?.bytes).toBe('note-50');
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
