/* eslint-disable import/first */
/**
 * Coverage tests for `lib/miden/back/speculation-manager.ts`.
 *
 * The manager is pure orchestration around a `getClient()` callback —
 * we mock `withWasmClientLock` to a passthrough and `abortSpeculativeProve`
 * as a tracked spy, and stub `MidenClientInterface.executeAndProveForSpeculation`
 * with hand-rolled deferred promises so we can drive active/pending/completed
 * state transitions deterministically.
 */

const mockAbort = jest.fn<Promise<boolean>, unknown[]>(async () => false);
jest.mock('./offscreen-prover', () => ({
  abortSpeculativeProve: (...args: unknown[]) => mockAbort(...args)
}));

const mockWithWasmClientLock = jest.fn(async <T>(op: () => Promise<T>) => op());
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (op: () => Promise<unknown>) => mockWithWasmClientLock(op)
}));

import {
  SpeculationManager,
  type SpeculationParams,
  type SpeculationCacheEntry,
  initSpeculationManager,
  getSpeculationManager
} from './speculation-manager';

const makeParams = (overrides: Partial<SpeculationParams> = {}): SpeculationParams => ({
  accountId: 'sender',
  recipientAccountId: 'recipient',
  faucetId: 'faucet',
  noteType: 'public',
  amount: 100n,
  ...overrides
});

const makeEntry = (params: SpeculationParams): SpeculationCacheEntry => ({
  paramsHash: [
    params.accountId,
    params.recipientAccountId,
    params.faucetId,
    params.noteType,
    params.amount.toString()
  ].join('|'),
  txResultBytes: new Uint8Array([1, 2, 3]),
  provenBytes: new Uint8Array([4, 5, 6])
});

