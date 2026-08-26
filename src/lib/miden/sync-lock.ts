import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

/**
 * A chain sync under the WASM lock with the sync watchdog ceiling (#777).
 *
 * For the pure-sync holds outside the `useSyncTrigger` loop: the transaction
 * pipeline's pre-flight sync (`transaction/index.ts`), the two
 * landed-verification probes (`transaction/cancel.ts`), and the note-import
 * queue's trailing sync (`activity/notes.ts`). Their SDK call carries no
 * transport deadline on wasm32, so a parked gRPC-web fetch would otherwise hold
 * the lock until the 5-minute last resort.
 *
 * BACKEND ONLY, despite sitting next to the dependency-free `sync-backoff.ts`:
 * this imports the service worker's client proxy, which reaches the offscreen
 * codec, the vault and intercom. That is why the frontend loop passes
 * `watchdogMs` to `withWasmClientLock` itself instead of calling this.
 *
 * Not every bounded sync hold comes through here: the frontend loop and the two
 * guardian `syncState` holds pass `watchdogMs` to `withWasmClientLock`
 * themselves, because this module is backend-only (above) and `guardian/index.ts`
 * is not. The holds still on the DEFAULT ceiling are so deliberately: they
 * continue into other work under the same hold (a `getAccount`, a cold-restore's
 * on-chain probe) and so fall under the restriction below. The service worker's
 * own sync hold needs no ceiling for
 * a different reason — its 30s `withTimeout` rejects the lock callback, so the
 * mutex is released well inside any watchdog bound (see
 * `WASM_LOCK_WATCHDOG_MS`). What no ceiling on this side reaches, there or here,
 * is the SDK's module-level in-flight sync. Expiry is the
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
