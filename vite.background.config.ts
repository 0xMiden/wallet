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

          // Only patch the entry chunk (background.js)
          if (!chunk.fileName.includes('background')) continue;

          // Inject early intercom handler at the very top, BEFORE any module code.
          // This is critical: the WASM SDK's top-level await blocks the entire
          // module from evaluating. Without this banner, the intercom handler
          // (registered inside start()) never runs until WASM finishes compiling,
          // leaving the UI on a blank loading screen.
          const earlyHandler = `
// ── Early SW intercom handler (injected by vite.background.config.ts) ──────
// Responds to GET_STATE_REQUEST and SYNC_REQUEST immediately, before the
// WASM SDK finishes compiling. The full handler in background.ts takes over
// once the module evaluation completes.
(function() {
  var _earlyActive = true;
  // Disable early handler once full background loads
  self.__disableEarlyHandler = function() { _earlyActive = false; };

  chrome.runtime.onInstalled.addListener(function(details) {
    if (details.reason === 'install') {
      chrome.storage.local.set({ fresh_install: true });
      chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
    }
  });

  chrome.runtime.onConnect.addListener(function(port) {
    if (port.name === 'Popup Connection') {
      port.onDisconnect.addListener(function() {
        chrome.storage.local.set({ 'last-page-closure-timestamp': Date.now().toString() });
      });
    }
    // Handle intercom messages (port name: 'INTERCOM')
    port.onMessage.addListener(function(msg) {
      if (!_earlyActive || !msg || msg.type !== 'INTERCOM_REQUEST') return;
      var reqType = msg.data && msg.data.type;
      if (reqType === 'GET_STATE_REQUEST') {
        chrome.storage.local.get('vault_check', function(stored) {
          var vaultExists = stored && stored['vault_check'] !== undefined;
          try {
            port.postMessage({
              type: 'INTERCOM_RESPONSE', reqId: msg.reqId,
              data: { type: 'GET_STATE_RESPONSE', state: {
                status: vaultExists ? 1 : 0,
                accounts: [], currentAccount: null,
                networks: [], settings: null, ownMnemonic: null
              }}
            });
          } catch(e) {}
        });
      } else if (reqType === 'SYNC_REQUEST') {
        try {
          port.postMessage({ type: 'INTERCOM_RESPONSE', reqId: msg.reqId, data: { type: 'SYNC_RESPONSE' } });
        } catch(e) {}
      }
    });
  });

  chrome.runtime.onMessage.addListener(function() { console.debug('Ping worker'); });
  self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(self.clients.openWindow(chrome.runtime.getURL('fullpage.html#/receive')));
  });
})();
// ── End early handler ──────────────────────────────────────────────────────

`;
          chunk.code = earlyHandler + chunk.code;
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
