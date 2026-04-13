import { resolve } from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import { defineConfig, type Plugin } from 'vite';

const pkg = require('./package.json');
const TARGET_BROWSER = process.env.TARGET_BROWSER ?? 'chrome';

export default defineConfig({
  plugins: [
    // Stub SVG imports -- the background SW doesn't render UI, but the
    // dependency chain pulls in components that import SVGs.
    {
      name: 'svg-stub',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.svg')) {
          return 'export const ReactComponent = () => null; export default "";';
        }
      },
    } satisfies Plugin,
    // Patch the output for service worker compatibility:
    // 1. Replace document/window refs in Vite's preload helper with SW-safe versions
    // 2. Inject early intercom handler at the TOP of the file, before any TLA from
    //    WASM module evaluation blocks execution
    {
      name: 'sw-patches',
      enforce: 'post',
      generateBundle(_, bundle) {
        for (const [, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code) continue;

          // Patch document/window references
          chunk.code = chunk.code
            .replace(/document\.getElementsByTagName\([^)]*\)/g, '[]')
            .replace(/document\.querySelector\([^)]*\)/g, 'null')
            .replace(/document\.head\.appendChild\([^)]*\)/g, 'undefined')
            .replace(/document\.createElement\([^)]*\)/g, '({setAttribute(){},addEventListener(){}})')
            .replace(/\bwindow\.dispatchEvent\b/g, 'self.dispatchEvent');

          // Strip top-level await statements. Chrome MV3 service workers
          // won't register ESM modules that contain any TLA. Rolldown wraps
          // every module in __esmMin() with TLA for lazy init. We convert
          // these to fire-and-forget so the SW registers instantly.
          // The module init functions still run -- just not blocking.
          chunk.code = chunk.code.replace(/^await /gm, '/* tla-stripped */ ');

          // Replace __vitePreload calls with direct function calls.
          // __vitePreload is set inside init_preload_helper() which runs
          // fire-and-forget after TLA stripping, so it's undefined when
          // loadWasm() tries to use it.
          // Replace __vitePreload with a simple passthrough.
          // __vitePreload(fn, deps) normally calls fn() after preloading deps.
          // Since the preload helper isn't initialized (TLA stripped), we just
          // call fn() directly. Define __vitePreload as a passthrough at the
          // top of the file.
          // Define __vitePreload passthrough.
          // Also eagerly run init_preload_helper which sets up __vitePreload
          // (overriding our passthrough once ready), and the Buffer polyfill shim.
          chunk.code = [
            'var __vitePreload = function(fn) { return fn(); };',
            '// Eagerly init the preload helper and polyfill shims',
            'setTimeout(function() { try { init_preload_helper(); } catch(e) {} }, 0);',
            '',
          ].join('\n') + chunk.code;

          // Collect all init_* calls that were stripped and re-inject them
          // inside start(), AFTER the intercom handler registration.
          const initCalls: string[] = [];
          chunk.code.replace(/\/\* tla-stripped \*\/ (init_\w+\(\));?/g, (_m: string, call: string) => {
            initCalls.push(call.replace(/;$/, ''));
            return '';
          });
          const uniqueInits = [...new Set(initCalls)];
          // Exclude init_miden_client -- it loads WASM which resolves async.
          // All other inits resolve synchronously once their dependencies are met.
          const criticalInits = uniqueInits.filter(c => !c.includes('init_miden_client'));
          if (criticalInits.length > 0) {
            const initBlock = criticalInits.map(c => `  await ${c};`).join('\n');
            chunk.code = chunk.code.replace(
              /intercom\$?\d*\.onRequest\(processRequest\);/,
              `$&\n  // Re-await critical module inits\n${initBlock}`
            );
          }

          // No banner needed -- the IntercomServer now handles GetStateRequest
          // directly when no handler is registered (returns Idle state).
          // The MV3 listeners (onInstalled, onConnect, etc.) are in
          // background-entry.ts which Vite inlines into this file.
        }
      },
    } satisfies Plugin,
    wasm(),
    nodePolyfills({
      include: ['buffer', 'stream', 'assert', 'process'],
      globals: { Buffer: true, process: true },
    }),
  ],

  build: {
    outDir: `dist/${TARGET_BROWSER}_unpacked`,
    emptyOutDir: false, // webpack app output lives here too
    rollupOptions: {
      input: resolve(__dirname, 'src/background-entry.ts'),
      output: {
        entryFileNames: 'background.js',
        // Single file, IIFE format -- loaded via importScripts() from sw.js.
        // Chrome extension SWs don't support dynamic import() or ESM modules
        // reliably in all environments (Playwright's Chrome for Testing).
        inlineDynamicImports: true,
        assetFileNames: 'static/wasm/[name].[hash][extname]',
        format: 'es',
      },
    },
    sourcemap: process.env.MODE_ENV !== 'production',
    target: 'es2022',
    minify: process.env.MODE_ENV === 'production',
    modulePreload: { polyfill: false }, // No polyfill -- service workers don't have `document`
  },

  worker: {
    format: 'es', // Workers need ESM for top-level await support
  },

  resolve: {
    alias: {
      lib: resolve(__dirname, 'src/lib'),
      app: resolve(__dirname, 'src/app'),
      shared: resolve(__dirname, 'src/shared'),
      components: resolve(__dirname, 'src/components'),
      screens: resolve(__dirname, 'src/screens'),
      utils: resolve(__dirname, 'src/utils'),
    },
  },

  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
    'process.env.TARGET_BROWSER': JSON.stringify(TARGET_BROWSER),
    'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'),
    'process.env.MIDEN_DEFAULT_NETWORK': JSON.stringify(process.env.MIDEN_DEFAULT_NETWORK ?? ''),
    'process.env.MIDEN_E2E_TEST': JSON.stringify(process.env.MIDEN_E2E_TEST ?? 'false'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
  },
});