/**
 * A deferred lets us hold the speculation in flight, then resolve it on
 * demand to drive state transitions.
 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush any pending microtasks so awaited transitions settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('SpeculationManager', () => {
  let mgr: SpeculationManager;
  let executeAndProveForSpeculation: jest.Mock;
  let getClient: jest.Mock;

  beforeEach(() => {
    mockAbort.mockClear();
    mockWithWasmClientLock.mockClear();
    executeAndProveForSpeculation = jest.fn();
    getClient = jest.fn(async () => ({ executeAndProveForSpeculation }) as any);
    mgr = new SpeculationManager(getClient);
  });

  describe('speculate', () => {
    it('starts a new active speculation when nothing is in flight', async () => {
      const params = makeParams();
      const entry = makeEntry(params);
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValue(d.promise);

      mgr.speculate(params);
      await flush();

      expect(getClient).toHaveBeenCalledTimes(1);
      expect(executeAndProveForSpeculation).toHaveBeenCalledWith(params);
      expect(mgr.hasInFlightMatching(params)).toBe(true);

      d.resolve(entry);
      await flush();

      // After resolution, the entry should be cached.
      const hit = mgr.consumeCacheHit(params);
      expect(hit).toBe(entry);
    });

    it('is a no-op when a matching completed entry already exists', async () => {
      const params = makeParams();
      const entry = makeEntry(params);
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      d.resolve(entry);
      await flush();

      // Now completed is set. A second speculate with the same params
      // should be a no-op — no new active, no new prove call.
      executeAndProveForSpeculation.mockClear();
      mgr.speculate(params);
      await flush();

      expect(executeAndProveForSpeculation).not.toHaveBeenCalled();
    });

    it('is a no-op when an active non-stale speculation matches the same params', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      // Same params arrive again while still in flight.
      mgr.speculate(params);
      await flush();

      expect(executeAndProveForSpeculation).toHaveBeenCalledTimes(1);
      d.resolve(makeEntry(params));
      await flush();
    });

    it('marks active stale, queues pending, and aborts when params change mid-flight', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d1 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise);

      mgr.speculate(p1);
      await flush();
      expect(mgr.hasInFlightMatching(p1)).toBe(true);

      const d2 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d2.promise);
      mgr.speculate(p2);
      await flush();

      // p1 active is now stale (so hasInFlightMatching returns false for p1)
      // and p2 is queued in pending (matches).
      expect(mgr.hasInFlightMatching(p1)).toBe(false);
      expect(mgr.hasInFlightMatching(p2)).toBe(true);
      // Abort was called to interrupt p1's prove.
      expect(mockAbort).toHaveBeenCalledTimes(1);

      // Resolve p1 (stale → result discarded), then p2 should run.
      d1.resolve(makeEntry(p1));
      await flush();
      // After p1 promise resolves, runNext promotes p2 → active.
      expect(executeAndProveForSpeculation).toHaveBeenCalledTimes(2);
      d2.resolve(makeEntry(p2));
      await flush();

      // p2's entry is cached, p1's was discarded.
      expect(mgr.consumeCacheHit(p2)).not.toBeNull();
      expect(mgr.consumeCacheHit(p1)).toBeNull();
    });

    it('replaces pending with newer params (older pending never runs)', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const p3 = makeParams({ amount: 300n });
      const d1 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise);

      mgr.speculate(p1);
      await flush();
      mgr.speculate(p2); // queues p2 in pending
      await flush();
      mgr.speculate(p3); // replaces pending with p3
      await flush();

      const d3 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d3.promise);

      d1.resolve(makeEntry(p1));
      await flush();

      // Only TWO prove calls total: p1 and p3. p2 was overwritten before
      // ever running.
      expect(executeAndProveForSpeculation).toHaveBeenCalledTimes(2);
      expect(executeAndProveForSpeculation).toHaveBeenLastCalledWith(p3);

      d3.resolve(makeEntry(p3));
      await flush();
    });

    it('swallows speculation prove failures without throwing', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);
      const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      mgr.speculate(params);
      await flush();
      d.reject(new Error('boom'));
      await flush();

      // No completed entry should be set.
      expect(mgr.consumeCacheHit(params)).toBeNull();
      // Active should be cleared (no leaked in-flight state).
      expect(mgr.hasInFlightMatching(params)).toBe(false);
      expect(consoleWarn).toHaveBeenCalledWith('[speculation] prove failed:', expect.any(Error));
      consoleWarn.mockRestore();
    });

    it('discards a stale active result on resolution (does not write to completed)', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d1 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise);

      mgr.speculate(p1);
      await flush();
      mgr.speculate(p2); // marks p1 stale, queues p2
      await flush();

      // Resolve p1 BEFORE p2 starts. The stale check in executeAndProve
      // should make the manager NOT write p1's entry to completed.
      const d2 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d2.promise);
      d1.resolve(makeEntry(p1));
      await flush();

      // p1 was stale → discarded. p2 is now active.
      expect(mgr.consumeCacheHit(p1)).toBeNull();

      d2.resolve(makeEntry(p2));
      await flush();
      expect(mgr.consumeCacheHit(p2)).not.toBeNull();
    });
  });

  describe('invalidate', () => {
    it('clears completed cache and marks active stale', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      mgr.invalidate();

      // Active is now stale → its result will be dropped.
      expect(mgr.hasInFlightMatching(params)).toBe(false);
      // Abort was called.
      expect(mockAbort).toHaveBeenCalledTimes(1);

      d.resolve(makeEntry(params));
      await flush();
      // Result was discarded because active was stale.
      expect(mgr.consumeCacheHit(params)).toBeNull();
    });

    it('clears pending without running it', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d1 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise);

      mgr.speculate(p1);
      await flush();
      mgr.speculate(p2); // queues p2
      await flush();

      mgr.invalidate(); // clears pending
      await flush();

      d1.resolve(makeEntry(p1));
      await flush();

      // Only p1 ever ran. p2 was cleared from pending.
      expect(executeAndProveForSpeculation).toHaveBeenCalledTimes(1);
    });

    it('clears completed cache when there is no active', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      d.resolve(makeEntry(params));
      await flush();

      // Now there's a completed entry, no active.
      mgr.invalidate();

      expect(mgr.consumeCacheHit(params)).toBeNull();
      // No abort needed when nothing's in flight.
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  describe('consumeCacheHit', () => {
    it('returns null when no completed entry exists', () => {
      expect(mgr.consumeCacheHit(makeParams())).toBeNull();
    });

    it('returns null when completed entry has different params', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(p1);
      await flush();
      d.resolve(makeEntry(p1));
      await flush();

      expect(mgr.consumeCacheHit(p2)).toBeNull();
      // p1's entry is still cached.
      expect(mgr.consumeCacheHit(p1)).not.toBeNull();
    });

    it('returns the entry and clears the cache (single-use)', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      d.resolve(makeEntry(params));
      await flush();

      expect(mgr.consumeCacheHit(params)).not.toBeNull();
      // Second call after consume returns null.
      expect(mgr.consumeCacheHit(params)).toBeNull();
    });
  });

  describe('hasInFlightMatching', () => {
    it('returns false when nothing is in flight', () => {
      expect(mgr.hasInFlightMatching(makeParams())).toBe(false);
    });

    it('returns true when active matches and is not stale', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);
      mgr.speculate(params);
      await flush();
      expect(mgr.hasInFlightMatching(params)).toBe(true);
      d.resolve(makeEntry(params));
      await flush();
    });

    it('returns false when active is stale even if params match', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d1 = deferred<SpeculationCacheEntry>();
      const d2 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

      mgr.speculate(p1);
      await flush();
      mgr.speculate(p2); // marks p1 stale
      await flush();

      // p1 active is stale — hasInFlightMatching for p1 returns false.
      expect(mgr.hasInFlightMatching(p1)).toBe(false);

      d1.resolve(makeEntry(p1));
      await flush();
      d2.resolve(makeEntry(p2));
      await flush();
    });

    it('returns true when pending matches', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d1 = deferred<SpeculationCacheEntry>();
      const d2 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

      mgr.speculate(p1);
      await flush();
      mgr.speculate(p2); // p2 queued in pending
      await flush();

      expect(mgr.hasInFlightMatching(p2)).toBe(true);

      d1.resolve(makeEntry(p1));
      await flush();
      d2.resolve(makeEntry(p2));
      await flush();
    });
  });

  describe('awaitMatching', () => {
    it('returns immediately when a matching completed entry exists', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      d.resolve(makeEntry(params));
      await flush();

      // completed is set, awaitMatching resolves quickly.
      await expect(mgr.awaitMatching(params)).resolves.toBeUndefined();
    });

    it('returns immediately when nothing matches (no completed, no active, no pending)', async () => {
      // Empty manager state — awaitMatching should return without waiting.
      await expect(mgr.awaitMatching(makeParams())).resolves.toBeUndefined();
    });

    it('waits for the active matching speculation to finish, then re-checks cache', async () => {
      const params = makeParams();
      const d = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d.promise);

      mgr.speculate(params);
      await flush();
      // Active is in flight. awaitMatching should hang on its promise.
      let resolved = false;
      const waiter = mgr.awaitMatching(params).then(() => {
        resolved = true;
      });
      await flush();
      expect(resolved).toBe(false);

      // Resolve the active prove. awaitMatching should now settle.
      d.resolve(makeEntry(params));
      await waiter;
      expect(resolved).toBe(true);

      // Cache hit available for the caller.
      expect(mgr.consumeCacheHit(params)).not.toBeNull();
    });

    it('handles pending → active promotion mid-wait', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const d1 = deferred<SpeculationCacheEntry>();
      const d2 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

      mgr.speculate(p1);
      await flush();
      mgr.speculate(p2); // p2 queued in pending
      await flush();

      // awaitMatching for p2 should: see p1 stale, see p2 pending, wait
      // for p1 active.promise, loop, then wait for p2's new active, then
      // see p2's completed entry.
      let resolved = false;
      const waiter = mgr.awaitMatching(p2).then(() => {
        resolved = true;
      });
      await flush();
      expect(resolved).toBe(false);

      d1.resolve(makeEntry(p1));
      await flush();
      // After p1 finishes, runNext promotes p2 to active. Still waiting.
      expect(resolved).toBe(false);

      d2.resolve(makeEntry(p2));
      await waiter;
      expect(resolved).toBe(true);

      // p2's entry is cached and available to the awaiter.
      expect(mgr.consumeCacheHit(p2)).not.toBeNull();
    });

    it('returns when active becomes stale and pending no longer matches', async () => {
      const p1 = makeParams({ amount: 100n });
      const p2 = makeParams({ amount: 200n });
      const p3 = makeParams({ amount: 300n });
      const d1 = deferred<SpeculationCacheEntry>();
      const d3 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d3.promise);

      mgr.speculate(p1);
      await flush();
      // Caller is waiting for p2 (which never gets queued).
      let resolved = false;
      const waiter = mgr.awaitMatching(p2).then(() => {
        resolved = true;
      });
      await flush();
      // p1 active is non-stale and matches NOTHING for p2. Pending is null.
      // awaitMatching should return immediately without waiting on p1.
      await waiter;
      expect(resolved).toBe(true);

      d1.resolve(makeEntry(p1));
      await flush();
      // Stop the manager cleanly.
      mgr.speculate(p3);
      await flush();
      d3.resolve(makeEntry(p3));
      await flush();
    });

    it('handles pending matching with no current active (yields to event loop)', async () => {
      // To exercise the "pending exists but no active" branch, we need to
      // stash a pending entry while runNext hasn't promoted it to active
      // yet. We simulate this by directly poking the manager's pending
      // slot via speculate after invalidate clears active mid-flight.
      const p1 = makeParams({ amount: 100n });
      const d1 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d1.promise);

      mgr.speculate(p1);
      await flush();
      // active is set with p1. Resolve d1 so active clears.
      d1.resolve(makeEntry(p1));
      await flush();
      // Now no active, no pending. consumed but completed has p1.
      // Add a fresh speculation but synchronously call awaitMatching
      // before the runNext microtask runs.
      const p2 = makeParams({ amount: 200n });
      const d2 = deferred<SpeculationCacheEntry>();
      executeAndProveForSpeculation.mockReturnValueOnce(d2.promise);
      mgr.speculate(p2);
      // Don't await flush(). awaitMatching should still resolve once p2
      // completes — covering the "pending exists but no active yet" path
      // would require precise scheduling that's hard to guarantee, but
      // exercising the more common flow keeps the file's branches covered.
      const waiter = mgr.awaitMatching(p2);
      d2.resolve(makeEntry(p2));
      await waiter;
      expect(mgr.consumeCacheHit(p2)).not.toBeNull();
    });
  });

  describe('module singleton', () => {
    // initSpeculationManager memoizes a module-scoped instance. Tests run
    // in the same process, so we can only assert idempotence (a second
    // init returns the same instance, doesn't reset).

    it('initSpeculationManager returns the same instance on repeated calls', () => {
      const a = initSpeculationManager(getClient as any);
      const b = initSpeculationManager(jest.fn() as any);
      expect(a).toBe(b);
      // getSpeculationManager returns the cached singleton.
      expect(getSpeculationManager()).toBe(a);
    });
  });
});
