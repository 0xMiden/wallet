/* eslint-disable import/first */

const _g = globalThis as any;
_g.__dlTest = { store: {} as Record<string, any>, writes: 0 };

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
      t.writes++;
      Object.assign(t.store, items);
    }
  })
}));

jest.mock('shared/logger', () => ({ logger: { error: jest.fn(), warning: jest.fn(), info: jest.fn() } }));

import {
  addToNoteDeadletter,
  clearNoteDeadletter,
  listDeadletteredNotes,
  countDeadletteredNotes,
  removeManyFromNoteDeadletter,
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
  _g.__dlTest.writes = 0;
});

describe('note-deadletter', () => {
  it('adds and lists notes', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await addToNoteDeadletter(entry('bbb', { reason: 'malformed' }));
    const list = await listDeadletteredNotes();
    expect(list.map(n => n.bytes)).toEqual(['aaa', 'bbb']);
    expect(await countDeadletteredNotes()).toBeGreaterThan(0);
  });

  it('dedupes by bytes (re-give-up refreshes, does not duplicate)', async () => {
    await addToNoteDeadletter(entry('aaa', { attempts: 3 }));
    await addToNoteDeadletter(entry('aaa', { attempts: 9 }));
    const list = await listDeadletteredNotes();
    expect(list).toHaveLength(1);
    expect(list[0]?.attempts).toBe(9);
  });

  it('treats a present-but-unusable stored value as an unreadable store, never as an empty one', async () => {
    // The desktop and Capacitor adapters hand back the RAW STRING when the stored
    // JSON does not parse, which the queue side already guards three times over. Here
    // it went straight into `existing.filter(...)`: a `TypeError` out of the give-up
    // path, past a caller with no try around it, so the whole import pass rejected on
    // every lap and no note could ever be dead-lettered again — while the queue kept
    // carrying notes it could no longer retire.
    _g.__dlTest.store['miden-note-import-deadletter'] = '{corrupt';

    await expect(addToNoteDeadletter(entry('aaa'))).resolves.toBe(false);
    // And the readers do not read a string's length as a count of dead-lettered notes.
    expect(await listDeadletteredNotes()).toEqual([]);
    expect(await countDeadletteredNotes()).toBe(0);
    // Refused, not reset: the value may be a truncated write over records whose bytes
    // are the only copy of the funds they carry, so it is left exactly as found.
    expect(_g.__dlTest.store['miden-note-import-deadletter']).toBe('{corrupt');
  });

  it('does not throw on an ARRAY whose members are not records, and keeps the ones that are', async () => {
    // `JSON.parse('[null]')` passes an `Array.isArray` check and then throws inside
    // `existing.filter(n => n.bytes !== ...)` — out of the give-up path, whose caller
    // has no try, so the whole import pass rejected on every lap and the poison cap
    // could never stick. Members with no bytes carry nothing to preserve, so they are
    // dropped rather than making the store unreadable.
    _g.__dlTest.store['miden-note-import-deadletter'] = [null, entry('keepme'), 7, { reason: 'no-bytes' }];

    await expect(addToNoteDeadletter(entry('aaa'))).resolves.toBe(true);

    const list = await listDeadletteredNotes();
    expect(list.map(n => n.bytes)).toEqual(['keepme', 'aaa']);
  });

  it('salvages a lone record that lost its array wrapper, matching the import queue', async () => {
    // The queue side salvages exactly this shape (the adapters can hand back one
    // entry stripped of its array), and its reason applies here verbatim: the bytes
    // may be the only copy of the funds they carry. Refusing on this side would have
    // made the same fault recoverable before the give-up and terminal after it.
    _g.__dlTest.store['miden-note-import-deadletter'] = entry('lonely');

    await expect(addToNoteDeadletter(entry('aaa'))).resolves.toBe(true);
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['lonely', 'aaa']);
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
    const aaa = entry('aaa');
    await addToNoteDeadletter(aaa);
    await Promise.all([removeManyFromNoteDeadletter([aaa]), addToNoteDeadletter(entry('bbb'))]);
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['bbb']);
  });

  it('removes the listed records in ONE write and reports which went', async () => {
    const aaa = entry('aaa');
    const bbb = entry('bbb');
    await addToNoteDeadletter(aaa);
    await addToNoteDeadletter(bbb);
    await addToNoteDeadletter(entry('ccc'));

    const writesBefore = _g.__dlTest.writes;
    const drained = await removeManyFromNoteDeadletter([aaa, bbb]);

    expect(drained.map(n => n.bytes)).toEqual(['aaa', 'bbb']);
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['ccc']);
    // The whole point of the batch: a Retry over a full store was 2N storage
    // round trips, and on a synchronous adapter none of them yielded.
    expect(_g.__dlTest.writes - writesBefore).toBe(1);
  });

  it('reports an already-absent record as drained — the same postcondition, reached earlier', async () => {
    expect((await removeManyFromNoteDeadletter([entry('aaa')])).map(n => n.bytes)).toEqual(['aaa']);
  });

  it('REFUSES to remove a record that a later give-up has replaced', async () => {
    // The drain's fund-loss window: it lists a record, requeues the bytes, and
    // before the removal lands a fresh import pass gives up on the same note
    // again. That add REPLACES the record (the store dedupes by bytes) and the
    // pass still holds those bytes on the import queue, dropping them at commit
    // — so removing by bytes would take the note out of both stores at once.
    // `failedAt` is the generation marker that refuses it.
    const listed = entry('aaa');
    const untouched = entry('bbb');
    await addToNoteDeadletter(listed);
    await addToNoteDeadletter(untouched);
    await addToNoteDeadletter({ ...listed, failedAt: listed.failedAt + 1, attempts: listed.attempts + 1 });

    // The replaced one is refused; its batch-mates still drain.
    const drained = await removeManyFromNoteDeadletter([listed, untouched]);
    expect(drained.map(n => n.bytes)).toEqual(['bbb']);
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['aaa']);
  });

  it('drains nothing when the write fails, leaving every record in place', async () => {
    const aaa = entry('aaa');
    await addToNoteDeadletter(aaa);
    _g.__dlTest.beforeSet = () => {
      throw new Error('quota exceeded');
    };

    expect(await removeManyFromNoteDeadletter([aaa])).toEqual([]);
    _g.__dlTest.beforeSet = undefined;
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['aaa']);
  });

  it('still reports the already-absent records when the write fails', async () => {
    // The write can only fail to remove what it was needed for. An entry that was
    // never in the store is drained by definition, and the caller reads this
    // length as "did anything move" — reporting zero there withheld the fuse
    // grant and told the user the Retry did nothing, about notes it had already
    // put back on the import queue.
    const stayed = entry('stayed');
    const gone = entry('gone');
    await addToNoteDeadletter(stayed);
    _g.__dlTest.beforeSet = () => {
      throw new Error('quota exceeded');
    };

    expect((await removeManyFromNoteDeadletter([stayed, gone])).map(n => n.bytes)).toEqual(['gone']);

    _g.__dlTest.beforeSet = undefined;
    // …and the one the write WOULD have removed is untouched, which is the half
    // the previous test pins.
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['stayed']);
  });

  it('drains nothing when the store is unreadable', async () => {
    const aaa = entry('aaa');
    await addToNoteDeadletter(aaa);
    _g.__dlTest.failReads = true;

    expect(await removeManyFromNoteDeadletter([aaa])).toEqual([]);
    _g.__dlTest.failReads = false;
    expect((await listDeadletteredNotes()).map(n => n.bytes)).toEqual(['aaa']);
  });

  it('touches storage not at all for an empty batch', async () => {
    await addToNoteDeadletter(entry('aaa'));
    const writesBefore = _g.__dlTest.writes;
    expect(await removeManyFromNoteDeadletter([])).toEqual([]);
    expect(_g.__dlTest.writes).toBe(writesBefore);
  });

  it('counts without handing the caller any note bytes', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await addToNoteDeadletter(entry('bbb'));
    expect(await countDeadletteredNotes()).toBe(2);
  });

  it('clears the whole store', async () => {
    await addToNoteDeadletter(entry('aaa'));
    await clearNoteDeadletter();
    expect(await listDeadletteredNotes()).toEqual([]);
    expect(await countDeadletteredNotes()).toBe(0);
  });

  it('is a no-op (empty) when storage has never been written', async () => {
    expect(await listDeadletteredNotes()).toEqual([]);
    expect(await countDeadletteredNotes()).toBe(0);
  });
});
