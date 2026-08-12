/* eslint-disable import/first */

const _g = globalThis as any;
_g.__notesTest = {
  store: {} as Record<string, any>,
  midenClient: {
    importNoteBytes: jest.fn(),
    syncState: jest.fn()
  }
};

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys)
        if (k in (globalThis as any).__notesTest.store) {
          out[k] = (globalThis as any).__notesTest.store[k];
        }
      return out;
    },
    set: async (items: Record<string, any>) => {
      const hook = (globalThis as any).__notesTest.beforeSet;
      if (hook) await hook(items);
      Object.assign((globalThis as any).__notesTest.store, items);
    }
  })
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => (globalThis as any).__notesTest.midenClient,
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

// importAllNotes now routes import + sync through `midenClientProxy` (issue #260,
// slice 7a). The proxy reads `getMidenClient`/`withWasmClientLock` via the `lib/...`
// alias, which jest registers separately from the relative specifier above; delegate
// it to the same mock so the proxy's flag-off passthrough hits `__notesTest.midenClient`.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));

jest.mock('shared/logger', () => ({
  logger: { error: jest.fn(), warning: jest.fn(), info: jest.fn() }
}));

import { importAllNotes, queueNoteImport } from './notes';

beforeEach(() => {
  for (const k of Object.keys(_g.__notesTest.store)) delete _g.__notesTest.store[k];
  _g.__notesTest.beforeSet = undefined;
  _g.__notesTest.midenClient.importNoteBytes.mockClear();
  _g.__notesTest.midenClient.syncState.mockClear();
});

describe('queueNoteImport', () => {
  it('appends a note bytes string to the queue', async () => {
    await queueNoteImport('aGVsbG8=');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['aGVsbG8=']);
  });

  it('appends to an existing queue', async () => {
    _g.__notesTest.store['miden-notes-pending-import'] = ['first'];
    await queueNoteImport('second');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['first', 'second']);
  });
});

describe('importAllNotes', () => {
  it('is a no-op when the queue is empty', async () => {
    await importAllNotes();
    expect(_g.__notesTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
  });

  it('imports each queued note and clears the queue afterwards', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8=', 'd29ybGQ='];
    const p = importAllNotes();
    // Advance the 2s delay
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(2);
    expect(_g.__notesTest.midenClient.syncState).toHaveBeenCalled();
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    jest.useRealTimers();
  });

  // A note import can fail transiently (e.g. a NoteId import fetches over RPC).
  // A failing note must not abort the batch, but it also must not be dropped on
  // the first failure — that would lose a recoverable note (a private note's
  // bytes are its only copy). It is kept and retried, carrying an attempt count.
  it('keeps a failing note for retry (with an incremented attempt count) while importing the rest', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['bad', 'good'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes
      .mockRejectedValueOnce(new Error('rpc fetch failed'))
      .mockResolvedValue(undefined);

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await expect(p).resolves.toBeUndefined();

    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(2);
    expect(_g.__notesTest.midenClient.syncState).toHaveBeenCalled();
    // The good note was imported and removed; the failing note is retained with
    // attempts === 1 (legacy string entries are normalized to objects).
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([{ bytes: 'bad', attempts: 1 }]);
    jest.useRealTimers();
  });

  // The brick: a deterministically bad note (e.g. raw Note bytes where a
  // NoteFile is expected) fails every attempt. It must be dropped after a bounded
  // number of retries so it can't re-throw forever and jam the queue — and with
  // it all transaction generation. importAllNotes must never throw for this.
  it('drops a poison note after MAX_IMPORT_ATTEMPTS without ever throwing', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['poison'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('notefile deserialization failed'));

    // Pass 1 and 2: the note is retried (attempts 1, then 2), never dropped.
    for (const expectedAttempts of [1, 2]) {
      const p = importAllNotes();
      await jest.advanceTimersByTimeAsync(2100);
      await expect(p).resolves.toBeUndefined();
      expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([
        { bytes: 'poison', attempts: expectedAttempts }
      ]);
    }

    // Pass 3: third failure hits the cap, so the note is dropped and the queue
    // drains — the next loop iteration is a clean no-op.
    const p3 = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await expect(p3).resolves.toBeUndefined();
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('clears the processed notes even if syncState throws afterwards', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['good'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockResolvedValue(undefined);
    _g.__notesTest.midenClient.syncState.mockReset();
    _g.__notesTest.midenClient.syncState.mockRejectedValue(new Error('sync failed'));

    // Capture the rejection immediately so it is never momentarily unhandled
    // while fake timers advance.
    let caught: Error | undefined;
    const p = importAllNotes().catch((e: Error) => {
      caught = e;
    });
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    // The sync failure propagates...
    expect(caught?.message).toBe('sync failed');
    // ...but the note was already imported and removed from the queue, so it is
    // not retried on the next loop iteration.
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);

    _g.__notesTest.midenClient.syncState.mockReset();
    _g.__notesTest.midenClient.syncState.mockResolvedValue(undefined);
    jest.useRealTimers();
  });

  it('slices off only the processed prefix, keeping notes appended during import', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['first'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockImplementation(async () => {
      // A new note arrives while the snapshot is being processed.
      _g.__notesTest.store['miden-notes-pending-import'] = ['first', 'late'];
    });

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['late']);
    jest.useRealTimers();
  });

  it('falls back to an empty queue when storage is cleared during the import pass', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['only'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockImplementation(async () => {
      // The stored queue disappears mid-pass (e.g. a concurrent wallet reset).
      // The post-pass re-fetch must then fall back to [] rather than throw on a
      // null/undefined read.
      delete _g.__notesTest.store['miden-notes-pending-import'];
    });

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await expect(p).resolves.toBeUndefined();

    // The note imported successfully (not retried); the rebuilt queue is empty
    // because the re-fetch saw no stored value and used the [] fallback.
    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    jest.useRealTimers();
  });
});

describe('queueNoteImport vs importAllNotes concurrency', () => {
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  // TOCTOU race: importAllNotes rebuilds the queue with a read-slice-write, and
  // queueNoteImport does its own read-modify-write. If an enqueue lands between
  // importAllNotes' rewrite read and its rewrite write, the write clobbers the
  // freshly enqueued note. A private note's bytes are its only copy, so the note
  // is lost. The queue-level lock must serialize the two so nothing is dropped.
  it('does not drop a note enqueued during importAllNotes rewrite window', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['snap'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockResolvedValue(undefined);

    // Park importAllNotes at its rewrite write (the first `set` of the pass), so
    // a concurrent enqueue is forced into the read-write window.
    let setCount = 0;
    let releaseGate = () => {};
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    _g.__notesTest.beforeSet = async () => {
      setCount += 1;
      if (setCount === 1) await gate;
    };

    const importP = importAllNotes();
    // Let importAllNotes run up to (and block on) its gated rewrite write.
    await flush();

    // A new private note is enqueued while importAllNotes is mid-rewrite.
    const enqueueP = queueNoteImport('fresh-private-note');
    await flush();

    // Unblock the rewrite write and let both settle.
    releaseGate();
    await enqueueP;
    await jest.advanceTimersByTimeAsync(2100);
    await importP;

    const queue = (_g.__notesTest.store['miden-notes-pending-import'] as any[]).map(e =>
      typeof e === 'string' ? e : e.bytes
    );
    // The processed snapshot note is gone (correctly imported), but the note
    // enqueued during the pass MUST survive.
    expect(queue).toContain('fresh-private-note');
    jest.useRealTimers();
  });
});
