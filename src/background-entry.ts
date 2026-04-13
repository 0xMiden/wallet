/**
 * ESM service worker entry point.
 *
 * The early intercom handler and MV3 listeners are injected as a banner
 * by vite.background.config.ts (sw-patches plugin). They run BEFORE any
 * module code, including the WASM SDK's top-level await.
 *
 * This file just imports background.ts which sets up the full wallet backend.
 * Once start() completes (after WASM init), it disables the early handler.
 */
import './background';
