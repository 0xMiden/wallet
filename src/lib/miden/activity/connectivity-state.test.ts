/* eslint-disable import/first */

// Minimal in-memory storage stub so the mirror-to-storage path doesn't blow
// up in jest (no chrome / no Capacitor).
const _g = globalThis as any;
_g.__connStateStore = {} as Record<string, any>;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys)
        if (k in (globalThis as any).__connStateStore) {
          out[k] = (globalThis as any).__connStateStore[k];
        }
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__connStateStore, items);
    }
  })
}));

import {
  CONNECTIVITY_CATEGORIES,
  CONNECTIVITY_STATE_KEY,
  applyConnectivityReport,
  clearConnectivityIssue,
  clearReachabilityIssues,
  ConnectivityCategory,
  getConnectivityState,
  hydrateConnectivityState,
  markConnectivityIssue,
  resetConnectivityState,
  setConnectivityReporter,
  subscribeConnectivityState
} from './connectivity-state';

// `Reflect.ownKeys`, not `Object.keys`: a test that installs a NON-ENUMERABLE
// property on the store (the throwing-getter case below defines one) would otherwise
// survive every sweep, and the storage stub's `Object.assign` would then throw on the
// next mirror write — turning one test's fixture into a spurious failure in every
// test after it.
const clearStore = () => {
  for (const k of Reflect.ownKeys(_g.__connStateStore)) delete _g.__connStateStore[k];
};

beforeEach(() => {
  clearStore();
  // The reporter is module state: a test that installs one must not leak it into
  // the next (which would silently turn every writer assertion into a no-op).
  setConnectivityReporter(null);
  resetConnectivityState();
});

describe('connectivity-state', () => {
  it('starts with every category cleared', () => {
    const snap = getConnectivityState();
    for (const cat of CONNECTIVITY_CATEGORIES) {
      expect(snap[cat]).toEqual({ active: false, since: null });
    }
  });

  it('marks a category active and stamps `since`', () => {
    const before = Date.now();
    markConnectivityIssue('prover');
    const snap = getConnectivityState();
    expect(snap.prover.active).toBe(true);
    expect(snap.prover.since).toBeGreaterThanOrEqual(before);
    // Other categories untouched.
    expect(snap.network.active).toBe(false);
    expect(snap.node.active).toBe(false);
  });

  it('marking an already-active category is a no-op (does not reset `since`)', async () => {
    markConnectivityIssue('node');
    const firstSince = getConnectivityState().node.since!;
    // Wait a tick to ensure Date.now() would advance.
    await new Promise(r => setTimeout(r, 5));
    markConnectivityIssue('node');
    expect(getConnectivityState().node.since).toBe(firstSince);
  });

  it('clears a single category without touching others', () => {
    markConnectivityIssue('node');
    markConnectivityIssue('prover');
    clearConnectivityIssue('prover');
    const snap = getConnectivityState();
    expect(snap.node.active).toBe(true);
    expect(snap.prover.active).toBe(false);
  });

  it('clearReachabilityIssues clears network/node/resolving but preserves prover', () => {
    markConnectivityIssue('network');
    markConnectivityIssue('node');
    markConnectivityIssue('resolving');
    markConnectivityIssue('prover');
    clearReachabilityIssues();
    const snap = getConnectivityState();
    expect(snap.network.active).toBe(false);
    expect(snap.node.active).toBe(false);
    expect(snap.resolving.active).toBe(false);
    expect(snap.prover.active).toBe(true);
  });

  it('notifies subscribers on every transition', () => {
    const fn = jest.fn();
    const unsub = subscribeConnectivityState(fn);
    markConnectivityIssue('prover');
    markConnectivityIssue('node');
    clearConnectivityIssue('prover');
    expect(fn).toHaveBeenCalledTimes(3);
    unsub();
    markConnectivityIssue('network');
    expect(fn).toHaveBeenCalledTimes(3); // unsub took effect
  });

  it('snapshots are defensive copies (subscribers cannot mutate module state)', () => {
    let received: ReturnType<typeof getConnectivityState> | null = null;
    const unsub = subscribeConnectivityState(snap => {
      received = snap;
    });
    markConnectivityIssue('prover');
    expect(received).not.toBeNull();
    received!.prover.active = false;
    // Module state should still report active.
    expect(getConnectivityState().prover.active).toBe(true);
    unsub();
  });

  it('mirrors snapshot to chrome.storage on each transition', async () => {
    markConnectivityIssue('node');
    // Yield so the fire-and-forget putToStorage promise resolves.
    await new Promise(r => setTimeout(r, 0));
    const stored = _g.__connStateStore[CONNECTIVITY_STATE_KEY];
    expect(stored).toBeDefined();
    expect(stored.node.active).toBe(true);
  });

  it('subscriber that throws does not block other subscribers', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const good = jest.fn();
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const unsubA = subscribeConnectivityState(bad);
    const unsubB = subscribeConnectivityState(good);
    markConnectivityIssue('prover' as ConnectivityCategory);
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    warnSpy.mockRestore();
    unsubA();
    unsubB();
  });
});

