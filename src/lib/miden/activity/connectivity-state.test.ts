/* eslint-disable import/first */

// Minimal in-memory storage stub so the mirror-to-storage path doesn't blow
// up in jest (no chrome / no Capacitor).
const _g = globalThis as any;
_g.__connStateStore = {} as Record<string, any>;
_g.__reportedOperations = [] as any[];
jest.mock('lib/telemetry/report-operation', () => ({
  reportOperation: (settled: unknown) => {
    (globalThis as any).__reportedOperations.push(settled);
  }
}));
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
  clearConnectivityIssue,
  clearReachabilityIssues,
  ConnectivityCategory,
  getConnectivityState,
  markConnectivityIssue,
  resetConnectivityState,
  subscribeConnectivityState
} from './connectivity-state';

const reported = (): any[] => _g.__reportedOperations;

beforeEach(() => {
  for (const k of Object.keys(_g.__connStateStore)) delete _g.__connStateStore[k];
  _g.__reportedOperations.length = 0;
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
 * What an outage reports.
 *
 * This is the only place in the wallet that learns a dependency is unreachable,
 * and until it reported that, a prover or node outage was visible to the user as
 * a banner and to nobody else. The pairing matters as much as the fact: the
 * `errored` event says something went down, and the `completed` one says it came
 * back and how long it took.
 */
describe('reporting an outage', () => {
  it('reports once when it begins, not once per retry', () => {
    // A sustained outage marks on every attempt. Reporting each one would turn
    // one outage into a burst whose size measured retry frequency rather than
    // anything about the outage.
    markConnectivityIssue('prover');
    markConnectivityIssue('prover');
    markConnectivityIssue('prover');

    expect(reported()).toEqual([{ operation: 'service_prover', result: 'errored', durationMs: 0 }]);
  });

  it('reports how long it lasted when it lifts', () => {
    // The clock is driven, because mark and clear otherwise happen in the same
    // tick — so a correct implementation and one that hardcodes `0`, or that
    // reads `since` after clearing it, all report `0` and the assertion could
    // not tell them apart. This duration is the number the docs promise is the
    // outage length.
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      markConnectivityIssue('prover');
      now.mockReturnValue(1_000_000 + 90_000);
      clearConnectivityIssue('prover');
    } finally {
      now.mockRestore();
    }

    expect(reported()).toEqual([
      { operation: 'service_prover', result: 'errored', durationMs: 0 },
      { operation: 'service_prover', result: 'completed', durationMs: 90_000 }
    ]);
  });

  it('reports recovery for the categories only a successful sync clears', () => {
    // The failure this catches: `node` and `network` are never cleared by name.
    // A successful sync calls `clearReachabilityIssues`, which clears all three
    // at once, and that was the ONLY path — so both categories could report an
    // outage beginning and never its end. Every node outage read as unresolved
    // and none carried a duration, while the docs promised otherwise.
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(2_000_000);
      markConnectivityIssue('node');
      markConnectivityIssue('network');
      now.mockReturnValue(2_000_000 + 45_000);
      clearReachabilityIssues();
    } finally {
      now.mockRestore();
    }

    // The duration is asserted here too, because the way to get this wrong twice
    // is to report after clearing `since` — which yields a `completed` event for
    // each category, satisfying a names-only check, with every length zero.
    expect(reported().filter(event => event.result === 'completed')).toEqual(
      expect.arrayContaining([
        { operation: 'service_node', result: 'completed', durationMs: 45_000 },
        { operation: 'service_network', result: 'completed', durationMs: 45_000 }
      ])
    );
  });

  it('reports nothing for a clear that had nothing to clear', () => {
    clearConnectivityIssue('prover');
    clearReachabilityIssues();

    expect(reported()).toEqual([]);
  });

  it('says nothing about the probe state, which is not an outage', () => {
    // `resolving` means a probe is in flight. Reporting it would double every
    // real outage with a meaningless sibling.
    markConnectivityIssue('resolving');
    clearReachabilityIssues();

    expect(reported()).toEqual([]);
  });
});
