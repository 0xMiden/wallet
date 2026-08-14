import { expect, test } from '@playwright/test';

import {
  applyNetworkFaultAction,
  decideNetworkFault,
  LOCAL_NETWORK_ORIGINS,
  targetOfNetwork,
  type NetworkFaultAction,
  type NetworkFaultPolicy,
  type NetworkRouteLike
} from '../../harness/network-faults';

/**
 * Fast, deterministic unit coverage for the whole-infra network-fault decision
 * logic — no docker stack, no browser, no extension build. Complements the live
 * seam smoke spec (_seam.smoke.spec.ts), which proves the Playwright
 * `context.route` wiring actually reaches SW-originated node/prover/transport
 * traffic. Mirrors guardian-fault-policy.spec.ts.
 */

const O = LOCAL_NETWORK_ORIGINS;

// ── targetOfNetwork ──────────────────────────────────────────────────────────

test.describe('targetOfNetwork', () => {
  test('matches each dependency by origin', () => {
    expect(targetOfNetwork('http://localhost:57291/rpc.Api/SyncState', O)).toBe('node');
    expect(targetOfNetwork('http://localhost:50052/prove', O)).toBe('prover');
    expect(targetOfNetwork('http://localhost:57292/notes', O)).toBe('transport');
    expect(targetOfNetwork('http://localhost:3000/pubkey', O)).toBe('guardianA');
    expect(targetOfNetwork('http://localhost:3001/delta', O)).toBe('guardianB');
    expect(targetOfNetwork('http://localhost:8549/positions/owner', O)).toBe('positions');
    expect(targetOfNetwork('http://localhost:8548/allocate', O)).toBe('allocator');
    expect(targetOfNetwork('http://localhost:8545/', O)).toBe('anvil');
  });

  test('returns null for an unrelated origin', () => {
    expect(targetOfNetwork('http://example.com/whatever', O)).toBeNull();
    expect(targetOfNetwork('http://localhost:9999/x', O)).toBeNull();
  });
});

// ── decideNetworkFault: per-mode action shape ────────────────────────────────

const decideOne = (url: string, policy: NetworkFaultPolicy) => decideNetworkFault(url, [policy], [0], O).action;

test.describe('decideNetworkFault — mode → action', () => {
  const NODE = 'http://localhost:57291/rpc.Api/SubmitProvenTransaction';

  test('status500 → fulfill 500', () => {
    expect(decideOne(NODE, { target: 'node', mode: 'status500' })).toEqual({
      kind: 'fulfill',
      status: 500,
      body: 'injected network fault'
    });
  });

  test('status429RetryAfter → fulfill 429 with Retry-After header', () => {
    const action = decideOne(NODE, { target: 'node', mode: 'status429RetryAfter', retryAfterSec: 5 });
    expect(action.kind).toBe('fulfill');
    if (action.kind !== 'fulfill') throw new Error('unreachable');
    expect(action.status).toBe(429);
    expect(action.headers?.['retry-after']).toBe('5');
  });

  test('abort / connectionRefused / timeout → abort with the right net error', () => {
    expect(decideOne(NODE, { target: 'node', mode: 'abort' })).toEqual({ kind: 'abort', errorCode: 'failed' });
    expect(decideOne(NODE, { target: 'node', mode: 'connectionRefused' })).toEqual({
      kind: 'abort',
      errorCode: 'connectionrefused'
    });
    expect(decideOne(NODE, { target: 'node', mode: 'timeout' })).toEqual({ kind: 'abort', errorCode: 'timedout' });
  });

  test('hang → never-settling action', () => {
    expect(decideOne(NODE, { target: 'node', mode: 'hang' })).toEqual({ kind: 'hang' });
  });

  test('delay / slowStream → delay with sensible defaults', () => {
    expect(decideOne(NODE, { target: 'node', mode: 'delay' })).toEqual({ kind: 'delay', delayMs: 3000 });
    expect(decideOne(NODE, { target: 'node', mode: 'slowStream' })).toEqual({ kind: 'delay', delayMs: 8000 });
    expect(decideOne(NODE, { target: 'node', mode: 'delay', delayMs: 100 })).toEqual({ kind: 'delay', delayMs: 100 });
  });

  test('truncatedBody / malformedBody → fulfill 200 with a bad body', () => {
    const t = decideOne(NODE, { target: 'node', mode: 'truncatedBody' });
    const m = decideOne(NODE, { target: 'node', mode: 'malformedBody' });
    expect(t.kind === 'fulfill' && t.status).toBe(200);
    expect(m.kind === 'fulfill' && m.status).toBe(200);
    if (t.kind === 'fulfill' && m.kind === 'fulfill') {
      expect(() => JSON.parse(t.body)).toThrow();
      expect(() => JSON.parse(m.body)).toThrow();
    }
  });
});