/**
 * A realm that does NOT own the snapshot (the extension's offscreen document)
 * reports its observations to the realm that does, instead of blind-writing the
 * whole snapshot to the one shared storage key — which is what let an offscreen
 * prover SUCCESS clear the service worker's real "node unreachable" banner.
 */
describe('connectivity-state — reporting realm (issue #260 single writer)', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  // The outer beforeEach's `resetConnectivityState()` mirrors an empty snapshot
  // to storage FIRE-AND-FORGET, so that write lands after the store was cleared.
  // Let it settle and clear again, so "storage was never written" below means the
  // reporting realm wrote it, not the reset.
  beforeEach(async () => {
    await flush();
    clearStore();
  });

  it('forwards a mark to the reporter and writes NEITHER local state NOR storage', async () => {
    const reporter = jest.fn();
    setConnectivityReporter(reporter);

    markConnectivityIssue('prover');
    await flush();

    expect(reporter).toHaveBeenCalledWith('prover', true);
    // The whole point: this realm's snapshot never reaches the shared key, so it
    // cannot overwrite the categories the owning realm knows about.
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY]).toBeUndefined();
    expect(getConnectivityState().prover.active).toBe(false);
  });

  it('forwards a clear as `active: false`', async () => {
    const reporter = jest.fn();
    setConnectivityReporter(reporter);

    clearConnectivityIssue('prover');
    await flush();

    expect(reporter).toHaveBeenCalledWith('prover', false);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY]).toBeUndefined();
  });

  // The sending half of the drop-safety property. Cross-realm delivery is
  // fire-and-forget: if a reporting realm de-duplicated locally, ONE lost clear
  // would be followed by locally-suppressed repeats and the banner would stay
  // latched active — permanently, since nothing would ever re-send. Re-sending the
  // observed value rather than a delta is what makes a lost event cost staleness until
  // the next report of the same kind instead (for `prover` that is the next
  // first-attempt-successful prove, or the next delegated network failure — see
  // `setConnectivityReporter`). (The receiving half is `applyConnectivityReport`,
  // covered by its own describe below and by back/main.test.ts.)
  it('re-sends on EVERY call — a reporting realm does no local de-duplication', async () => {
    const reporter = jest.fn();
    setConnectivityReporter(reporter);

    markConnectivityIssue('prover');
    markConnectivityIssue('prover');
    clearConnectivityIssue('prover');
    clearConnectivityIssue('prover');
    await flush();

    expect(reporter.mock.calls).toEqual([
      ['prover', true],
      ['prover', true],
      ['prover', false],
      ['prover', false]
    ]);
  });

  it('forwards clearReachabilityIssues as three clears and never touches prover', async () => {
    const reporter = jest.fn();
    setConnectivityReporter(reporter);

    clearReachabilityIssues();
    await flush();

    expect(reporter.mock.calls).toEqual([
      ['network', false],
      ['node', false],
      ['resolving', false]
    ]);
  });

  // These mutators run inside `proveWithFallback`'s success/failure handlers, so a
  // throw here would be read as a prove failure — a funds-path consequence for a
  // banner update.
  it('swallows a reporter that throws (a mark must never fail a prove)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    setConnectivityReporter(() => {
      throw new Error('port closed');
    });

    expect(() => markConnectivityIssue('prover')).not.toThrow();
    expect(() => clearConnectivityIssue('prover')).not.toThrow();
    expect(() => clearReachabilityIssues()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith('[connectivity-state] reporter threw:', expect.any(Error));
    warnSpy.mockRestore();
  });

  // The single-writer invariant has to hold for EVERY mutator, not just the three
  // that forward. `resetConnectivityState` has no reporter branch (a local reset has
  // nothing meaningful to forward), so the gate inside `notify()` is what keeps it
  // off the shared key: without it a reporting realm blind-writes an all-clear
  // snapshot over the owning realm's live categories — the exact whole-snapshot
  // clobber this split exists to remove, and worse than the forward it rejects,
  // since it wipes all four categories at once.
  it('resetConnectivityState still notifies locally but never touches the shared key', async () => {
    setConnectivityReporter(jest.fn());
    const seen = jest.fn();
    const unsub = subscribeConnectivityState(seen);

    resetConnectivityState();
    await flush();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY]).toBeUndefined();
    unsub();
  });

  // `applyConnectivityReport` is the OWNING realm's entry point, and unlike the
  // mark/clear mutators it writes `current` before it notifies — so without its own
  // reporter branch it would leave a reporting realm holding local state that nothing
  // there reads, contradicting the invariant the rest of this module documents.
  // Unreachable today (its only caller is the SW's reverse-IPC listener), so the guard
  // exists to keep the invariant true by construction rather than by that fact holding.
  it('applyConnectivityReport is a no-op — a realm that does not own the snapshot has none to apply', async () => {
    setConnectivityReporter(jest.fn());

    applyConnectivityReport('node', true);
    await flush();

    expect(getConnectivityState().node.active).toBe(false);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY]).toBeUndefined();
  });

  it('restores local-writer behaviour when the reporter is uninstalled', async () => {
    const reporter = jest.fn();
    setConnectivityReporter(reporter);
    markConnectivityIssue('node');
    setConnectivityReporter(null);
    markConnectivityIssue('node');
    await flush();

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(getConnectivityState().node.active).toBe(true);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].node.active).toBe(true);
  });
});

