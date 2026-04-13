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
            .replace(/\bwindow\.dispatchEvent\b/g, 'self.dispatchEvent')
            // Prevent handlePreloadError from throwing -- SW can't handle preload errors
            .replace(
              /if \(!e\.defaultPrevented\) throw err;/g,
              'if (!e.defaultPrevented) { console.warn("[vitePreload] SW error:", err); }'
            );

          // Strip TLA for ESM module SW compatibility
          chunk.code = chunk.code.replace(/^await /gm, '/* tla-stripped */ ');

          // Override __vitePreload with a SW-safe passthrough.
          // The init_preload_helper (run fire-and-forget) would set __vitePreload
          // to a function that accesses `document` which doesn't exist in SW.
          // We make __vitePreload non-writable so init_preload_helper can't overwrite it.
          // Define __vitePreload as a SW-safe passthrough. This MUST persist
          // even after init_preload_helper runs, because the real preload
          // function accesses `document` which doesn't exist in SW.
          // Our sw-no-preload patches above already replace document.* calls
          // with safe stubs, so even if init_preload_helper overwrites
          // __vitePreload, the patched version is SW-safe.
          chunk.code = 'var __vitePreload = function(fn) { return fn(); };\n' + chunk.code;

          // Re-inject ALL init awaits inside start()
          const initCalls: string[] = [];
          chunk.code.replace(/\/\* tla-stripped \*\/ (init_[\w$]+\(\));?/g, (_m: string, call: string) => {
            initCalls.push(call.replace(/;$/, ''));
            return '';
          });
          const uniqueInits = [...new Set(initCalls)];
          if (uniqueInits.length > 0) {
            const initBlock = uniqueInits.map(c => `  await ${c};`).join('\n');
            // Create a Promise that resolves when all inits are done.
            chunk.code = chunk.code.replace(
              /intercom\$?\d*\.onRequest\(processRequest\);/,
              [
                '$&',
                '  // Module init Promise -- processRequest awaits this before handling operations',
                '  var __initsReady = (async function() {',
                initBlock,
                '  })();',
              ].join('\n')
            );
            // processRequest awaits inits for any request except GetStateRequest/SyncRequest
            // (those are handled early via getFrontState's Idle fallback)
            chunk.code = chunk.code.replace(
              /async function processRequest\(req[^)]*\)\s*\{/,
              '$&\n  if (req?.type !== "GET_STATE_REQUEST" && req?.type !== "SYNC_REQUEST") { await __initsReady; }'
            );
          }
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