// ── matching: target + path narrowing ────────────────────────────────────────

test.describe('decideNetworkFault — matching', () => {
  test('passes through when the target does not match', () => {
    const d = decideNetworkFault('http://localhost:50052/prove', [{ target: 'node', mode: 'status500' }], [0], O);
    expect(d.action).toEqual({ kind: 'passthrough' });
    expect(d.matchedIndex).toBe(-1);
  });

  test('path narrows within a target', () => {
    const policy: NetworkFaultPolicy = { target: 'node', path: 'SyncState', mode: 'status500' };
    expect(decideNetworkFault('http://localhost:57291/rpc.Api/SyncState', [policy], [0], O).matchedIndex).toBe(0);
    // same target, different endpoint → no match
    expect(
      decideNetworkFault('http://localhost:57291/rpc.Api/SubmitProvenTransaction', [policy], [0], O).matchedIndex
    ).toBe(-1);
  });

  test('first matching policy wins when several are armed', () => {
    const policies: NetworkFaultPolicy[] = [
      { target: 'node', mode: 'status500' },
      { target: 'prover', mode: 'abort' }
    ];
    expect(decideNetworkFault('http://localhost:50052/prove', policies, [0, 0], O).matchedIndex).toBe(1);
    expect(decideNetworkFault('http://localhost:50052/prove', policies, [0, 0], O).action).toEqual({
      kind: 'abort',
      errorCode: 'failed'
    });
  });
});

// ── failFirstN self-clear ────────────────────────────────────────────────────

test.describe('decideNetworkFault — failFirstN', () => {
  test('faults the first N matches then passes through (recovers)', () => {
    const policies: NetworkFaultPolicy[] = [{ target: 'transport', path: 'import', mode: 'failFirstN', count: 3 }];
    const url = 'http://localhost:57292/import';
    let hits = [0];
    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = decideNetworkFault(url, policies, hits, O);
      hits = d.hits;
      kinds.push(d.action.kind);
    }
    // 3 faults (fulfill), then 2 continues
    expect(kinds).toEqual(['fulfill', 'fulfill', 'fulfill', 'continue', 'continue']);
  });

  test('defaults count to 1', () => {
    const policies: NetworkFaultPolicy[] = [{ target: 'node', mode: 'failFirstN' }];
    const url = 'http://localhost:57291/rpc';
    const first = decideNetworkFault(url, policies, [0], O);
    const second = decideNetworkFault(url, policies, first.hits, O);
    expect(first.action.kind).toBe('fulfill');
    expect(second.action.kind).toBe('continue');
  });
});

// ── applyNetworkFaultAction against a fake route ─────────────────────────────

function fakeRoute(): { route: NetworkRouteLike; calls: string[] } {
  const calls: string[] = [];
  const route: NetworkRouteLike = {
    request: () => ({ url: () => 'http://localhost:57291/x' }),
    continue: async () => {
      calls.push('continue');
    },
    abort: async (code?: string) => {
      calls.push(`abort:${code}`);
    },
    fulfill: async r => {
      calls.push(`fulfill:${r.status}`);
    }
  };
  return { route, calls };
}

test.describe('applyNetworkFaultAction', () => {
  test('continue / passthrough → route.continue()', async () => {
    const a = fakeRoute();
    await applyNetworkFaultAction(a.route, { kind: 'continue' });
    await applyNetworkFaultAction(a.route, { kind: 'passthrough' });
    expect(a.calls).toEqual(['continue', 'continue']);
  });

  test('abort → route.abort(code)', async () => {
    const a = fakeRoute();
    await applyNetworkFaultAction(a.route, { kind: 'abort', errorCode: 'connectionrefused' });
    expect(a.calls).toEqual(['abort:connectionrefused']);
  });

  test('fulfill → route.fulfill(status)', async () => {
    const a = fakeRoute();
    await applyNetworkFaultAction(a.route, { kind: 'fulfill', status: 500, body: 'x' });
    expect(a.calls).toEqual(['fulfill:500']);
  });

  test('hang never settles and never touches the route', async () => {
    const a = fakeRoute();
    const hang: NetworkFaultAction = { kind: 'hang' };
    const settled = await Promise.race([
      applyNetworkFaultAction(a.route, hang).then(() => 'settled'),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 50))
    ]);
    expect(settled).toBe('pending');
    expect(a.calls).toEqual([]);
  });
});