/**
 * The RECEIVING half of the cross-realm contract. A reporting realm re-sends the value
 * it observes rather than a delta; that only repairs anything if the owning realm
 * writes the report THROUGH. `current` here is per-realm memory an MV3 eviction
 * resets, while the mirror the banner actually renders is durable — so the two
 * routinely disagree, and the ordinary mark/clear mutators would short-circuit on
 * "already clear", never notify, and leave the stale mirror latched forever.
 */
describe('connectivity-state — applyConnectivityReport (issue #260 drop-safety)', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(async () => {
    await flush();
    clearStore();
  });

  it('repairs a stale mirror even though this realm already believes the category clear', async () => {
    // What an evicted-and-restarted service worker wakes up to: a durable mirror
    // that still says "prover unreachable", and a fresh, empty `current`.
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = {
      network: { active: false, since: null },
      node: { active: false, since: null },
      prover: { active: true, since: 111 },
      resolving: { active: false, since: null }
    };
    expect(getConnectivityState().prover.active).toBe(false);

    applyConnectivityReport('prover', false);
    await flush();

    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].prover.active).toBe(false);
  });

  it('re-mirrors on a repeated report instead of short-circuiting on no change', async () => {
    applyConnectivityReport('node', true);
    await flush();
    // Whatever reason the mirror went missing (a failed write, a cleared profile),
    // the next report has to put it back.
    delete _g.__connStateStore[CONNECTIVITY_STATE_KEY];

    applyConnectivityReport('node', true);
    await flush();

    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY]?.node.active).toBe(true);
  });

  it('keeps `since` across a repeated active report (it is the banner dismissal key)', async () => {
    applyConnectivityReport('node', true);
    const firstSince = getConnectivityState().node.since!;
    await new Promise(r => setTimeout(r, 5));
    applyConnectivityReport('node', true);

    expect(getConnectivityState().node.since).toBe(firstSince);
  });

  it('clears `since` on a clear, and stamps a fresh one when the category re-activates', async () => {
    applyConnectivityReport('node', true);
    const firstSince = getConnectivityState().node.since!;

    applyConnectivityReport('node', false);
    expect(getConnectivityState().node.since).toBeNull();

    await new Promise(r => setTimeout(r, 5));
    applyConnectivityReport('node', true);
    expect(getConnectivityState().node.since!).toBeGreaterThan(firstSince);
  });

  it('touches only the reported category — the whole point of reporting per category', async () => {
    markConnectivityIssue('node');
    applyConnectivityReport('prover', false);
    await flush();

    expect(getConnectivityState().node.active).toBe(true);
    expect(getConnectivityState().prover.active).toBe(false);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].node.active).toBe(true);
  });
});

