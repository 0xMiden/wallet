import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

/**
 * A chain sync under the WASM lock with the sync watchdog ceiling (#777).
 *
 * For the pure-sync holds outside the `useSyncTrigger` loop — the transaction
 * pipeline's pre-flight sync and the landed-verification probes — whose SDK
 * call carries no transport deadline on wasm32, so a parked gRPC-web fetch
 * would otherwise hold the lock until the 5-minute last resort. Expiry is the
 * #775 eviction (the hold is rejected with `WasmClientPoisonedError` and the
 * client singletons are replaced); errors, including the eviction, propagate to
 * the caller — whether a failed sync is fatal is each call site's decision.
 *
 * Use this ONLY for a hold whose whole job is the sync. A hold that continues
 * into other work after the sync must take `withWasmClientLock` itself, on the
 * default ceiling.
 */
export const syncUnderBoundedLock = (): Promise<void> =>
  withWasmClientLock(async () => midenClientProxy.syncState(), { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS });
