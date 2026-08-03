import { expect, test } from '@playwright/test';

import {
  applyGuardianFaultAction,
  decideGuardianFault,
  pathOf,
  targetOf,
  type GuardianFaultPolicy,
  type GuardianRouteLike
} from '../harness/guardian-fault';

/**
 * Fast, deterministic unit coverage for the guardian-fault decision logic --
 * no docker stack, no browser, no extension build. Complements
 * guardian-fault.smoke.spec.ts, which proves the live Playwright
 * `context.route` wiring actually reaches guardian HTTP calls made from the
 * extension's service worker.
 */

// ── targetOf / pathOf ────────────────────────────────────────────────────────

test.describe('targetOf', () => {
  test('matches guardian A (:3000) and B (:3001) by origin', () => {
    expect(targetOf('http://localhost:3000/pubkey?scheme=ecdsa')).toBe('A');
    expect(targetOf('http://localhost:3001/pubkey?scheme=ecdsa')).toBe('B');
  });

  test('does not match unrelated origins (node RPC, prover, note-transport)', () => {
    expect(targetOf('http://localhost:57291/rpc')).toBeNull();
    expect(targetOf('http://localhost:50052/prove')).toBeNull();
    expect(targetOf('http://localhost:57292/notes')).toBeNull();
  });
});

test.describe('pathOf', () => {
  test('matches each declared path segment', () => {
    expect(pathOf('http://localhost:3000/pubkey?scheme=ecdsa')).toBe('pubkey');
    expect(pathOf('http://localhost:3000/register')).toBe('register');
    expect(pathOf('http://localhost:3000/delta?account_id=abc')).toBe('delta');
    expect(pathOf('http://localhost:3000/proposals')).toBe('proposals');
    expect(pathOf('http://localhost:3000/sign')).toBe('sign');
  });

  test('returns null when no known path segment is present', () => {
    expect(pathOf('http://localhost:3000/status')).toBeNull();
  });

  test('matches the first declared path in order when a URL contains more than one segment', () => {
    // '/delta' is declared before 'proposals'/'sign', so a delta-proposal URL
    // resolves to 'delta', not 'proposals' -- callers arming path: 'proposals'
    // or path: 'sign' should be aware the live guardian's actual endpoint for
    // both propose and sign is `/delta/proposal` (see guardian-fault.smoke's
    // sibling report for the live-endpoint finding).
    expect(pathOf('http://localhost:3000/delta/proposal')).toBe('delta');
  });
});

// ── decideGuardianFault ──────────────────────────────────────────────────────

const PUBKEY_B = 'http://localhost:3001/pubkey?scheme=ecdsa';
const PUBKEY_A = 'http://localhost:3000/pubkey?scheme=ecdsa';
const DELTA_A = 'http://localhost:3000/delta?account_id=abc';

