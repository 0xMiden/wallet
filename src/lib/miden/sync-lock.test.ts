/**
 * #777 — the pure-sync lock holds outside the useSyncTrigger loop (the tx
 * pipeline's pre-flight sync and the landed-verification probes) go through
 * one helper so the sync watchdog ceiling cannot drift per call site.
 *
 * Driven against the REAL `withWasmClientLock`, with only the SDK proxy mocked.
 * A pass-through lock double would have let this suite assert that an options
 * object was handed over while proving nothing about the bound it names — and
 * the bound is the entire point of the helper.
 *
 * The `unmock` is load-bearing, not cargo cult: `__mocks__/lib/miden/sdk/
 * miden-client.ts` is a ROOT manual mock, so every test that reaches this module
 * by its `lib/...` path — including through `sync-lock.ts`'s own import —
 * silently gets a pass-through stub with no watchdog at all, and the module's
 * test-only helpers are absent from it. So without this line the suite does not
 * go quietly vacuous — it fails outright on the first `beforeEach`
 * (`__resetRecoveryCooldownForTests is not a function`), which is the right
 * failure mode: it cannot be deleted and leave a green suite that no longer
 * tests a watchdog.
 */
/* eslint-disable import/first */
jest.unmock('lib/miden/sdk/miden-client');

const mockSyncState = jest.fn(async () => {});
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { syncState: () => mockSyncState() }
}));

import { __resetRecoveryCooldownForTests, isWasmClientBusy } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WASM_LOCK_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

import { syncUnderBoundedLock } from './sync-lock';

/**
 * Attach the rejection expectation NOW — so the eviction's rejection always has
 * a handler — while letting the test drive timers before awaiting the outcome.
 * Same helper shape as `miden-client.watchdog.test.ts`.
 */
function expectRejection(promise: Promise<unknown>, match: Record<string, unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject(match);
}

describe('syncUnderBoundedLock (#777)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSyncState.mockResolvedValue(undefined);
    // Defensive: the recovery stamp is a module global shared with the
    // realm-error suites, and fake timers restart the monotonic clock at 0, so a
    // stamp left behind lands in this test's future. Only `recoverFromTrap`
    // actually consults it — this suite evicts via the watchdog, which has no
    // cooldown — so nothing here depends on the reset today.
    __resetRecoveryCooldownForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs the proxy sync under the WASM lock and releases it', async () => {
    // Asserted DURING the sync as well as after: `isWasmClientBusy()` is false
    // at both ends of an unlocked call too, so the release assertion alone would
    // pass for a helper that never took the lock.
    let busyDuringSync: boolean | undefined;
    mockSyncState.mockImplementationOnce(async () => {
      busyDuringSync = isWasmClientBusy();
    });

    await syncUnderBoundedLock();

    expect(mockSyncState).toHaveBeenCalledTimes(1);
    expect(busyDuringSync).toBe(true);
    expect(isWasmClientBusy()).toBe(false);
  });

  it('evicts a parked sync at the sync ceiling, not the 5-minute last resort', async () => {
    // The defect shape: on wasm32 the SDK's gRPC-web fetch carries no transport
    // deadline, so a sync whose response never arrives never settles. Under the
    // default ceiling that parks the process-wide lock for five minutes.
    mockSyncState.mockReturnValue(new Promise<never>(() => {}));

    const rejects = expectRejection(syncUnderBoundedLock(), {
      name: 'WasmClientPoisonedError',
      reason: 'watchdog'
    });

    await jest.advanceTimersByTimeAsync(WASM_LOCK_SYNC_WATCHDOG_MS - 1);
    expect(isWasmClientBusy()).toBe(true);

    await jest.advanceTimersByTimeAsync(1);
    await rejects;
    // The lock is free well before the default ceiling would have released it,
    // which on mobile is the whole app's WASM access coming back.
    expect(isWasmClientBusy()).toBe(false);
    expect(WASM_LOCK_SYNC_WATCHDOG_MS).toBeLessThan(WASM_LOCK_WATCHDOG_MS);
  });

  it('propagates a sync failure to the caller (fail-fast is each call site’s decision)', async () => {
    mockSyncState.mockRejectedValueOnce(new Error('node down'));

    await expect(syncUnderBoundedLock()).rejects.toThrow('node down');
    // A failure must still hand the lock back — the pipeline's next step takes it.
    expect(isWasmClientBusy()).toBe(false);
  });
});
