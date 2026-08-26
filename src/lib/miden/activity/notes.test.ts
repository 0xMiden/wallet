/* eslint-disable import/first */

const _g = globalThis as any;
_g.__notesTest = {
  store: {} as Record<string, any>,
  midenClient: {
    importNoteBytes: jest.fn(),
    syncState: jest.fn()
  },
  // Every hold's options, so a test can assert the ceiling a hold was taken with —
  // a pass-through lock mock makes an unbounded hold indistinguishable otherwise.
  lockOptions: [] as unknown[],
  // When set, the NEXT hold is torn down instead of run: the shape of a watchdog
  // eviction, which abandons its callback rather than letting it finish.
  evictNextHold: false
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
  withWasmClientLock: async <T>(fn: () => Promise<T>, options?: unknown) => {
    const t = (globalThis as any).__notesTest;
    t.lockOptions.push(options);
    if (t.evictNextHold) {
      t.evictNextHold = false;
      throw Object.assign(new Error('WASM client evicted'), { name: 'WasmClientPoisonedError', reason: 'watchdog' });
    }
    return fn();
  }
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
import { WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';

beforeEach(() => {
  for (const k of Object.keys(_g.__notesTest.store)) delete _g.__notesTest.store[k];
  _g.__notesTest.beforeSet = undefined;
  _g.__notesTest.midenClient.importNoteBytes.mockClear();
  _g.__notesTest.midenClient.syncState.mockClear();
  _g.__notesTest.lockOptions = [];
  _g.__notesTest.evictNextHold = false;
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
  it('takes both of its holds on the bounded sync ceiling (#777)', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8='];
    _g.__notesTest.midenClient.importNoteBytes.mockResolvedValue(undefined);
    _g.__notesTest.midenClient.syncState.mockResolvedValue(undefined);

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    // Both the import and the trailing sync reach a node over an RPC that carries
    // no transport deadline on wasm32, so neither may sit on the five-minute last
    // resort: that is one parked note freezing every send and claim in the app for
    // five minutes per lap.
    expect(_g.__notesTest.lockOptions).toEqual([
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS },
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
    ]);
    jest.useRealTimers();
  });

  it('banks the attempt when the import hold is evicted mid-pass (#777)', async () => {
    // An eviction abandons the callback, so neither the per-note catch nor the
    // queue rewrite inside the hold runs. Without banking here the next lap reads a
    // byte-identical queue and re-enters the same hold: no attempt is ever spent,
    // so the poison cap never trips, the dead-letter store is never reached, and
    // the note jams the import pass — and therefore the transaction lap — forever.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8='];
    _g.__notesTest.evictNextHold = true;

    await expect(importAllNotes()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'aGVsbG8=', attempts: 1 });
    // And it earns backoff, which is what gives the jam an exit: a carried note
    // stops being eligible, so the next pass imports nothing and cannot be evicted
    // on this note again.
    expect(queue[0].nextEligibleAt).toBeGreaterThan(Date.now());
    expect(queue[0].firstFailureAt).toBeLessThanOrEqual(Date.now());
  });

  it('dead-letters rather than carrying a note whose transient budget is spent, when the hold is evicted (#777)', async () => {
    // Evictions are read as transient, so the 24h wall-clock budget is what ends
    // the carry — the note is never silently dropped, it lands in the dead-letter
    // store where it stays recoverable.
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 9, firstFailureAt: longAgo }];
    _g.__notesTest.evictNextHold = true;

    await expect(importAllNotes()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    const deadletter = _g.__notesTest.store['miden-note-import-deadletter'];
    expect(deadletter).toHaveLength(1);
    expect(deadletter[0]).toMatchObject({ bytes: 'aGVsbG8=', reason: 'transport', attempts: 10 });
  });

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
    // attempts === 1 (legacy string entries are normalized to objects; the entry
    // now also carries a firstFailureAt anchor for the retry budget).
    const q = _g.__notesTest.store['miden-notes-pending-import'];
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ bytes: 'bad', attempts: 1 });
    jest.useRealTimers();
  });

  // GAP 1 (resilience): a TRANSIENT (network/RPC) import failure must NOT be
  // dropped just because it spanned a few loop ticks. The old iteration-count cap
  // (MAX_IMPORT_ATTEMPTS=3) exhausted in ~seconds, silently losing a recoverable
  // (possibly private, bytes-are-only-copy) note on a brief outage. The note must
  // be retained and retried on a WALL-CLOCK budget, not an iteration count.
  it('does NOT drop a transient import failure after 3 loop ticks (wall-clock budget)', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['transient-note'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    // A transport error (transient) — recognized by isLikelyNetworkError.
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('transport error: connection refused'));

    // Run FOUR import passes (more than the old cap of 3), advancing wall-clock
    // only a little between them (far inside any reasonable retry budget).
    for (let i = 0; i < 4; i++) {
      const p = importAllNotes();
      await jest.advanceTimersByTimeAsync(2100);
      await expect(p).resolves.toBeUndefined();
    }

    // The note must still be queued — retained for retry, not silently dropped.
    const queue = _g.__notesTest.store['miden-notes-pending-import'] as Array<{ bytes: string }>;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'transient-note' });
    jest.useRealTimers();
  });

  // The brick: a deterministically bad note (e.g. raw Note bytes where a
  // NoteFile is expected) fails every attempt with a NON-transport error. It must
  // drain from the active queue after a bounded number of retries so it can't
  // re-throw forever and jam transaction generation — but it must be moved to the
  // DEAD-LETTER store, not silently dropped, so it stays recoverable. importAllNotes
  // must never throw for this.
  it('dead-letters a poison note after POISON_MAX_ATTEMPTS without ever throwing', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['poison'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('notefile deserialization failed'));

    // Pass 1 and 2: the note is retried (attempts 1, then 2), never dropped.
    for (const expectedAttempts of [1, 2]) {
      const p = importAllNotes();
      await jest.advanceTimersByTimeAsync(2100);
      await expect(p).resolves.toBeUndefined();
      const q = _g.__notesTest.store['miden-notes-pending-import'];
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({ bytes: 'poison', attempts: expectedAttempts });
    }

    // Pass 3: third failure hits the poison cap, so the note leaves the active
    // queue AND lands in the dead-letter store (never silently dropped).
    const p3 = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await expect(p3).resolves.toBeUndefined();
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    const deadletter = _g.__notesTest.store['miden-note-import-deadletter'];
    expect(deadletter).toHaveLength(1);
    expect(deadletter[0]).toMatchObject({ bytes: 'poison', reason: 'malformed', attempts: 3 });
    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  // GAP 1 (resilience): a note whose TRANSIENT failures outlast the wall-clock
  // retry budget must land in the dead-letter store (recoverable + surfaceable),
  // never be silently dropped.
  it('dead-letters a transient note once the wall-clock retry budget is exhausted', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['transient'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('transport error: connection refused'));

    // Drive passes across MORE than the 24h budget, advancing well past each
    // backoff window so an attempt is actually spent each pass.
    for (let i = 0; i < 30; i++) {
      const p = importAllNotes();
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000 + 2100); // +1h + the sync delay
      await expect(p).resolves.toBeUndefined();
    }

    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    const deadletter = _g.__notesTest.store['miden-note-import-deadletter'];
    expect(deadletter).toHaveLength(1);
    expect(deadletter[0]).toMatchObject({ bytes: 'transient', reason: 'transport' });
    jest.useRealTimers();
  });

  it('swallows a trailing syncState failure once the queue is committed (#777)', async () => {
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = ['good'];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockResolvedValue(undefined);
    _g.__notesTest.midenClient.syncState.mockReset();
    _g.__notesTest.midenClient.syncState.mockRejectedValue(new Error('sync failed'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    // The tail must NOT reject: the caller reads a throw from here as "a queued
    // consume's note did not import" and skips the lap, and this sync says nothing
    // about the queue — the note is already imported and dequeued by now.
    await expect(p).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[importAllNotes] post-import sync failed; the queue is already committed',
      expect.objectContaining({ message: 'sync failed' })
    );
    warnSpy.mockRestore();
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
