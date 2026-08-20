/**
 * Vite config for the mobile (Capacitor) build.
 * Single entry point, webextension-polyfill mocked.
 */
import { midenVitePlugin } from '@miden-sdk/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';

const pkg = require('./package.json');

export default defineConfig({
  plugins: [
    {
      name: 'miden-sdk-eager-to-lazy',
      enforce: 'pre',
      async resolveId(id, importer) {
        // @openzeppelin/miden-multisig-client imports the bare @miden-sdk/miden-sdk,
        // which @miden-sdk/vite-plugin's alias rewrites to the package DIRECTORY
        // (→ exports['.'] = dist/st/eager.js, a top-level `await loadWasm()` that
        // hangs at module init inside WKWebView/Capacitor — the app never mounts).
        // That alias runs before this hook, so we match BOTH the bare specifier
        // and the rewritten directory path, and redirect to the lazy entry
        // (identical API, no top-level await; callers already await readiness).
        // Mobile is single-threaded (no SAB), so /lazy (st), not /mt/lazy.
        if (id === '@miden-sdk/miden-sdk' || /[\\/]node_modules[\\/]@miden-sdk[\\/]miden-sdk$/.test(id)) {
          return this.resolve('@miden-sdk/miden-sdk/lazy', importer, { skipSelf: true });
        }
        return null;
      }
    },
    midenVitePlugin({
      rpcProxyTarget:
        process.env.MIDEN_NETWORK === 'devnet' ? 'https://rpc.devnet.miden.io' : 'https://rpc.testnet.miden.io'
    }),
    tailwindcss(),
    react(),
    // Capacitor expects index.html. Rename mobile.html → index.html.
    // Strip crossorigin attrs (not needed for Capacitor's local server).
    {
      name: 'mobile-html-fixes',
      transformIndexHtml(html) {
        return html.replace(/ crossorigin/g, '');
      },
      closeBundle() {
        const { renameSync, existsSync, copyFileSync, readdirSync, mkdirSync } = require('fs');
        const src = resolve(__dirname, 'dist/mobile/mobile.html');
        const dest = resolve(__dirname, 'dist/mobile/index.html');
        if (existsSync(src)) renameSync(src, dest);
        // Copy WASM to paths the classic Worker expects.
        // The Worker is at /assets/worker.js and resolves
        // "assets/miden_client_web.wasm" relative to self.location.href,
        // which gives /assets/assets/miden_client_web.wasm.
        // WASM files live in static/ (per assetFileNames config).
        const staticDir = resolve(__dirname, 'dist/mobile/static');
        const assetsDir = resolve(__dirname, 'dist/mobile/assets');
        if (existsSync(staticDir)) {
          // Target: /assets/assets/miden_client_web.wasm (Worker relative resolution)
          const nestedDir = resolve(assetsDir, 'assets');
          mkdirSync(nestedDir, { recursive: true });
          for (const f of readdirSync(staticDir)) {
            if (f.startsWith('miden_client_web') && f.endsWith('.wasm')) {
              copyFileSync(resolve(staticDir, f), resolve(nestedDir, 'miden_client_web.wasm'));
              // Also copy unhashed to assets/ root for direct access
              copyFileSync(resolve(staticDir, f), resolve(assetsDir, 'miden_client_web.wasm'));
              break;
            }
          }
        }
      }
    } satisfies Plugin,
    // SVG → React component transform.
    // Mirrors webpack's @svgr/webpack behavior: default export is a URL to the
    // file (for `<img src={Logo}>` usage) and named export `ReactComponent` is
    // a JSX component (for `<ReactComponent>` usage). Both patterns are used
    // throughout the wallet codebase.
    {
      name: 'svg-to-react',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source.endsWith('.svg') && importer) {
          return resolve(importer, '..', source) + '?svgr';
        }
      },
      async load(id) {
        if (!id.endsWith('?svgr')) return;
        const filePath = id.replace('?svgr', '');
        const { readFileSync } = await import('fs');
        const svgContent = readFileSync(filePath, 'utf8');
        const { transform } = await import('@svgr/core');
        const jsxCode = await transform(
          svgContent,
          {
            plugins: ['@svgr/plugin-jsx'],
            exportType: 'named',
            namedExport: 'ReactComponent',
            // Classic runtime so SVGR imports React into each generated component,
            // matching the bundler's classic JSX compile (see vite.extension.config.ts
            // for the full rationale) — automatic emits `React.createElement` with an
            // undefined `React`, crashing minified production builds.
            jsxRuntime: 'classic'
          },
          { filePath }
        );
        // Emit the SVG as a Vite asset so we get a hashed URL for the default
        // export. `this.emitFile` returns a reference id that Vite rewrites to
        // the final URL at bundle time.
        const refId = this.emitFile({
          type: 'asset',
          name: filePath.split('/').pop(),
          source: svgContent
        });
        return {
          code: `${jsxCode}\nexport default import.meta.ROLLUP_FILE_URL_${refId};`,
          moduleType: 'jsx'
        };
      }
    } satisfies Plugin,
    // Hoist React to global for CJS dependencies that expect React.createElement
    {
      name: 'react-global',
      generateBundle(_, bundle) {
        for (const [, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code) continue;
          if (!chunk.code.includes('React.createElement')) continue;
          chunk.code = chunk.code.replace(
            /var React = (require_react\(\));/,
            'var React = $1; globalThis.React = globalThis.React || React;'
          );
        }
      }
    } satisfies Plugin,
    wasm(),
    nodePolyfills({
      include: ['buffer', 'stream', 'assert', 'process', 'util'],
      globals: { Buffer: true, process: true }
    })
  ],

  // publicDir must be enabled for mobile — Capacitor needs misc/ icons, _locales, etc.
  // Unlike the extension build, the mobile HTML input is mobile.html (not in public/),
  // so Vite's publicDir copy won't overwrite the processed HTML.
  publicDir: 'public',

  build: {
    outDir: 'dist/mobile',
    emptyOutDir: true,
    sourcemap: process.env.MODE_ENV !== 'production',
    target: 'es2022',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, 'mobile.html'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: 'static/[name].[hash][extname]'
        // NB: inlineDynamicImports was true here, but rolldown-vite (Vite 8)
        // emits non-async arrow wrappers around inlined TLA-using modules
        // (e.g. @miden-sdk/miden-sdk/lazy → `(()=>{ await _V() })`), which
        // JavaScriptCore rejects with "SyntaxError: Unexpected identifier
        // '_V'". Letting dynamic imports stay as real chunks keeps the TLA
        // contained to module-level where the runtime supports it.
      }
    }
  },

  resolve: {
    // @capacitor/core MUST resolve to a single instance. Without this, Rollup
    // inlines a second copy of the Capacitor runtime into the walletconnect
    // chunk; that second `createCapacitor()` is NOT the one wired to
    // `window.Capacitor`, so `registerPlugin('Reown')` on it dispatches into a
    // dead bridge and every native Reown call hangs forever (bridge/EVM connect
    // stuck on "Preparing connection…"). Deduping collapses it to the live
    // runtime. (Same class of bug as the dexie/@miden-sdk duplication.)
    dedupe: ['@capacitor/core'],
    // NOTE: the eager→lazy @miden-sdk/miden-sdk redirect is done by the
    // `miden-sdk-eager-to-lazy` plugin above (resolveId), NOT here. A
    // resolve.alias entry can't win: @miden-sdk/vite-plugin installs its own
    // `^@miden-sdk/miden-sdk$` alias (→ package dir → eager) that takes
    // precedence in the alias array.
    alias: {
      lib: resolve(__dirname, 'src/lib'),
      app: resolve(__dirname, 'src/app'),
      shared: resolve(__dirname, 'src/shared'),
      components: resolve(__dirname, 'src/components'),
      screens: resolve(__dirname, 'src/screens'),
      utils: resolve(__dirname, 'src/utils'),
      stories: resolve(__dirname, 'src/stories'),
      // Mock webextension-polyfill for mobile
      'webextension-polyfill': resolve(__dirname, 'src/lib/webextension-polyfill-mock.js')
    }
  },

  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
    'process.env.MIDEN_PLATFORM': JSON.stringify('mobile'),
    'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'),
    // Issue #260: hardcoded OFF on mobile — Capacitor / WKWebView / Android
    // WebView have no chrome.offscreen document to rehost the client into.
    'process.env.MIDEN_USE_OFFSCREEN_CLIENT': JSON.stringify('false'),
    'process.env.MIDEN_NETWORK': JSON.stringify(process.env.MIDEN_NETWORK ?? ''),
    'process.env.MIDEN_NOTE_TRANSPORT_URL': JSON.stringify(process.env.MIDEN_NOTE_TRANSPORT_URL ?? ''),
    'process.env.MIDEN_E2E_TEST': JSON.stringify(process.env.MIDEN_E2E_TEST ?? 'false'),
    // E2E behaviour opt-outs — see vite.extension.config.ts. Default 'false'.
    // (The side-panel one is inert on mobile — no chrome.sidePanel — but it is
    // still defined so the read folds to a constant like every other flag here;
    // the shared onboarding code that reads it is in this bundle too.)
    'process.env.MIDEN_E2E_DISABLE_SIDEPANEL': JSON.stringify(process.env.MIDEN_E2E_DISABLE_SIDEPANEL ?? 'false'),
    'process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES': JSON.stringify(
      process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES ?? 'false'
    ),
    'process.env.MIDEN_ENABLE_BRIDGE_UI': JSON.stringify(process.env.MIDEN_ENABLE_BRIDGE_UI ?? 'false'),
    'process.env.E2E_EVM_RPC_URL': JSON.stringify(process.env.E2E_EVM_RPC_URL ?? ''),
    'process.env.WALLETCONNECT_PROJECT_ID': JSON.stringify(
      process.env.WALLETCONNECT_PROJECT_ID ?? 'b54ef53f878d160bf63c6eae3a567e67'
    ),
    'process.env.EPOCH_ALLOCATOR_URL': JSON.stringify(
      process.env.EPOCH_ALLOCATOR_URL ?? 'https://testnet-dev.epochprotocol.xyz'
    ),
    'process.env.EPOCH_POSITIONS_URL': JSON.stringify(
      process.env.EPOCH_POSITIONS_URL ?? 'https://positions-testnet-dev.epochprotocol.xyz'
    ),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
    // Mobile (Capacitor / WKWebView / Android WebView) cannot use the
    // chrome.offscreen path — that API only exists in Chrome MV3 extensions.
    // Force the flag false at build time so a stray shell env never opts
    // mobile into a code path it can't run. The runtime guard
    // (isOffscreenAvailable) also catches it, but pinning the build-time
    // constant lets dead-code elimination drop the offscreen import entirely.
    'process.env.MIDEN_USE_OFFSCREEN_PROVING': JSON.stringify('false'),
    // Speculative pre-prove also pinned false on mobile: speculation
    // dispatches the prove to a chrome.offscreen document, which doesn't
    // exist in WKWebView/Capacitor. Without offscreen, there's nothing
    // to speculate against.
    'process.env.MIDEN_USE_SPECULATIVE_PROVING': JSON.stringify('false'),
    'process.env.TELEMETRY_INGEST_URL': JSON.stringify(process.env.TELEMETRY_INGEST_URL ?? ''),
    'process.browser': 'true',
    global: 'globalThis'
  }
});
