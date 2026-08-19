import {
  __flushProveTelemetryForTest,
  __resetProveTelemetryForTest,
  getProveTelemetry,
  recordProveTelemetry,
  SLOW_PROVE_THRESHOLD_MS,
  type ProveTelemetryEntry
} from './prove-telemetry';

const mockIsMobile = jest.fn(() => false);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

describe('prove-telemetry (#466)', () => {
  beforeEach(() => {
    __resetProveTelemetryForTest();
    mockIsMobile.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  it('records a prove sample into the ring with platform + rounded duration', () => {
    const entry = recordProveTelemetry({ path: 'delegate', durationMs: 1234.7, fellBack: false });
    expect(entry?.path).toBe('delegate');
    expect(entry?.durationMs).toBe(1235);
    expect(entry?.platform).toBe('desktop');
    expect(entry?.fellBack).toBe(false);
    expect(entry?.slow).toBe(false);
    expect(getProveTelemetry()).toHaveLength(1);
  });

  it('flags slow proves (> threshold) and warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = recordProveTelemetry({ path: 'local', durationMs: SLOW_PROVE_THRESHOLD_MS + 1, fellBack: false });
    expect(entry?.slow).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slow prove'));
  });

  it('does not flag a prove at exactly the threshold as slow', () => {
    const entry = recordProveTelemetry({ path: 'local', durationMs: SLOW_PROVE_THRESHOLD_MS, fellBack: false });
    expect(entry?.slow).toBe(false);
  });

  it('captures the remote portion + combined wall time on a delegate->local fallback', () => {
    const entry = recordProveTelemetry({
      path: 'local',
      durationMs: 9000,
      fellBack: true,
      remoteDurationMs: 6000
    });
    expect(entry?.fellBack).toBe(true);
    expect(entry?.remoteDurationMs).toBe(6000);
    expect(entry?.durationMs).toBe(9000);
  });

  it('marks the platform mobile when isMobile()', () => {
    mockIsMobile.mockReturnValue(true);
    expect(recordProveTelemetry({ path: 'native-mobile', durationMs: 10, fellBack: false })?.platform).toBe('mobile');
  });

  it('records a failed double-failure prove (remote + local both failed)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = recordProveTelemetry({
      path: 'local',
      durationMs: SLOW_PROVE_THRESHOLD_MS + 5000,
      fellBack: true,
      remoteDurationMs: 20000,
      failed: true
    });
    expect(entry?.failed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FAILED'));
  });

  it('never throws or slows a prove — a throw inside is swallowed (returns undefined)', () => {
    // Force the console.warn on the slow path to throw; recordProveTelemetry
    // must swallow it (it runs on the hot proving path).
    jest.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger blew up');
    });
    let result: unknown;
    expect(() => {
      result = recordProveTelemetry({ path: 'local', durationMs: SLOW_PROVE_THRESHOLD_MS + 1, fellBack: false });
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it('bounds the ring (drops the oldest beyond capacity)', () => {
    for (let i = 0; i < 60; i++) recordProveTelemetry({ path: 'local', durationMs: i, fellBack: false });
    const ring = getProveTelemetry();
    expect(ring).toHaveLength(50);
    // oldest 10 dropped → first retained sample is durationMs 10, newest is 59
    expect(ring[0]?.durationMs).toBe(10);
    expect(ring[ring.length - 1]?.durationMs).toBe(59);
  });
});

/**
 * The ring is module-scoped — PER REALM — while the `chrome.storage.local` copy is
 * ONE shared key, and that key outlives both the realm and the routing decision that
 * picks it: flag-on (`MIDEN_USE_OFFSCREEN_CLIENT`) every recording prove is
 * dispatched into the offscreen document, flag-off — or on a browser with no
 * `chrome.offscreen` — the same proves run inline in the service worker, and an
 * extension update or a flag flip moves the writer without touching the key. A blind
 * whole-ring write therefore discarded the accumulated history across every such
 * change, and would erase a second realm's samples outright the moment any prove is
 * added back service-worker side. `persist()` merges instead.
 */
describe('prove-telemetry — merged persistence across realms (issue #260)', () => {
  const STORAGE_KEY = 'miden_prove_telemetry';
  const G = globalThis as unknown as {
    chrome?: unknown;
    __MIDEN_IN_OFFSCREEN_DOC__?: boolean;
  };

  /** An entry as some OTHER realm would have written it — the thing a blind write
   * used to destroy. */
  const foreignEntry = (overrides: Partial<ProveTelemetryEntry> = {}): ProveTelemetryEntry => ({
    ts: 1_000,
    path: 'local',
    durationMs: 4321,
    fellBack: false,
    platform: 'desktop',
    crossOriginIsolated: true,
    slow: false,
    realm: 'offscreen',
    ...overrides
  });

  /** A `chrome.storage.local` double whose contents are readable per test. `calls`
   * records the read/write SEQUENCE, which is what shows whether two read-merge-write
   * cycles ran one after the other or interleaved. */
  function installStorage(seed: unknown = undefined) {
    const store: Record<string, unknown> = seed === undefined ? {} : { [STORAGE_KEY]: seed };
    const calls: string[] = [];
    const get = jest.fn(async (key: string) => {
      calls.push('get');
      return key in store ? { [key]: store[key] } : {};
    });
    const set = jest.fn(async (items: Record<string, unknown>) => {
      calls.push('set');
      Object.assign(store, items);
    });
    G.chrome = { storage: { local: { get, set } } };
    return {
      get,
      set,
      calls,
      written: () => store[STORAGE_KEY] as ProveTelemetryEntry[] | undefined
    };
  }

  beforeEach(() => {
    // Sibling describe — the outer beforeEach does not run for these, and both the
    // ring and the `Date.now` spy are module/global state the previous suite left set.
    __resetProveTelemetryForTest();
    mockIsMobile.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  afterEach(() => {
    delete G.chrome;
    delete G.__MIDEN_IN_OFFSCREEN_DOC__;
  });

  it('merges the other realm’s stored entries with this realm’s ring instead of overwriting them', async () => {
    const storage = installStorage([foreignEntry()]);

    jest.spyOn(Date, 'now').mockReturnValue(2_000);
    recordProveTelemetry({ path: 'delegate', durationMs: 100, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(storage.get).toHaveBeenCalledWith(STORAGE_KEY);
    // Both survive, oldest first — the offscreen realm's sample is not erased by an
    // SW-side prove (nor the reverse).
    expect(storage.written()?.map(e => [e.ts, e.realm, e.durationMs])).toEqual([
      [1_000, 'offscreen', 4321],
      [2_000, 'inline', 100]
    ]);
  });

  it('de-duplicates: this realm’s own entries are read back every persist and must not accumulate', async () => {
    const storage = installStorage();

    jest.spyOn(Date, 'now').mockReturnValue(3_000);
    recordProveTelemetry({ path: 'local', durationMs: 50, fellBack: false });
    await __flushProveTelemetryForTest();
    // A SECOND persist re-reads the entry it just wrote and re-merges it with the
    // still-present ring copy.
    jest.spyOn(Date, 'now').mockReturnValue(4_000);
    recordProveTelemetry({ path: 'local', durationMs: 60, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(storage.written()).toHaveLength(2);
    expect(storage.written()?.map(e => e.durationMs)).toEqual([50, 60]);
  });

  it('sorts the union by timestamp and keeps only the newest RING_CAPACITY', async () => {
    // 50 stored entries from another realm, all OLDER than the one recorded here:
    // the union is 51, so exactly one — the oldest — must fall off the end.
    const stored = Array.from({ length: 50 }, (_, i) => foreignEntry({ ts: 100 + i, durationMs: i }));
    const storage = installStorage(stored);

    jest.spyOn(Date, 'now').mockReturnValue(9_999);
    recordProveTelemetry({ path: 'local', durationMs: 777, fellBack: false });
    await __flushProveTelemetryForTest();

    const written = storage.written()!;
    expect(written).toHaveLength(50);
    expect(written[0]?.ts).toBe(101); // ts 100 evicted as the oldest
    expect(written[written.length - 1]).toMatchObject({ ts: 9_999, durationMs: 777, realm: 'inline' });
  });

  // The mirror image of the test above, and the shape the cross-realm case actually
  // takes: the STORED entries are NEWER than this realm's ring — the service worker
  // records one guardian-requeue prove while the offscreen realm already has a full
  // ring of fresher samples under the key (a flag flip or an extension update leaves
  // the same shape behind). Insertion order and timestamp order then DISAGREE, which
  // is what makes the sort load-bearing: `slice(-RING_CAPACITY)` keeps the tail, so
  // without it the union's tail is this realm's stale entry and the newest foreign
  // sample is the one evicted. The test above cannot see that — its fixture is
  // already ascending in insertion order, so truncation alone reproduces it.
  it('keeps the newest entries when the stored ones are newer than this realm’s ring', async () => {
    const storage = installStorage(
      Array.from({ length: 50 }, (_, i) => foreignEntry({ ts: 1_000 + i, durationMs: i }))
    );

    jest.spyOn(Date, 'now').mockReturnValue(5);
    recordProveTelemetry({ path: 'local', durationMs: 777, fellBack: false });
    await __flushProveTelemetryForTest();

    // All 50 foreign entries survive; the one local entry — the oldest in the union
    // despite being appended last — is the one that falls off.
    expect(storage.written()?.map(e => e.ts)).toEqual(Array.from({ length: 50 }, (_, i) => 1_000 + i));
  });

  // One case per clause of `isProveTelemetryEntry`. A malformed entry that survived
  // the filter would be written straight back out on every subsequent persist, so it
  // corrupts the record permanently rather than for one read — which is why the guard
  // has to be exercised clause by clause, not just at its edges.
  it('drops malformed stored values rather than writing them back out', async () => {
    /** A well-formed foreign entry with exactly ONE field broken. The `ts` argument
     * labels the case, so a clause that stopped rejecting shows up in the
     * surviving-ts assertion as an extra, identifiable value. */
    const broken = (ts: number, overrides: Record<string, unknown>) => ({ ...foreignEntry({ ts }), ...overrides });

    const storage = installStorage([
      foreignEntry({ ts: 10 }),
      null,
      'not an entry',
      42,
      broken(11, { ts: 'nope' }),
      broken(12, { path: 'quantum' }),
      broken(13, { durationMs: '1' }),
      broken(14, { fellBack: 'false' }),
      broken(15, { remoteDurationMs: 'soon' }),
      broken(16, { platform: 'toaster' }),
      broken(17, { crossOriginIsolated: 1 }),
      broken(18, { slow: 'no' }),
      broken(19, { failed: 'yes' }),
      broken(20, { realm: 'mars' }),
      // The other failure mode of a shape guard: rejecting entries that ARE valid.
      // Both optional fields present and well-typed must survive.
      foreignEntry({ ts: 21, remoteDurationMs: 900, failed: true })
    ]);

    jest.spyOn(Date, 'now').mockReturnValue(40);
    recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(storage.written()?.map(e => e.ts)).toEqual([10, 21, 40]);
  });

  // The stored value under the key is untyped input: something else may hold it (a
  // hand edit, a future build, a name collision). A non-array must degrade to "this
  // realm's ring only", not throw into the best-effort catch — which would silently
  // stop persisting telemetry for as long as that value sat there.
  it('ignores a stored value that is not an array and still writes this realm’s ring', async () => {
    for (const notAnArray of [{ nope: true }, 'a string', 7]) {
      __resetProveTelemetryForTest();
      const storage = installStorage(notAnArray);

      jest.spyOn(Date, 'now').mockReturnValue(60);
      recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });
      await __flushProveTelemetryForTest();

      expect(storage.written()?.map(e => e.ts)).toEqual([60]);
    }
  });

  it('accepts a legacy stored entry that predates the `realm` field', async () => {
    const { realm: _dropped, ...legacy } = foreignEntry({ ts: 7 });
    const storage = installStorage([legacy]);

    jest.spyOn(Date, 'now').mockReturnValue(8);
    recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(storage.written()?.map(e => [e.ts, e.realm])).toEqual([
      [7, undefined],
      [8, 'inline']
    ]);
  });

  it('tags the recording realm — `offscreen` inside the offscreen document', async () => {
    const storage = installStorage();
    G.__MIDEN_IN_OFFSCREEN_DOC__ = true;

    const entry = recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(entry?.realm).toBe('offscreen');
    expect(storage.written()?.[0]?.realm).toBe('offscreen');
  });

  // Regression guard for the import path, not the logic. The realm tag lives in
  // `back/offscreen-realm`, deliberately NOT in `back/offscreen-prover`: the prover
  // module is the chrome.offscreen lifecycle surface that several suites replace with
  // a small partial factory, and importing the tag from there resolved it to
  // `undefined` in those registries — the call then threw into `recordProveTelemetry`'s
  // best-effort catch and the whole function became a silent no-op. Nothing failed to
  // say so, which is what made it worth pinning: a test written against
  // `proveWithFallback`'s telemetry would have been asserting on a permanently empty
  // ring.
  it('still records when a suite replaces `offscreen-prover` with a partial mock', async () => {
    jest.resetModules();
    jest.doMock('lib/miden/back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }));
    try {
      const mod = await import('./prove-telemetry');
      const entry = mod.recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });

      expect(entry).toBeDefined();
      expect(entry?.realm).toBe('inline');
      expect(mod.getProveTelemetry()).toHaveLength(1);
    } finally {
      jest.dontMock('lib/miden/back/offscreen-prover');
      jest.resetModules();
    }
  });

  it('degrades to writing just this realm’s ring when the storage area exposes no get', async () => {
    const set = jest.fn(async () => {});
    G.chrome = { storage: { local: { set } } };

    recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(set).toHaveBeenCalledWith({ [STORAGE_KEY]: getProveTelemetry() });
  });

  // The read and the write fail independently, and only the read is optional. A
  // rejecting `get` — `chrome.storage.local` rejects with "Extension context
  // invalidated." after the extension is updated or reloaded, and can fail on an IO
  // error — must degrade to the pre-merge behaviour (write this realm's ring), NOT to
  // writing nothing: the storage copy exists so a service-worker restart doesn't lose
  // the ring, so the realms least likely to survive are the ones that most need the
  // write to happen. The sibling below rejects BOTH, so it cannot tell those two
  // outcomes apart.
  it('still writes this realm’s ring when the READ throws (a failed read must not skip the write)', async () => {
    const set = jest.fn(async () => {});
    G.chrome = {
      storage: {
        local: {
          get: jest.fn(async () => {
            throw new Error('Extension context invalidated');
          }),
          set
        }
      }
    };

    recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(set).toHaveBeenCalledWith({ [STORAGE_KEY]: getProveTelemetry() });
  });

  it('never lets a storage failure reach the prove (get or set rejecting is swallowed)', async () => {
    G.chrome = {
      storage: {
        local: {
          get: jest.fn(async () => {
            throw new Error('storage exploded');
          }),
          set: jest.fn(async () => {
            throw new Error('quota exceeded');
          })
        }
      }
    };

    expect(() => recordProveTelemetry({ path: 'local', durationMs: 5, fellBack: false })).not.toThrow();
    await expect(__flushProveTelemetryForTest()).resolves.toBeUndefined();
    // The in-memory ring is unaffected by the failed mirror.
    expect(getProveTelemetry()).toHaveLength(1);
  });

  // Two realms proving in the same millisecond are distinct samples, not a
  // duplicate — the recording realm is part of an entry's identity.
  it('keeps same-timestamp entries from different realms as two entries', async () => {
    const storage = installStorage([foreignEntry({ ts: 500, durationMs: 4321 })]);

    jest.spyOn(Date, 'now').mockReturnValue(500);
    recordProveTelemetry({ path: 'local', durationMs: 4321, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(storage.written()?.map(e => e.realm)).toEqual(['offscreen', 'inline']);
  });

  // Within a realm the shared ring already carries both samples, so an interleaved
  // pair cannot lose one HERE. It matters against the OTHER realm: a cycle that read
  // before a foreign write landed must not `set` its stale merge after a later cycle
  // that did see it. Chaining keeps each cycle's read as fresh as possible and makes
  // the last write the last-read one.
  it('runs its read-merge-write cycles one at a time (get/set never interleave)', async () => {
    const storage = installStorage();

    jest.spyOn(Date, 'now').mockReturnValue(11);
    recordProveTelemetry({ path: 'local', durationMs: 1, fellBack: false });
    jest.spyOn(Date, 'now').mockReturnValue(12);
    recordProveTelemetry({ path: 'local', durationMs: 2, fellBack: false });
    await __flushProveTelemetryForTest();

    expect(storage.calls).toEqual(['get', 'set', 'get', 'set']);
    expect(storage.written()?.map(e => e.ts)).toEqual([11, 12]);
  });
});
