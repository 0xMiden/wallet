import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

/**
 * A chain sync under the WASM lock with the sync watchdog ceiling (#777).
 *
 * For the pure-sync holds outside the `useSyncTrigger` loop, which is exactly
 * three call sites: the transaction pipeline's pre-flight sync
 * (`transaction/index.ts`) and the two landed-verification probes
 * (`transaction/cancel.ts`). Their SDK call carries no transport deadline on
 * wasm32, so a parked gRPC-web fetch would otherwise hold the lock until the
 * 5-minute last resort.
 *
 * Other `syncState()` holds in the codebase deliberately stay on the default,
 * and it is not an oversight: most of them continue into other work under the
 * same hold (a `getAccount`, a guardian round-trip) and so fall under the
 * restriction below. The service worker's own sync hold is the one exception
 * that could convert and has not — see `WASM_LOCK_WATCHDOG_MS`. Expiry is the
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
