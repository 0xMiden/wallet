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
  // When set, the NEXT hold is EVICTED: the callback is started and keeps running,
  // and the hold's promise rejects out from under it. Modelling this as "the
  // callback never ran" would be strictly weaker than production — the abandoned
  // callback resuming later is the whole hazard.
  //
  // `true` evicts the instant the hold is taken. A PROMISE evicts when it settles,
  // which is what lets a test put the callback in a specific mid-loop state first —
  // the watchdog fires two minutes in, by which point earlier notes have imported.
  evictNextHold: false as boolean | Promise<void>,
  // The abandoned callback, so a test can let it finish and observe what it writes.
  abandonedHold: null as Promise<unknown> | null,
  // Who owns the mutex right now, mirroring `getCurrentWasmLockHold`. An eviction
  // takes ownership AWAY from the callback it abandons, which is what makes the
  // pass's own liveness guard observable: without modelling it, a mock hold looks
  // valid forever and the abandoned callback appears free to keep calling WASM.
  currentHold: null as object | null
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
  getCurrentWasmLockHold: () => (globalThis as any).__notesTest.currentHold,
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>, options?: unknown) => {
    const t = (globalThis as any).__notesTest;
    t.lockOptions.push(options);
    const hold = {};
    t.currentHold = hold;
    if (t.evictNextHold) {
      const gate: Promise<void> | null = t.evictNextHold === true ? null : t.evictNextHold;
      t.evictNextHold = false;
      const running = fn(hold);
      running.catch(() => {});
      t.abandonedHold = running;
      if (gate) await gate;
      // The eviction hands the mutex to whoever comes next, so the abandoned
      // callback no longer owns it — exactly what production does before it
      // rejects the holder.
      t.currentHold = null;
      throw Object.assign(new Error('WASM client evicted'), { name: 'WasmClientPoisonedError', reason: 'watchdog' });
    }
    try {
      return await fn(hold);
    } finally {
      if (t.currentHold === hold) t.currentHold = null;
    }
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

import { logger } from 'shared/logger';

import { BACKOFF_MAX_MS, importAllNotes, queueNoteImport } from './notes';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';

beforeEach(() => {
  for (const k of Object.keys(_g.__notesTest.store)) delete _g.__notesTest.store[k];
  _g.__notesTest.beforeSet = undefined;
  // mockReset, not mockClear: a test that installs a rejecting or parked
  // implementation would otherwise hand it to every test that follows.
  _g.__notesTest.midenClient.importNoteBytes.mockReset();
  _g.__notesTest.midenClient.importNoteBytes.mockResolvedValue(undefined);
  _g.__notesTest.midenClient.syncState.mockReset();
  _g.__notesTest.midenClient.syncState.mockResolvedValue(undefined);
  _g.__notesTest.lockOptions = [];
  _g.__notesTest.evictNextHold = false;
  _g.__notesTest.abandonedHold = null;
  _g.__notesTest.currentHold = null;
});

// A note whose import parks: the state an eviction actually interrupts.
const parkedImport = () => {
  let release!: () => void;
  const parked = new Promise<void>(resolve => {
    release = resolve;
  });
  _g.__notesTest.midenClient.importNoteBytes.mockReset();
  _g.__notesTest.midenClient.importNoteBytes.mockImplementation(async () => parked);
  return release;
};

// A parked import that FAILS when released: a corpse whose loop then takes the
// retry path, so what it tries to commit differs from what its successor wrote.
const parkedFailingImport = () => {
  let reject!: (e: Error) => void;
  const parked = new Promise<void>((_, r) => {
    reject = r;
  });
  _g.__notesTest.midenClient.importNoteBytes.mockReset();
  _g.__notesTest.midenClient.importNoteBytes.mockImplementation(async () => parked);
  return () => reject(new Error('Failed to fetch'));
};

describe('queueNoteImport', () => {
  it('appends a note bytes string to the queue', async () => {
    await queueNoteImport('aGVsbG8=');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['aGVsbG8=']);
  });

  it('does not lose the incoming note when the stored queue is corrupt', async () => {
    // `DesktopStorage`/`CapacitorStorage` hand back the raw string when `JSON.parse`
    // fails. Spreading that built a queue of single characters; spreading a
    // non-iterable object THREW, and both callers that matter swallow this
    // function's rejection — so the arriving note was lost at the door.
    _g.__notesTest.store['miden-notes-pending-import'] = '{corrupt';
    await queueNoteImport('aGVsbG8=');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['aGVsbG8=']);

    _g.__notesTest.store['miden-notes-pending-import'] = { notAnArray: true };
    await queueNoteImport('d29ybGQ=');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['d29ybGQ=']);
  });

  it('salvages a lone queue entry that lost its array, but not unparseable JSON', async () => {
    // One `{ bytes }` object is a queue entry the storage round-trip stripped of its
    // array; its bytes may be the only copy of the funds they carry, so replacing it
    // with a fresh queue would be a note lost to a storage quirk. A top-level STRING
    // is the opposite case — it is the raw text of a value `JSON.parse` refused, so
    // treating it as base64 only spends import attempts before dead-lettering it.
    _g.__notesTest.store['miden-notes-pending-import'] = { bytes: 'YQ==', attempts: 2 };
    await queueNoteImport('Yg==');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([{ bytes: 'YQ==', attempts: 2 }, 'Yg==']);

    _g.__notesTest.store['miden-notes-pending-import'] = '{corrupt';
    await queueNoteImport('Yw==');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['Yw==']);
  });

  it('appends to an existing queue', async () => {
    _g.__notesTest.store['miden-notes-pending-import'] = ['first'];
    await queueNoteImport('second');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['first', 'second']);
  });

  it('does not queue the same note twice', async () => {
    // The delivery sweep and the dApp import path can offer the same note, and a
    // second copy buys nothing (the import is an upsert) while doubling the WASM
    // calls, the backoff bookkeeping and the eventual dead-letter records.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8=', { bytes: 'd29ybGQ=', attempts: 2 }];
    await queueNoteImport('aGVsbG8=');
    await queueNoteImport('d29ybGQ=');
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([
      'aGVsbG8=',
      { bytes: 'd29ybGQ=', attempts: 2 }
    ]);
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

  it('charges the attempt to the note the eviction interrupted, and only that one (#777)', async () => {
    // An eviction abandons the callback, so neither the per-note catch nor the
    // queue rewrite inside the hold runs. Without banking here the next lap reads a
    // byte-identical queue and re-enters the same hold: no attempt is ever spent,
    // so the poison cap never trips, the dead-letter store is never reached, and
    // the note jams the import pass forever.
    //
    // Only the IN-FLIGHT note may be charged. The loop is sequential, so the others
    // were never attempted; charging them walks untried notes toward the poison cap
    // and anchors a 24h give-up budget on them.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8=', 'd29ybGQ='];
    const release = parkedImport();
    _g.__notesTest.evictNextHold = true;

    await expect(importAllNotes()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({ bytes: 'aGVsbG8=', attempts: 1 });
    // Backoff is what gives the jam an exit: the charged note stops being eligible,
    // so the next pass does not park on it again.
    expect(queue[0].nextEligibleAt).toBeGreaterThan(Date.now());
    // The note the loop never reached is carried with nothing spent on it — and in the
    // LEGACY bare-string form, because it has no retry metadata to record. Rewriting an
    // untouched note as an object is what a downgraded build reads as base64.
    expect(queue[1]).toBe('d29ybGQ=');

    // And the abandoned callback STOPS there rather than importing the note it had
    // not reached yet. It resumes when the parked import settles, by which point the
    // mutex belongs to somebody else — so a second `importNoteBytes` from here would
    // run with no lock held, concurrently with that holder, which is the double-borrow
    // the mutex exists to prevent. It refuses to continue instead.
    release();
    await expect(_g.__notesTest.abandonedHold).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
  });

  it('refuses a superseded queue write from an abandoned pass, so notes queued since survive (#777)', async () => {
    // The hazard the positional rewrite created: an eviction does not stop the
    // callback, it resumes when its parked import finally settles — minutes later,
    // against a queue a successor has since rewritten. Keyed on array position that
    // write DELETED every note enqueued in the meantime, which for a private note
    // is the only copy of the funds it carries.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8='];
    const release = parkedImport();
    _g.__notesTest.evictNextHold = true;

    await expect(importAllNotes()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    // Two private notes arrive while the abandoned pass is still parked.
    await queueNoteImport('bmV3LW9uZQ==');
    await queueNoteImport('bmV3LXR3bw==');

    // Now the corpse wakes up, finishes its loop and tries to commit its own
    // minutes-stale view of the queue.
    release();
    await _g.__notesTest.abandonedHold;

    // Nothing the corpse writes may land: the two new notes are intact, and the
    // note IT was importing keeps the attempt the failure path banked rather than
    // being resurrected at attempts 0 (which would erase the backoff that is the
    // jam's only exit).
    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    const bytesLeft = queue.map((entry: unknown) =>
      typeof entry === 'string' ? entry : (entry as { bytes: string }).bytes
    );
    expect(bytesLeft).toEqual(['aGVsbG8=', 'bmV3LW9uZQ==', 'bmV3LXR3bw==']);
    expect(queue[0]).toMatchObject({ attempts: 1 });
    // And the refusal is on the record. On a phone this is the only signal that a
    // corpse tried to rewrite the only copy of a private note; without it the queue
    // bytes are the sole evidence, and they look the same as a pass that never ran.
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('superseded queue write from an abandoned import pass')
    );
  });

  it("refuses an abandoned pass's write on the PASS TOKEN, not just on its own commit flag (#777)", async () => {
    // The `committed` flag alone covers the ordinary eviction, because the catch
    // path commits before rethrowing. It does not cover the case where that banking
    // write itself fails: the pass then leaves the hold having committed nothing, a
    // successor runs and legitimately imports the note, and the corpse — still
    // parked, still holding a snapshot from before all of it — wakes up and writes
    // its retry list over the successor's result, RESURRECTING a note that has
    // already been consumed. Only the token can refuse that write.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8='];
    const fail = parkedFailingImport();
    _g.__notesTest.evictNextHold = true;
    // The banking commit cannot land, so the abandoned pass never sets `committed`.
    let queueWrites = 0;
    _g.__notesTest.beforeSet = async (items: Record<string, unknown>) => {
      if ('miden-notes-pending-import' in items && queueWrites++ === 0) throw new Error('QuotaExceededError');
    };

    await expect(importAllNotes()).rejects.toThrow('QuotaExceededError');
    _g.__notesTest.beforeSet = undefined;
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['aGVsbG8=']);

    // A successor pass imports the note for real and empties the queue.
    const successorImport = jest.fn(async () => {});
    _g.__notesTest.midenClient.importNoteBytes.mockImplementation(successorImport);
    jest.useFakeTimers();
    const successor = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await successor;
    jest.useRealTimers();
    expect(successorImport).toHaveBeenCalledTimes(1);
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);

    // Now the corpse finishes, fails its own import and tries to carry the note.
    fail();
    await _g.__notesTest.abandonedHold;

    // Its write is refused: the note stays consumed and gone, not re-queued.
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
  });

  it('matches queue entries by BYTES, so a note left by a writer that SHRANK the queue survives (#777)', async () => {
    // The commit used to compute "not ours" as `current.slice(snapshot.length)`,
    // which assumes the queue only ever grew. Let anything shrink it mid-pass — a
    // manual dead-letter retry that drains and re-enqueues, a second realm, a future
    // frontend call site — and the slice runs off the end: every entry the pass did
    // not know about is silently DELETED, and for a private note those bytes are the
    // only copy of the funds it carries. Matching a multiset of bytes can only ever
    // remove what this pass actually saw.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ==', 'Yg=='];
    const release = parkedImport();

    jest.useFakeTimers();
    const pass = importAllNotes();
    // Mid-pass, while the second import is parked, another writer replaces the queue
    // with a single unrelated note — shorter than the snapshot this pass holds.
    await Promise.resolve();
    _g.__notesTest.store['miden-notes-pending-import'] = ['Yw=='];

    release();
    await jest.advanceTimersByTimeAsync(2100);
    await pass;
    jest.useRealTimers();

    // The pass imported its own two notes and dropped them; the third note is not
    // its business and must still be there.
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['Yw==']);
  });

  it('consumes only as many duplicate entries as it snapshotted (#777)', async () => {
    // Byte strings are not unique: the same note can be enqueued twice (two dApp
    // deliveries of one note, a manual retry racing the sweep). A multiset has to
    // COUNT, not just test membership — decrementing per match is what stops a pass
    // that saw one copy from removing a second copy enqueued while it ran.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ=='];
    const release = parkedImport();

    jest.useFakeTimers();
    const pass = importAllNotes();
    await Promise.resolve();
    // A second copy of the SAME note arrives mid-pass.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ==', 'YQ=='];

    release();
    await jest.advanceTimersByTimeAsync(2100);
    await pass;
    jest.useRealTimers();

    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['YQ==']);
  });

  it.each([
    ["Dexie's ConstraintError", 'ConstraintError: Key already exists in the object store'],
    ["tonic's stock AlreadyExists blurb", 'Some entity that we attempted to create already exists'],
    ["the SDK's asset-vault error", 'the non-fungible asset already exists in the asset vault']
  ])('does not read %s as "already imported" and drop the note', async (_label, message) => {
    // A match here DROPS the note from the queue, so the pattern must name the one
    // thing that actually means the client has it. `note-delivery-sweep.ts` documents
    // these three as live false positives for a bare "already exists" — and the
    // import writes a Dexie-backed store, so the first one is on this very path.
    // Treating any of them as done deletes the only copy of a note never stored.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8='];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error(message));

    jest.useFakeTimers();
    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    jest.useRealTimers();

    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'aGVsbG8=', attempts: 1 });
    expect(_g.__notesTest.store['miden-note-import-deadletter']).toBeUndefined();
  });

  it('drops a note the client reports as already consumed', async () => {
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8='];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('Note has already been consumed'));

    jest.useFakeTimers();
    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    jest.useRealTimers();

    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    expect(_g.__notesTest.store['miden-note-import-deadletter']).toBeUndefined();
  });

  it('re-anchors a budget stamp that a jumped clock put in the future, so it can still expire (#777)', async () => {
    // Clamping elapsed time at zero is not enough on its own. A stamp written while
    // the device clock was AHEAD stays ahead after the correction, so every later
    // pass reads zero elapsed and the 24h budget never expires: the note is retried
    // forever, never dead-lettered, and never surfaced.
    _g.__notesTest.store['miden-notes-pending-import'] = [
      { bytes: 'aGVsbG8=', attempts: 1, firstFailureAt: Date.now() + 365 * 24 * 60 * 60 * 1000 }
    ];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('Failed to fetch'));

    jest.useFakeTimers();
    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    jest.useRealTimers();

    // Re-anchored to now: a real 24h from here, rather than a budget that can never
    // run out.
    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0].firstFailureAt).toBeLessThanOrEqual(Date.now());
  });

  it('re-anchors an implausibly OLD budget stamp, so a bad RTC cannot dead-letter a good note', async () => {
    // The mirror of the future-stamp case, and the one that costs something: a device
    // that first failed while its clock still read 1970 stamps an anchor near zero,
    // and after NTP corrects it every later pass reads the 24h budget as decades
    // expired. The next transient failure then dead-letters a note that was only ever
    // waiting on the network. Age alone cannot be the test — a genuinely month-old
    // anchor SHOULD expire the budget — so plausibility is: a pre-2020 stamp is not
    // one this wallet wrote.
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 1, firstFailureAt: 1000 }];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('Failed to fetch'));

    jest.useFakeTimers();
    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    jest.useRealTimers();

    // Carried with a real budget, not dead-lettered.
    expect(_g.__notesTest.store['miden-note-import-deadletter']).toBeUndefined();
    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0].firstFailureAt).toBeGreaterThan(1000);
  });

  it('stops STARTING imports once the pass has spent its slice of the hold ceiling (#777)', async () => {
    // The 2-minute ceiling bounds the whole loop, not one import, so a backlog too
    // large to drain inside it was evicted on EVERY lap — and each of those evictions
    // poisons the client and counts a realm eviction, which is what arms the idle-sync
    // fuse. A backlog is exactly what the 24h transient budget is designed to let
    // accumulate across an outage, so this is the ordinary shape of a recovery, not a
    // pathological one.
    _g.__notesTest.store['miden-notes-pending-import'] = ['aGVsbG8=', 'd29ybGQ=', 'YnllZQ=='];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockImplementation(async () => {
      // One slow import spends the whole per-pass budget.
      jest.advanceTimersByTime(61_000);
    });

    jest.useFakeTimers();
    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;
    jest.useRealTimers();

    // The first import landed and dropped out; the rest are carried UNTOUCHED, in the
    // legacy bare-string form that says nothing was spent on them. Carried, not
    // dropped: a `break` would leave them out of the commit, which deletes bytes that
    // may be the only copy of the funds they carry.
    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual(['d29ybGQ=', 'YnllZQ==']);
  });

  it('dead-letters rather than carrying a note whose transient budget is spent, when the hold is evicted (#777)', async () => {
    // Evictions are read as transient, so the 24h wall-clock budget is what ends
    // the carry — the note is never silently dropped, it lands in the dead-letter
    // store where it stays recoverable.
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 9, firstFailureAt: longAgo }];
    const release = parkedImport();
    _g.__notesTest.evictNextHold = true;

    await expect(importAllNotes()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    const deadletter = _g.__notesTest.store['miden-note-import-deadletter'];
    expect(deadletter).toHaveLength(1);
    expect(deadletter[0]).toMatchObject({ bytes: 'aGVsbG8=', reason: 'transport', attempts: 10 });

    release();
    await _g.__notesTest.abandonedHold;
  });

  it('keeps carrying a note whose dead-letter write did not land (#777)', async () => {
    // `addToNoteDeadletter` is defensive by design and swallows its own storage
    // failure. Reporting success anyway meant a full quota took the bytes out of
    // BOTH stores at once — the silent fund loss this queue exists to prevent.
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 9, firstFailureAt: longAgo }];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('Failed to fetch'));
    _g.__notesTest.beforeSet = async (items: Record<string, unknown>) => {
      if ('miden-note-import-deadletter' in items) throw new Error('QuotaExceededError');
    };
    jest.useFakeTimers();

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    expect(_g.__notesTest.store['miden-note-import-deadletter']).toBeUndefined();
    // Carried, and BACKOFF-STAMPED. `giveUp` is permanently true for this note now,
    // so a bare carry would be eligible on every later pass and re-run a full import
    // plus dead-letter round trip every lap, forever.
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([
      { bytes: 'aGVsbG8=', attempts: 10, firstFailureAt: longAgo, nextEligibleAt: expect.any(Number) }
    ]);
    // Pinned near the curve's CEILING, not merely "some future number": the store
    // being full or unwritable changes on a timescale of minutes, and a stamp of
    // `now + 3s` would satisfy a bare "in the future" assertion while still re-running
    // the round trip on the very next lap.
    const carried = _g.__notesTest.store['miden-notes-pending-import'][0];
    expect(carried.nextEligibleAt).toBeGreaterThanOrEqual(Date.now() + BACKOFF_MAX_MS - 5_000);
    jest.useRealTimers();
  });

  it('backoff-stamps a note whose dead-letter write did not land on the EVICTION path too (#777)', async () => {
    // The eviction-banking half of the same hot loop. Its give-up is a separate code
    // path from the per-note one above, and an unstamped carry there is eligible on
    // every later pass with `giveUp` permanently true — so the note re-enters the same
    // parked hold each lap and pays another two-minute WASM-lock eviction, forever,
    // which is the whole app's WASM access on mobile.
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 9, firstFailureAt: longAgo }];
    _g.__notesTest.beforeSet = async (items: Record<string, unknown>) => {
      if ('miden-note-import-deadletter' in items) throw new Error('QuotaExceededError');
    };
    const release = parkedImport();
    _g.__notesTest.evictNextHold = true;

    await expect(importAllNotes()).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    expect(_g.__notesTest.store['miden-note-import-deadletter']).toBeUndefined();
    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'aGVsbG8=', attempts: 10 });
    expect(queue[0].nextEligibleAt).toBeGreaterThanOrEqual(Date.now() + BACKOFF_MAX_MS - 5_000);

    // One note, so the abandoned callback has no next iteration to be stopped at: it
    // finishes and its commit is refused by the pass guard instead.
    release();
    await _g.__notesTest.abandonedHold;
  });

  it('does not re-import a note the pass already imported when the hold is then evicted (#777)', async () => {
    // Banking the whole snapshot minus the in-flight note re-queued notes that had
    // ALREADY landed. A re-import is only recognised as done once the note has been
    // consumed, so before that every classification that is not "done" spends an
    // attempt — three laps of which dead-letters a perfectly good note as
    // `malformed`, burning the one signal the dead-letter store exists to raise.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ==', 'Yg=='];
    let release!: () => void;
    const parked = new Promise<void>(resolve => {
      release = resolve;
    });
    // First note imports; the second parks and is the one the eviction interrupts.
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => parked);
    let evict!: () => void;
    _g.__notesTest.evictNextHold = new Promise<void>(resolve => {
      evict = resolve;
    });

    const pass = importAllNotes();
    // Let the loop import the first note and park on the second before the ceiling
    // expires — the state a real watchdog eviction finds it in.
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    evict();
    await expect(pass).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    // Only the interrupted note is carried. The imported one is gone for good.
    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'Yg==', attempts: 1 });

    release();
    await _g.__notesTest.abandonedHold;
  });

  it('keeps the poison count a note earned earlier in the same pass when the hold is evicted (#777)', async () => {
    // The tear-down used to rebuild the queue from the PRE-PASS snapshot, discarding
    // every decision the loop had already made. A poison note therefore went back with
    // its counter at zero, so `POISON_MAX_ATTEMPTS` could never cap it: with any parked
    // import later in the same snapshot, the pass is torn down every lap and the note
    // that will never import is retried forever instead of dead-lettering.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ==', 'Yg=='];
    let release!: () => void;
    const parked = new Promise<void>(resolve => {
      release = resolve;
    });
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes
      .mockImplementationOnce(async () => {
        throw new Error('malformed note bytes');
      })
      .mockImplementationOnce(async () => parked);
    let evict!: () => void;
    _g.__notesTest.evictNextHold = new Promise<void>(resolve => {
      evict = resolve;
    });

    const pass = importAllNotes();
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    evict();
    await expect(pass).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(2);
    // The poison verdict survives: one strike spent, and promptly retryable (no
    // backoff) so it reaches the cap fast.
    expect(queue[0]).toMatchObject({ bytes: 'YQ==', attempts: 1, poisonAttempts: 1 });
    expect(queue[0].nextEligibleAt).toBeUndefined();
    // And the interrupted note is charged a transient attempt, not a poison one.
    expect(queue[1]).toMatchObject({ bytes: 'Yg==', attempts: 1 });
    expect(queue[1].poisonAttempts ?? 0).toBe(0);

    release();
    await _g.__notesTest.abandonedHold;
  });

  it('treats an already-consumed note as landed when banking an eviction (#777)', async () => {
    // The other half of the same rule. A note the client refuses because it has
    // already been CONSUMED is done — its funds are claimed — so the banking path
    // must drop it exactly like a successful import. Re-queued, it comes back every
    // lap as something to classify, and every classification that is not "done"
    // spends an attempt against the poison cap.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ==', 'Yg=='];
    let release!: () => void;
    const parked = new Promise<void>(resolve => {
      release = resolve;
    });
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes
      .mockImplementationOnce(async () => {
        throw new Error('note has already been consumed');
      })
      .mockImplementationOnce(async () => parked);
    let evict!: () => void;
    _g.__notesTest.evictNextHold = new Promise<void>(resolve => {
      evict = resolve;
    });

    const pass = importAllNotes();
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    evict();
    await expect(pass).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'Yg==', attempts: 1 });

    release();
    await _g.__notesTest.abandonedHold;
  });

  it('does not spend the poison cap on a note whose failures were transient (#777)', async () => {
    // The cap exists to tolerate MISCLASSIFICATION: a couple of prompt retries before
    // a note is declared unimportable. Keyed off the shared `attempts` counter it was
    // already exhausted by a transient outage (or by watchdog evictions, which are
    // transient by the repo-wide poison rule), so the FIRST error the classifier did
    // not recognise dead-lettered a live note as `malformed` with no grace at all —
    // and `malformed` is the verdict that stops the transport budget's retries.
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 9 }];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('NoteFile deserialization failed'));

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    expect(_g.__notesTest.store['miden-note-import-deadletter']).toBeUndefined();
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([
      { bytes: 'aGVsbG8=', attempts: 10, poisonAttempts: 1, firstFailureAt: expect.any(Number) }
    ]);
    jest.useRealTimers();
  });

  it('still dead-letters a note that fails as poison three times (#777)', async () => {
    // The other side of that split: the cap must still fire on its own counter, or a
    // genuinely unparseable note re-throws every lap and jams the queue behind it.
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'aGVsbG8=', attempts: 2, poisonAttempts: 2 }];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('NoteFile deserialization failed'));

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    expect(_g.__notesTest.store['miden-note-import-deadletter']).toEqual([
      { bytes: 'aGVsbG8=', reason: 'malformed', failedAt: expect.any(Number), attempts: 3 }
    ]);
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    jest.useRealTimers();
  });

  it('does not strand a note whose counters came back corrupt (#777)', async () => {
    // Storage hands these back unvalidated. A string `attempts` turns every `+ 1` into
    // string concatenation, and a NaN `nextEligibleAt` fails BOTH eligibility
    // comparisons — never due, never past the clamp — so the note sat in the queue
    // forever: never imported, never dead-lettered, no signal that anything was wrong.
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = [
      { bytes: 'aGVsbG8=', attempts: '3', nextEligibleAt: Number.NaN, firstFailureAt: null }
    ];

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    jest.useRealTimers();
  });

  it('does not strand a note whose backoff stamp came from a jumped clock (#777)', async () => {
    // `nextEligibleAt` is wall-clock, so a device whose RTC is wrong until NTP
    // settles can stamp a deadline days out. Uncapped, that note is never eligible
    // again AND never expires (its elapsed budget goes negative), so it is carried
    // forever: not imported, not dead-lettered, no signal. Anything beyond the
    // curve's own maximum is therefore treated as due now.
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = [
      { bytes: 'aGVsbG8=', attempts: 1, nextEligibleAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }
    ];

    const p = importAllNotes();
    await jest.advanceTimersByTimeAsync(2100);
    await p;

    expect(_g.__notesTest.midenClient.importNoteBytes).toHaveBeenCalledTimes(1);
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([]);
    jest.useRealTimers();
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

  it('clamps a corrupt counter so the poison cap can still be reached (#777)', async () => {
    // `finiteOr` accepted every finite number, and a negative one defeats the cap it
    // feeds: `-1e308 + 1` is still `-1e308` in IEEE-754, so `poisonAttempts >= 3`
    // never becomes true and a note the wallet cannot parse is retried forever — the
    // brick the cap exists to prevent, reachable from one corrupt storage value.
    _g.__notesTest.store['miden-notes-pending-import'] = [{ bytes: 'YQ==', attempts: -5, poisonAttempts: -1e308 }];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockRejectedValue(new Error('malformed note bytes'));

    await importAllNotes();

    const queue = _g.__notesTest.store['miden-notes-pending-import'];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bytes: 'YQ==', attempts: 1, poisonAttempts: 1 });
  });

  it('rewrites the queue even when the commit-time read comes back without its array (#777)', async () => {
    // `filter` on a raw non-array THREW here — inside the queue lock and inside the
    // pass's try, so the pass reported a failure it had not had and every later pass
    // repeated it, with nothing draining.
    _g.__notesTest.store['miden-notes-pending-import'] = ['YQ=='];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.importNoteBytes.mockImplementation(async () => {
      // The adapter loses the array while the import is in flight.
      _g.__notesTest.store['miden-notes-pending-import'] = { bytes: 'Yg==', attempts: 1 };
    });

    await importAllNotes();

    // The imported note is gone and the salvaged entry survived the rewrite.
    expect(_g.__notesTest.store['miden-notes-pending-import']).toEqual([{ bytes: 'Yg==', attempts: 1 }]);
  });

  it('skips the trailing sleep and sync when the pass imported nothing (#777)', async () => {
    // The tail exists to surface notes this pass imported. A queue that is entirely
    // backed off still paid its 2s sleep plus a full sync hold on every lap of the
    // caller's loop — once a second on mobile — for a sync with nothing to surface.
    jest.useFakeTimers();
    _g.__notesTest.store['miden-notes-pending-import'] = [
      { bytes: 'YQ==', attempts: 1, firstFailureAt: Date.now(), nextEligibleAt: Date.now() + 60_000 }
    ];
    _g.__notesTest.midenClient.importNoteBytes.mockReset();
    _g.__notesTest.midenClient.syncState.mockReset();
    _g.__notesTest.midenClient.syncState.mockResolvedValue(undefined);

    // Resolves without the timers being advanced at all: no sleep was scheduled.
    await expect(importAllNotes()).resolves.toBeUndefined();
    expect(_g.__notesTest.midenClient.importNoteBytes).not.toHaveBeenCalled();
    expect(_g.__notesTest.midenClient.syncState).not.toHaveBeenCalled();

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
