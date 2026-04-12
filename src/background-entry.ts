/**
 * ESM service worker entry point.
 *
 * The early intercom handler and MV3 listeners are injected as a banner
 * by vite.background.config.ts (sw-patches plugin). They run BEFORE any
 * module code, including the WASM SDK's top-level await.
 *
 * This file just imports background.ts which sets up the full wallet backend.
 * Once it finishes loading (after WASM compilation), it disables the early
 * handler and takes over.
 */
import './background';

// Signal that the full background module has loaded
if (typeof (self as any).__disableEarlyHandler === 'function') {
  (self as any).__disableEarlyHandler();
  console.log('[background-entry] Full background loaded, early handler disabled');
}