/**
 * `current` is per-realm memory an MV3 eviction resets; the storage mirror survives
 * and the popup renders it in preference. Left unreconciled the two disagree, and the
 * "already clear" short-circuit swallows the very clear that would repair the mirror
 * — the banner keeps showing an outage that has already recovered, with no in-app way
 * back. Hydrating is what re-arms the ordinary clear paths; blanking the mirror
 * instead would make a REAL outage's banner vanish on every wake, and node/network
 * only come back after three more consecutive sync failures while `prover` waits on
 * the user's next prove attempt.
 */
describe('connectivity-state — hydrateConnectivityState (issue #260 durability)', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const mirror = (overrides: Partial<Record<ConnectivityCategory, { active: boolean; since: number | null }>>) => ({
    network: { active: false, since: null },
    node: { active: false, since: null },
    prover: { active: false, since: null },
    resolving: { active: false, since: null },
    ...overrides
  });

  beforeEach(async () => {
    await flush();
    clearStore();
  });

  it('seeds the snapshot from the mirror, `since` included', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ node: { active: true, since: 7 } });

    await hydrateConnectivityState();

    // `since` is the banner's dismissal key (`use-connectivity-state`), so a dismissal
    // made before the restart must survive it.
    expect(getConnectivityState().node).toEqual({ active: true, since: 7 });
  });

  // The whole point: after hydration the ordinary recovery path TRANSITIONS instead of
  // short-circuiting, so it reaches notify() and repairs the mirror.
  it('re-arms the clear that repairs the mirror', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ node: { active: true, since: 7 } });

    await hydrateConnectivityState();
    clearReachabilityIssues();
    await flush();

    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].node.active).toBe(false);
  });

  it('notifies subscribers so an in-process banner re-renders', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ prover: { active: true, since: 3 } });
    const seen = jest.fn();
    const unsub = subscribeConnectivityState(seen);

    await hydrateConnectivityState();

    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ prover: { active: true, since: 3 } }));
    unsub();
  });

  it('does nothing — not even a write — when the mirror already agrees', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({});
    const seen = jest.fn();
    const unsub = subscribeConnectivityState(seen);

    await hydrateConnectivityState();
    await flush();

    expect(seen).not.toHaveBeenCalled();
    unsub();
  });

  // The read is asynchronous, so a mark or clear can land while it is in flight. A
  // fresh observation is the newer fact and must win over a pre-restart mirrored one.
  it('lets an observation made during the read win over the mirror', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ node: { active: true, since: 7 } });

    const hydrating = hydrateConnectivityState();
    clearReachabilityIssues();
    await hydrating;

    expect(getConnectivityState().node.active).toBe(false);
  });

  // ...and that observation may itself have short-circuited ("already clear") and so
  // never mirrored anything. Without this, the one case the whole function exists to
  // prevent survives inside its own load window.
  it('rewrites a mirror that a short-circuited observation left stale', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ node: { active: true, since: 7 } });

    const hydrating = hydrateConnectivityState();
    // Nothing is active locally, so this clear writes neither state nor storage.
    clearReachabilityIssues();
    await hydrating;
    await flush();

    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].node.active).toBe(false);
  });

  // ...and the observation that matters most is a cross-realm REPORT, because that is
  // the only production path that can reach this window at all. `registerOffscreenSignHandler()`
  // runs BEFORE the awaited hydrate in `back/main.ts`'s `start()`, and the offscreen
  // realm's post is often what WAKES the service worker — so hydrate's storage read is
  // issued first and `applyConnectivityReport` runs against a still-empty `current`
  // while it is in flight. (sync-manager and proveWithFallback only start after
  // `Actions.init()`, i.e. after the await.) Without the observation guard, hydration
  // resolves with the PRE-restart mirror, undoes the clear that just arrived, and
  // re-latches the banner until the user's next prove — the exact latch this whole
  // change exists to remove.
  it('lets a cross-realm REPORT that lands during the read win over the mirror', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ prover: { active: true, since: 7 } });

    const hydrating = hydrateConnectivityState();
    applyConnectivityReport('prover', false);
    await hydrating;
    await flush();

    expect(getConnectivityState().prover.active).toBe(false);
    // The mirror is what the popup renders, so repairing it is the half that matters.
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].prover.active).toBe(false);
  });

  // The same guard on the single-category mutators. `markConnectivityIssue` transitions,
  // so it mirrors on its own — but hydration running afterwards would overwrite both.
  it('lets a mark that lands during the read win over a mirror that says clear', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({});

    const hydrating = hydrateConnectivityState();
    markConnectivityIssue('node');
    await hydrating;
    await flush();

    expect(getConnectivityState().node.active).toBe(true);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].node.active).toBe(true);
  });

  // `clearConnectivityIssue` is the sharper case: nothing is active locally, so it
  // short-circuits and writes neither state nor storage — the observation is the only
  // trace it leaves. `prover` deliberately, since `clearReachabilityIssues` (covered
  // above) never touches it and it has no other clear path.
  it('honours a clear that lands during the read even though it short-circuited', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ prover: { active: true, since: 7 } });

    const hydrating = hydrateConnectivityState();
    clearConnectivityIssue('prover');
    await hydrating;
    await flush();

    expect(getConnectivityState().prover.active).toBe(false);
    expect(_g.__connStateStore[CONNECTIVITY_STATE_KEY].prover.active).toBe(false);
  });

  it('leaves the snapshot alone when nothing is stored', async () => {
    markConnectivityIssue('prover');
    await flush();

    await hydrateConnectivityState();

    expect(getConnectivityState().prover.active).toBe(true);
  });

  // The stored value is untyped input: an older build's shape, a hand-edited profile,
  // or something else entirely under this key. Hydrating it would put a value the
  // banner has to render into `current` and then write it straight back out.
  it('ignores a malformed stored value — rejected by the guard, not by throwing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const withoutResolving: Record<string, unknown> = { ...mirror({}) };
    delete withoutResolving.resolving;
    for (const bad of [
      42,
      'nope',
      null,
      {},
      // every category present but each one the wrong shape
      { network: {}, node: {}, prover: {}, resolving: {} },
      { ...mirror({}), node: { active: 'yes', since: null } },
      { ...mirror({}), node: { active: true, since: 'soon' } },
      { ...mirror({}), node: { active: true } },
      { ...mirror({}), node: { since: 1 } },
      withoutResolving
    ]) {
      resetConnectivityState();
      _g.__connStateStore[CONNECTIVITY_STATE_KEY] = bad;

      await hydrateConnectivityState();

      expect(getConnectivityState()).toEqual({
        network: { active: false, since: null },
        node: { active: false, since: null },
        prover: { active: false, since: null },
        resolving: { active: false, since: null }
      });
    }
    // Every one of those is rejected by the shape guard and rejected WITHOUT throwing.
    // The distinction is what this assertion buys: drop `isConnectivitySnapshot`'s
    // `typeof value !== 'object'` line and the primitives here make `'network' in value`
    // throw instead, which the best-effort catch absorbs — leaving `current` untouched,
    // so the snapshot assertions above still pass while every service-worker start logs
    // a failure. (The per-category `'network' in value` presence clauses are a different
    // thing: they exist for TypeScript's `in`-narrowing, so `value.network` is
    // addressable at all. Dropping one is a tsc error, not a test failure — at runtime a
    // missing category is rejected anyway, because `isCategoryState(undefined)` is
    // false. Everything malformed BELOW that is rejected by `isCategoryState`.)
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts a well-formed stored value for every category', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = {
      network: { active: true, since: 1 },
      node: { active: true, since: 2 },
      prover: { active: true, since: 3 },
      resolving: { active: true, since: 4 }
    };

    await hydrateConnectivityState();

    expect(CONNECTIVITY_CATEGORIES.every(c => getConnectivityState()[c].active)).toBe(true);
  });

  it('swallows a storage read that throws — a failed hydrate must not fail SW start', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    Object.defineProperty(_g.__connStateStore, CONNECTIVITY_STATE_KEY, {
      configurable: true,
      get() {
        throw new Error('storage exploded');
      }
    });

    // try/finally, not straight-line teardown: a failing assertion here would otherwise
    // leave the throwing accessor installed, and the storage stub's `Object.assign` would
    // then throw on every later mirror write — one real failure plus a cascade of
    // unrelated ones.
    try {
      await expect(hydrateConnectivityState()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith('[connectivity-state] hydrate failed:', expect.any(Error));
    } finally {
      delete _g.__connStateStore[CONNECTIVITY_STATE_KEY];
      warnSpy.mockRestore();
    }
  });

  // A reporting realm does not own the snapshot and never writes the key it would be
  // reading — hydrating there would resurrect the very per-realm copy the single-writer
  // split exists to eliminate.
  it('is a no-op in a reporting realm', async () => {
    _g.__connStateStore[CONNECTIVITY_STATE_KEY] = mirror({ node: { active: true, since: 7 } });
    setConnectivityReporter(jest.fn());

    await hydrateConnectivityState();

    expect(getConnectivityState().node.active).toBe(false);
  });
});
