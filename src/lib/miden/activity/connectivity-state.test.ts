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
  clearConnectivityIssue,
  clearReachabilityIssues,
  ConnectivityCategory,
  getConnectivityState,
  markConnectivityIssue,
  resetConnectivityState,
  subscribeConnectivityState
} from './connectivity-state';

beforeEach(() => {
  for (const k of Object.keys(_g.__connStateStore)) delete _g.__connStateStore[k];
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
