/**
 * #777 — the pure-sync lock holds outside the useSyncTrigger loop (the tx
 * pipeline's pre-flight sync and the landed-verification probes) go through
 * one helper so the sync watchdog ceiling cannot drift per call site.
 */
/* eslint-disable import/first */

const lockCalls: Array<{ options?: unknown }> = [];
const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>, options?: unknown) => {
  lockCalls.push({ options });
  return fn();
});
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => Promise<unknown>, options?: unknown) => mockWithWasmClientLock(fn, options)
}));

const mockSyncState = jest.fn(async () => {});
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { syncState: () => mockSyncState() }
}));

import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

import { syncUnderBoundedLock } from './sync-lock';

describe('syncUnderBoundedLock (#777)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lockCalls.length = 0;
  });

  it('runs the proxy sync under the WASM lock with the sync watchdog ceiling', async () => {
    await syncUnderBoundedLock();

    expect(mockSyncState).toHaveBeenCalledTimes(1);
    expect(lockCalls).toEqual([{ options: { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS } }]);
  });

  it('propagates a sync failure to the caller (fail-fast is each call site’s decision)', async () => {
    mockSyncState.mockRejectedValueOnce(new Error('node down'));

    await expect(syncUnderBoundedLock()).rejects.toThrow('node down');
  });
});
