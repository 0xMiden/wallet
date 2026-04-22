import { resolve } from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import { defineConfig, type Plugin } from 'vite';

const pkg = require('./package.json');
const TARGET_BROWSER = process.env.TARGET_BROWSER ?? 'chrome';

export default defineConfig({
  plugins: [
    // Stub SVG imports and CSS modules -- the background SW doesn't render UI.
    {
      name: 'sw-asset-stubs',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.svg')) {
          return 'export const ReactComponent = () => null; export default "";';
        }
        if (id.endsWith('.css') || id.endsWith('.scss')) {
          return 'export default {};';
        }
      }
    } satisfies Plugin,
    // Stub React and frontend-only modules to prevent DOM/browser API access
    // in the service worker. The backend code transitively imports these
    // through the dapp → activity → store (Zustand) chain.
    {
      name: 'sw-frontend-stubs',
      enforce: 'pre',
      resolveId(source) {
        // Stub out modules that can't work in SW
        const stubModules = [
          'react-i18next',
          'i18next',
          'i18next-browser-languagedetector',
          'framer-motion',
          'react-day-picker',
          'react-qr-code',
          'qr-scanner',
          '@nicolo-ribaudo/chokidar-2'
        ];
        if (stubModules.some(m => source === m || source.startsWith(m + '/'))) {
          return '\0stub:' + source;
        }
      },
      load(id) {
        if (id.startsWith('\0stub:')) {
          return 'export default {}; export const useTranslation = () => ({ t: (k) => k, i18n: {} });';
        }
      }
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

          // Break circular init deadlocks in the Zustand store (init_store) chain.
          // init_store → init_fetchBalances → (init_prices, init_assets, ...) → init_store
          // Many frontend modules await init_store, creating circular deadlocks when
          // init_store's own factory awaits init_fetchBalances. Fix: make init_store
          // NOT await init_fetchBalances. The fetchBalances module only defines runtime
          // functions; the store doesn't need it at creation time.
          chunk.code = chunk.code.replace(
            /(var init_store = __esmMin\(\(async \(\) => \{[\s\S]*?)await (init_fetchBalances\(\))/,
            '$1$2'
          );

          // Instrument init_transactions with logging to find which await hangs.
          // This replaces each `await init_*()` inside init_transactions with a
          // logged version so we can see exactly where it gets stuck.
          chunk.code = chunk.code.replace(
            /var init_transactions = __esmMin\(\(async \(\) => \{([\s\S]*?)\}\)\);/,
            (match, body) => {
              let counter = 0;
              const instrumented = body.replace(/(?:await )?(init_\w+\(\))/g, (m, call) => {
                counter++;
                const hasAwait = m.startsWith('await ');
                if (hasAwait) {
                  return `console.log("[init_transactions] ${counter}: await ${call}..."); await ${call}; console.log("[init_transactions] ${counter}: ${call} done")`;
                }
                return `console.log("[init_transactions] ${counter}: ${call}"); ${call}`;
              });
              return `var init_transactions = __esmMin((async () => {${instrumented}}));`;
            }
          );

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
          // Inject synchronous MV3 event listeners at the very top of the file,
          // BEFORE any module evaluation or async work. Chrome requires these to be
          // registered in the first turn of the event loop.
          const swListeners = [
            '// ── MV3 synchronous event listeners (must be first) ──',
            'chrome.runtime.onInstalled.addListener(function(details) {',
            '  if (details.reason === "install") {',
            '    chrome.storage.local.set({ fresh_install: true });',
            '    chrome.tabs.create({ url: chrome.runtime.getURL("fullpage.html") });',
            '  }',
            '});',
            'chrome.runtime.onConnect.addListener(function(port) {',
            '  if (port.name === "Popup Connection") {',
            '    port.onDisconnect.addListener(async function() {',
            '      await chrome.storage.local.set({ "last-page-closure-timestamp": Date.now().toString() });',
            '    });',
            '  }',
            '});',
            'chrome.runtime.onMessage.addListener(function() { console.debug("Ping worker"); });',
            'self.addEventListener("notificationclick", function(event) {',
            '  event.notification.close();',
            '  event.waitUntil(self.clients.openWindow(chrome.runtime.getURL("fullpage.html#/receive")));',
            '});',
            ''
          ].join('\n');
          chunk.code = swListeners + 'var __vitePreload = function(fn) { return fn(); };\n' + chunk.code;

          // Re-inject ALL init awaits inside start()
          const initCalls: string[] = [];
          chunk.code.replace(/\/\* tla-stripped \*\/ (init_[\w$]+\(\));?/g, (_m: string, call: string) => {
            initCalls.push(call.replace(/;$/, ''));
            return '';
          });
          const uniqueInits = [...new Set(initCalls)];
          // Separate inits into core (must complete) and extended (may hang).
          // init_actions → init_dapp → init_activity never resolves because
          // init_activity imports the frontend Zustand store which has a deep
          // dependency chain that hangs in SW context. Similarly init_transaction_processor
          // depends on init_activity. We run these fire-and-forget after core inits.
          const coreInits = uniqueInits.filter(
            c => !c.includes('init_actions') && !c.includes('init_transaction_processor')
          );
          const extendedInits = uniqueInits.filter(
            c => c.includes('init_actions') || c.includes('init_transaction_processor')
          );
          if (coreInits.length > 0) {
            // Create a Promise that resolves when core inits are done.
            // Define __initsReady at MODULE SCOPE so processRequest can access it.
            const coreInitBlock = coreInits.map(c => `  await ${c};`).join('\n');
            const extendedInitBlock = extendedInits
              .map(
                c =>
                  `    ${c}.catch(function(e) { console.warn("[SW-init] ${c.replace('()', '')} error:", e?.message || e); })`
              )
              .join(',\n');
            chunk.code = chunk.code.replace(
              /async function processRequest/,
              [
                '// Phase 1: Core module inits (must complete for wallet operations)',
                'var __initsReady = (async function() {',
                coreInitBlock,
                '  await init();', // Actions.init() - sets state.inited
                '  // Phase 2: Extended inits (may hang due to frontend module deps)',
                '  // Run fire-and-forget with a 30s timeout',
                extendedInitBlock.length > 0
                  ? [
                      '  Promise.race([',
                      '    Promise.all([',
                      extendedInitBlock,
                      '    ]),',
                      '    new Promise(function(r) { setTimeout(r, 30000); })',
                      '  ]).then(function() { console.log("[SW-init] Extended inits completed"); })',
                      '   .catch(function() {});'
                    ].join('\n')
                  : '',
                '})();',
                '',
                'async function processRequest'
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
      }
    } satisfies Plugin,
    wasm(),
    nodePolyfills({
      include: ['buffer', 'stream', 'assert', 'process', 'util'],
      globals: { Buffer: true, process: true }
    })
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
        format: 'es'
      }
    },
    sourcemap: process.env.MODE_ENV !== 'production',
    target: 'es2022',
    minify: process.env.MODE_ENV === 'production',
    modulePreload: { polyfill: false } // No polyfill -- service workers don't have `document`
  },

  worker: {
    format: 'es' // Workers need ESM for top-level await support
  },

  resolve: {
    alias: {
      lib: resolve(__dirname, 'src/lib'),
      app: resolve(__dirname, 'src/app'),
      shared: resolve(__dirname, 'src/shared'),
      components: resolve(__dirname, 'src/components'),
      screens: resolve(__dirname, 'src/screens'),
      utils: resolve(__dirname, 'src/utils')
    }
  },

  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
    'process.env.TARGET_BROWSER': JSON.stringify(TARGET_BROWSER),
    'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'),
    'process.env.MIDEN_NETWORK': JSON.stringify(process.env.MIDEN_NETWORK ?? ''),
    'process.env.MIDEN_NOTE_TRANSPORT_URL': JSON.stringify(process.env.MIDEN_NOTE_TRANSPORT_URL ?? ''),
    'process.env.MIDEN_E2E_TEST': JSON.stringify(process.env.MIDEN_E2E_TEST ?? 'false'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development')
  }
});
