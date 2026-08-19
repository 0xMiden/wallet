import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { copyClassicWorkerWasm } from './worker-wasm-assets';

/**
 * The SDK's CLASSIC worker (macOS WKWebView / Linux WebKitGTK / the Capacitor host)
 * fetches a hard-coded relative `assets/miden_client_web.wasm`, which from its own
 * `/assets/<name>.js` URL resolves to `/assets/assets/miden_client_web.wasm`. Vite's
 * `assetFileNames` emits the wasm to `static/<name>.<hash>.wasm` instead, so without
 * this copy the fetch 404s and every worker-forwarded SDK method rejects for the
 * whole session. The desktop build shipped without it.
 */
const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'worker-wasm-assets-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** Seed `<outDir>/static/<name>` the way Vite's `assetFileNames` rule does. */
function seedStaticWasm(name: string, bytes: Buffer = WASM_BYTES): void {
  mkdirSync(resolve(outDir, 'static'), { recursive: true });
  writeFileSync(resolve(outDir, 'static', name), bytes);
}

describe('copyClassicWorkerWasm', () => {
  it('puts the hashed wasm at the nested path the classic worker resolves', () => {
    seedStaticWasm('miden_client_web.CbCp9sai.wasm');

    const copied = copyClassicWorkerWasm(outDir);

    expect(copied).toBe('miden_client_web.CbCp9sai.wasm');
    const nested = resolve(outDir, 'assets', 'assets', 'miden_client_web.wasm');
    expect(existsSync(nested)).toBe(true);
    expect(readFileSync(nested)).toEqual(WASM_BYTES);
  });

  it('also puts an unhashed copy at /assets for a direct fetch', () => {
    seedStaticWasm('miden_client_web.CbCp9sai.wasm');

    copyClassicWorkerWasm(outDir);

    const flat = resolve(outDir, 'assets', 'miden_client_web.wasm');
    expect(existsSync(flat)).toBe(true);
    expect(readFileSync(flat)).toEqual(WASM_BYTES);
  });

  it('creates the assets directories when the bundle emitted none', () => {
    // A bundle whose only asset is the wasm has no `assets/` at all, so the copy
    // must not depend on Vite having created it.
    seedStaticWasm('miden_client_web.hash.wasm');
    expect(existsSync(resolve(outDir, 'assets'))).toBe(false);

    expect(copyClassicWorkerWasm(outDir)).toBe('miden_client_web.hash.wasm');
    expect(existsSync(resolve(outDir, 'assets', 'assets', 'miden_client_web.wasm'))).toBe(true);
  });

  it('returns null and writes nothing when there is no static directory', () => {
    expect(copyClassicWorkerWasm(outDir)).toBeNull();
    expect(existsSync(resolve(outDir, 'assets'))).toBe(false);
  });

  it('returns null when static/ holds no miden_client_web wasm', () => {
    mkdirSync(resolve(outDir, 'static'), { recursive: true });
    writeFileSync(resolve(outDir, 'static', 'logo.CbCp9sai.svg'), 'x');
    writeFileSync(resolve(outDir, 'static', 'other_module.hash.wasm'), WASM_BYTES);

    expect(copyClassicWorkerWasm(outDir)).toBeNull();
    expect(existsSync(resolve(outDir, 'assets'))).toBe(false);
  });
});

/**
 * Both webview-based targets pick the SDK's CLASSIC worker — Tauri renders in
 * WKWebView (macOS) / WebKitGTK (Linux) and Capacitor hosts a WKWebView / Android
 * WebView — so both bundles need the copy. Mobile had it and desktop did not, which
 * is exactly the drift this guard exists to stop: nothing else in the test suite
 * constructs a real Worker, and the only desktop platform that takes the module
 * branch (Windows/WebView2, whose UA carries `Chrome/`) resolves the wasm correctly.
 */
describe('vite configs that ship a classic-worker webview', () => {
  const REPO_ROOT = resolve(__dirname, '../../..');

  it.each(['vite.desktop.config.ts', 'vite.mobile.config.ts'])('%s runs the wasm copy after the bundle', config => {
    const source = readFileSync(join(REPO_ROOT, config), 'utf8');
    expect(source).toContain('copyClassicWorkerWasm');
    expect(source).toContain('closeBundle');
  });
});