test.describe('decideGuardianFault', () => {
  test('passes through when no policy is armed', () => {
    const result = decideGuardianFault(PUBKEY_B, null, 0);
    expect(result).toEqual({ action: { kind: 'continue' }, hits: 0 });
  });

  test('passes through requests to an unrelated origin even with a policy armed', () => {
    const policy: GuardianFaultPolicy = { path: 'pubkey', mode: 'status500' };
    const result = decideGuardianFault('http://localhost:57291/rpc', policy, 0);
    expect(result).toEqual({ action: { kind: 'continue' }, hits: 0 });
  });

  test('passes through when target does not match', () => {
    const policy: GuardianFaultPolicy = { target: 'A', path: 'pubkey', mode: 'status500' };
    const result = decideGuardianFault(PUBKEY_B, policy, 0);
    expect(result).toEqual({ action: { kind: 'continue' }, hits: 0 });
  });

  test('passes through when path does not match', () => {
    const policy: GuardianFaultPolicy = { path: 'register', mode: 'status500' };
    const result = decideGuardianFault(PUBKEY_A, policy, 0);
    expect(result).toEqual({ action: { kind: 'continue' }, hits: 0 });
  });

  test('matches on path alone when no target is specified', () => {
    const policy: GuardianFaultPolicy = { path: 'pubkey', mode: 'status500' };
    expect(decideGuardianFault(PUBKEY_A, policy, 0).action).toEqual({ kind: 'fulfill500' });
    expect(decideGuardianFault(PUBKEY_B, policy, 0).action).toEqual({ kind: 'fulfill500' });
  });

  test('status500 mode fulfills 500 and increments hits', () => {
    const policy: GuardianFaultPolicy = { target: 'B', path: 'pubkey', mode: 'status500' };
    const result = decideGuardianFault(PUBKEY_B, policy, 0);
    expect(result).toEqual({ action: { kind: 'fulfill500' }, hits: 1 });
  });

  test('abort mode aborts and increments hits', () => {
    const policy: GuardianFaultPolicy = { target: 'B', path: 'pubkey', mode: 'abort' };
    const result = decideGuardianFault(PUBKEY_B, policy, 0);
    expect(result).toEqual({ action: { kind: 'abort' }, hits: 1 });
  });

  test('delay mode defaults to 3000ms and increments hits', () => {
    const policy: GuardianFaultPolicy = { target: 'A', path: 'delta', mode: 'delay' };
    const result = decideGuardianFault(DELTA_A, policy, 0);
    expect(result).toEqual({ action: { kind: 'delay', delayMs: 3000 }, hits: 1 });
  });

  test('delay mode honors a custom delayMs', () => {
    const policy: GuardianFaultPolicy = { target: 'A', path: 'delta', mode: 'delay', delayMs: 500 };
    const result = decideGuardianFault(DELTA_A, policy, 0);
    expect(result).toEqual({ action: { kind: 'delay', delayMs: 500 }, hits: 1 });
  });

  test('failFirstN fails exactly N matching requests then falls back to continue', () => {
    const policy: GuardianFaultPolicy = { target: 'B', path: 'pubkey', mode: 'failFirstN', count: 2 };
    let hits = 0;

    const first = decideGuardianFault(PUBKEY_B, policy, hits);
    expect(first.action).toEqual({ kind: 'fulfill500' });
    hits = first.hits;
    expect(hits).toBe(1);

    const second = decideGuardianFault(PUBKEY_B, policy, hits);
    expect(second.action).toEqual({ kind: 'fulfill500' });
    hits = second.hits;
    expect(hits).toBe(2);

    // Third matching request: count (2) already reached -> passes through, and
    // the hit counter does not keep climbing past what was actually armed.
    const third = decideGuardianFault(PUBKEY_B, policy, hits);
    expect(third.action).toEqual({ kind: 'continue' });
    expect(third.hits).toBe(2);

    const fourth = decideGuardianFault(PUBKEY_B, policy, third.hits);
    expect(fourth.action).toEqual({ kind: 'continue' });
    expect(fourth.hits).toBe(2);
  });

  test('failFirstN defaults count to 1 when omitted', () => {
    const policy: GuardianFaultPolicy = { target: 'B', path: 'pubkey', mode: 'failFirstN' };
    const first = decideGuardianFault(PUBKEY_B, policy, 0);
    expect(first.action).toEqual({ kind: 'fulfill500' });
    const second = decideGuardianFault(PUBKEY_B, policy, first.hits);
    expect(second.action).toEqual({ kind: 'continue' });
  });
});

// ── applyGuardianFaultAction (fake Route, no browser) ───────────────────────

function makeFakeRoute(url: string): GuardianRouteLike & {
  continueCalls: number;
  abortCalls: string[];
  fulfillCalls: Array<{ status: number; body: string }>;
} {
  return {
    continueCalls: 0,
    abortCalls: [],
    fulfillCalls: [],
    request() {
      return { url: () => url };
    },
    async continue() {
      this.continueCalls++;
    },
    async abort(errorCode?: string) {
      this.abortCalls.push(errorCode ?? '');
    },
    async fulfill(response: { status: number; body: string }) {
      this.fulfillCalls.push(response);
    }
  };
}

test.describe('applyGuardianFaultAction', () => {
  test('continue action calls route.continue()', async () => {
    const route = makeFakeRoute(PUBKEY_B);
    await applyGuardianFaultAction(route, { kind: 'continue' });
    expect(route.continueCalls).toBe(1);
    expect(route.abortCalls).toEqual([]);
    expect(route.fulfillCalls).toEqual([]);
  });

  test('abort action calls route.abort("failed")', async () => {
    const route = makeFakeRoute(PUBKEY_B);
    await applyGuardianFaultAction(route, { kind: 'abort' });
    expect(route.abortCalls).toEqual(['failed']);
    expect(route.continueCalls).toBe(0);
  });

  test('fulfill500 action calls route.fulfill with status 500', async () => {
    const route = makeFakeRoute(PUBKEY_B);
    await applyGuardianFaultAction(route, { kind: 'fulfill500' });
    expect(route.fulfillCalls).toEqual([{ status: 500, body: 'injected guardian fault' }]);
    expect(route.continueCalls).toBe(0);
  });

  test('delay action waits delayMs then calls route.continue()', async () => {
    const route = makeFakeRoute(PUBKEY_B);
    const start = Date.now();
    await applyGuardianFaultAction(route, { kind: 'delay', delayMs: 30 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25); // small slack for timer jitter
    expect(route.continueCalls).toBe(1);
    expect(route.fulfillCalls).toEqual([]);
  });
});
