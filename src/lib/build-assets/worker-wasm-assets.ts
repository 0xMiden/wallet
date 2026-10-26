/**
 * Build-time helper: put the SDK WASM where the SDK's CLASSIC worker looks for it.
 *
 * `WebClient` spawns a worker whenever `useWorker` is true, and
 * `WebClient._shouldUseClassicWorker()` picks the CLASSIC worker for any user agent
 * containing `AppleWebKit` without `Chrome/`/`Chromium/` — i.e. macOS WKWebView
 * (Tauri), Linux WebKitGTK (Tauri) and the Capacitor host on iOS. That worker does
 * not import the wasm through the bundler; it resolves a hard-coded relative
 * `new URL('assets/miden_client_web.wasm', self.location.href)`. With the worker
 * emitted at `/assets/<name>.js`, that resolves to `/assets/assets/miden_client_web.wasm`
 * — a path no Vite `assetFileNames` rule produces, so the fetch 404s, `__wbg_init`
 * throws, and every worker-forwarded SDK method rejects for the whole session.
 *
 * The module worker (Windows/WebView2, Chrome, Chromium Android WebView) imports the
 * bundler-hashed wasm and is unaffected, which is why the failure is invisible in
 * every Chrome-based test and on Windows.
 *
 * Shared by `vite.mobile.config.ts` and `vite.desktop.config.ts` so the two cannot
 * drift: desktop shipped without the copy step and never loaded the WASM at all on
 * macOS/Linux.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve } from 'path';

/** Prefix of the wasm Vite emits (hashed by `assetFileNames`, e.g. `miden_client_web.CbCp9sai.wasm`). */
const WASM_PREFIX = 'miden_client_web';

/** The UNHASHED name the classic worker asks for. */
const WASM_TARGET_NAME = `${WASM_PREFIX}.wasm`;

/**
 * Copy the emitted SDK wasm into the two paths the classic worker can reach.
 *
 * Reads `<outDir>/static` (where both configs' `assetFileNames` puts assets) and
 * writes the first `miden_client_web*.wasm` it finds to:
 *   - `<outDir>/assets/assets/miden_client_web.wasm` — what the classic worker's
 *     own relative `new URL(...)` resolves to.
 *   - `<outDir>/assets/miden_client_web.wasm` — the same file one level up, for a
 *     direct `/assets/miden_client_web.wasm` fetch.
 *
 * Returns the name of the file it copied, or `null` when there is no `static/`
 * directory or it holds no matching wasm — a build that emitted the wasm elsewhere
 * must not fail the whole bundle here.
 */
export function copyClassicWorkerWasm(outDir: string): string | null {
  const staticDir = resolve(outDir, 'static');
  if (!existsSync(staticDir)) return null;

  const source = readdirSync(staticDir).find(name => name.startsWith(WASM_PREFIX) && name.endsWith('.wasm'));
  if (!source) return null;

  const assetsDir = resolve(outDir, 'assets');
  const nestedDir = resolve(assetsDir, 'assets');
  mkdirSync(nestedDir, { recursive: true });

  copyFileSync(resolve(staticDir, source), resolve(nestedDir, WASM_TARGET_NAME));
  copyFileSync(resolve(staticDir, source), resolve(assetsDir, WASM_TARGET_NAME));

  return source;
}
