// Multi-threaded WASM bootstrap for the wallet's mobile build.
//
// Why this exists: on Chrome, the SW spawns an offscreen document (see
// src/offscreen/main.ts) that owns its own WASM instance + rayon pool,
// because MV3 SWs can't host Web Workers. On mobile (Capacitor iOS +
// Android) there's no `chrome.offscreen` API, so the wallet page itself
// owns the WASM instance and we initialise the rayon pool from the
// wallet's window context.
//
// Lifecycle: called once from initMobile() AFTER adapter.init() resolves
// (ordering matters — adapter.init() drives the SDK's lazy import; we
// can't race initThreadPool against the WASM module's own init).
// Result is memoised on the module global, so concurrent prove-path
// callers share a single init.
//
// Failure modes — `wasm-bindgen-rayon`'s `initThreadPool` does NOT
// silently degrade to 1 thread when `SharedArrayBuffer` is missing. It
// allocates a SharedArrayBuffer internally for the rayon condvar; SAB-
// absent → `ReferenceError` propagating out → caught here → result is
// `{ mtReady: false, reason: 'init-failed' }`. Devices without SAB
// cannot local-prove — the gate at miden-client-interface.ts:517
// force-delegates them.
//
// Current SDK pin (0.14.4) has no `initThreadPool` export — the typeof
// guard below catches that and returns `init-failed` cleanly. When
// web-sdk PR #134 lands and the wallet bumps to the version exposing
// `./mt/lazy`, the Vite alias in vite.mobile.config.ts (added at PR
// time) makes the `import` resolve to the MT bundle, and
// `initThreadPool` becomes a real function.

import { isMobile } from 'lib/platform';

const TAG = '[init-mobile-mt]';

export type MtReadyState = { mtReady: true; threads: number } | { mtReady: false; reason: MtReadyFailure };

export type MtReadyFailure = 'not-mobile' | 'no-coi' | 'no-sab' | 'init-failed';

let cachedPromise: Promise<MtReadyState> | null = null;

/**
 * Ensure the wallet's per-page rayon thread pool is initialised, OR report
 * why it can't be. Idempotent: first call drives the init; subsequent
 * calls receive the cached result. Safe to await concurrently.
 *
 * Consumers (currently the prove gate at miden-client-interface.ts:517)
 * read the result to decide whether local prove is viable on this device:
 *   - `mtReady: true`  → local prove can run with `threads` workers
 *   - `mtReady: false` → force-delegate; local prove would crash on a
 *                        rayon pool that never initialised
 */
export function ensureMtReady(): Promise<MtReadyState> {
  if (!cachedPromise) cachedPromise = boot();
  return cachedPromise;
}

async function boot(): Promise<MtReadyState> {
  // Chrome's offscreen path handles its own init; this function is a
  // no-op outside mobile so the prove gate's `isMobile() && !mtReady`
  // short-circuit can read a defined state on either platform.
  if (!isMobile()) return { mtReady: false, reason: 'not-mobile' };

  // Cheap pre-gate: if COOP/COEP didn't take effect (server.headers
  // not honoured by the WebView's loader), SAB-backed worker init
  // will fail. Short-circuit before paying the SDK import cost.
  // eslint-disable-next-line no-restricted-globals -- `self.crossOriginIsolated` is the canonical check across window + worker contexts; mirroring src/offscreen/main.ts's pattern.
  if (!self.crossOriginIsolated) {
    console.warn(`${TAG} crossOriginIsolated=false — COOP/COEP not in effect`);
    return { mtReady: false, reason: 'no-coi' };
  }

  // SAB must exist before initThreadPool tries to allocate one for the
  // rayon condvar. Pre-check is purely cosmetic — the same condition
  // would throw inside initThreadPool a few ms later — but it produces
  // a cleaner reason string for diagnostics.
  if (typeof SharedArrayBuffer === 'undefined') {
    console.warn(`${TAG} SharedArrayBuffer unavailable`);
    return { mtReady: false, reason: 'no-sab' };
  }

  try {
    // `@miden-sdk/miden-sdk/lazy` resolves to the MT bundle once the
    // Vite alias in vite.mobile.config.ts is applied (gated on the
    // SDK exposing `./mt/lazy`, which arrives with web-sdk PR #134).
    // Until that lands the import resolves to the ST bundle whose
    // `initThreadPool` is undefined — the typeof guard catches that.
    const sdk = await import('@miden-sdk/miden-sdk/lazy');
    const initThreadPool = (sdk as { initThreadPool?: (n: number) => Promise<void> }).initThreadPool;
    if (typeof initThreadPool !== 'function') {
      console.warn(`${TAG} SDK has no initThreadPool — bundle is single-threaded`);
      return { mtReady: false, reason: 'init-failed' };
    }
    const threads = navigator.hardwareConcurrency ?? 4;
    const t = performance.now();
    await initThreadPool(threads);
    console.log(`${TAG} initThreadPool(${threads}) took ${(performance.now() - t).toFixed(0)}ms`);
    return { mtReady: true, threads };
  } catch (err) {
    console.warn(`${TAG} initThreadPool threw:`, err);
    return { mtReady: false, reason: 'init-failed' };
  }
}

/**
 * Test-only: reset the memoised promise so subsequent `ensureMtReady`
 * calls re-run the boot. Exported for unit tests; do not call from
 * production code.
 */
export function __resetMtReadyForTests() {
  cachedPromise = null;
}
