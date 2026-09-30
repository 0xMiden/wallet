import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isSyncWatchdogEviction, WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

/**
 * A chain sync under the WASM lock with the sync watchdog ceiling (#777).
 *
 * For the pure-sync holds outside the `useSyncTrigger` loop: the transaction
 * pipeline's pre-flight sync (`transaction/index.ts`), the two
 * landed-verification probes (`transaction/cancel.ts`), the structural
 * verdict's sync (`guardian/direct-switch.ts`), the note-import
 * queue's trailing sync (`activity/notes.ts`), and the rotation's pre-build
 * chain sync (`guardian/index.ts`). Their SDK call carries no
 * transport deadline on wasm32, so a parked gRPC-web fetch would otherwise hold
 * the lock until the 5-minute last resort.
 *
 * BACKEND ONLY, despite sitting next to the dependency-free `sync-backoff.ts`:
 * this imports the service worker's client proxy, which reaches the offscreen
 * codec, the vault and intercom. That is why the frontend loop passes
 * `watchdogMs` to `withWasmClientLock` itself instead of calling this.
 *
 * Not every bounded sync hold comes through here: the frontend loop passes
 * `watchdogMs` to `withWasmClientLock` itself, because this module is
 * backend-only (above) and the frontend loop is not. `guardian/index.ts`'s
 * remaining two bounded holds, the `guardian-sync` and `guardian-adopt`
 * `syncState` holds, do the same, but not for that reason - it already imports
 * the same client proxy this module does. They sync the multisig client's
 * guardian state (`this.multisig.syncState()`), not the chain, so this
 * chain-sync-only helper does not fit them.
 * The holds still on the DEFAULT ceiling are so deliberately: they
 * continue into other work under the same hold (a `getAccount`, a cold-restore's
 * on-chain probe) and so fall under the restriction below. The exception is a
 * hold a timer drives: it takes the sync ceiling and a label however much work
 * follows its sync, and re-checks its hold after every parking await. The service worker's
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
 * default ceiling unless a timer drives it, in which case it passes the sync
 * ceiling and a label and re-checks its hold after every parking await.
 */
export const syncUnderBoundedLock = (label?: string): Promise<void> =>
  withWasmClientLock(async () => midenClientProxy.syncState(), { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label });

/**
 * The best-effort sync before a verdict read (#1233): `didDirectSwitchLand`, `verifySendLanded` and
 * `verifyConsumeLanded`. `true` means read the record, `false` means answer "no verdict" and read
 * nothing. The rule lives here so the three cannot drift apart.
 *
 * A watchdog eviction of the sync is the one failure that reads nothing: that read would be the first
 * hold after the eviction, and would rebuild the client against the node that just parked. Any other
 * failure (an ordinary sync error, a realm-error poison, whose client is replaced in milliseconds)
 * still reads the last-synced record, as each caller documents. Never throws.
 */
export const syncBeforeVerdict = async (label: string, context: string): Promise<boolean> => {
  try {
    await syncUnderBoundedLock(label);
    return true;
  } catch (error) {
    if (isSyncWatchdogEviction(error)) {
      console.warn(`Sync evicted before ${context}; no verdict:`, error);
      return false;
    }
    console.warn(`Could not sync before ${context}; reading the last-synced record:`, error);
    return true;
  }
};
