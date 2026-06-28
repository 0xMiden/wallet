/**
 * E2E-only background-sync pause.
 *
 * On mobile the Miden WASM client is single-threaded (main thread). A test that
 * needs to make its own WASM-lock-bound read (currently `__TEST_GUARDIAN_AUTH__`
 * reading a Guardian account's on-chain auth structure) is otherwise livelocked
 * by the wallet's always-on frontend pollers, which each re-fire every few
 * seconds and keep the single WASM thread saturated:
 *   - `useSyncTrigger` (3s chain sync)
 *   - the balance poll (`fetchBalances`, 5s) — which deliberately bypasses
 *     `withWasmClientLock`, so holding that lock gives the read zero protection
 *   - the claimable-notes SWR (`getConsumableNotes`, 5s)
 *
 * A test hook sets `__TEST_SYNC_PAUSED__` for the duration of its read; every
 * one of those pollers checks `isTestSyncPaused()` and skips a cycle while it is
 * set, so the read runs against an idle main thread and completes in seconds.
 *
 * Zero production impact: `MIDEN_E2E_TEST` is statically replaced with `'false'`
 * in production builds, so these helpers short-circuit and the global lookup is
 * dead-code-eliminated. This module is intentionally dependency-free so any
 * layer (front hooks, store) can import it without a cycle.
 */

interface TestSyncPauseGlobal {
  __TEST_SYNC_PAUSED__?: boolean;
}

export function isTestSyncPaused(): boolean {
  return process.env.MIDEN_E2E_TEST === 'true' && (globalThis as TestSyncPauseGlobal).__TEST_SYNC_PAUSED__ === true;
}

export function setTestSyncPaused(paused: boolean): void {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  (globalThis as TestSyncPauseGlobal).__TEST_SYNC_PAUSED__ = paused;
}
