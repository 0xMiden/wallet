/**
 * Vite config for the mobile (Capacitor) build.
 * Single entry point, webextension-polyfill mocked.
 */
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig, type Plugin } from 'vite';

const pkg = require('./package.json');

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    // Capacitor expects index.html. Vite outputs mobile.html (matching the input name).
    // Also strip crossorigin attrs — WKWebView uses capacitor:// scheme where CORS is N/A.
    {
      name: 'mobile-html-fixes',
      transformIndexHtml(html) {
        return html
          .replace(/ crossorigin/g, '')
          // Keep type="module" — module-scope TLAs (now sync calls) still use ESM
          .replace(/<link rel="modulepreload"[^>]*>\n?/g, '');
      },
      generateBundle(_, bundle) {
        for (const [, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code) continue;
          // ── Synchronous module init (emulates webpack's async module runtime) ──
          //
          // Key insight: __esmMin factories are async but execute synchronously up
          // to their first real `await`. By calling them WITHOUT `await` at module
          // scope, all the synchronous variable assignments complete immediately.
          // The async remainder (WASM compile) runs in background — we skip it.
          //
          // This is equivalent to webpack's module runtime: sync execution of
          // factory bodies, with async deps (WASM) handled separately.

          // 1. Replace import.meta.url for classic script
          chunk.code = chunk.code.replace(/import\.meta\.url/g, '(document.currentScript&&document.currentScript.src||self.location.href)');
          // 2. Strip Worker module type
          chunk.code = chunk.code.replace(/,\s*\{\s*type:\s*"module"\s*\}/g, '');
          // 3. Strip `await` from module-scope init_*() calls — make them sync.
          //    The __esmMin factories stay async internally (legal inside their functions)
          //    but are CALLED synchronously so their sync code runs immediately.
          chunk.code = chunk.code.replace(/^await (init_\w+\(\))/gm, '$1');
          // Also strip indented await init_*() inside factories (chain ordering)
          chunk.code = chunk.code.replace(/\tawait (init_\w+\(\))/g, '\t$1');
          // 4. Skip WASM init and finalize (Worker handles WASM)
          chunk.code = chunk.code.replace(/\tawait __wbg_init[^;]+;/g, '\t/* wasm-skipped */');
          chunk.code = chunk.code.replace(/__wbg_finalize_init[^;]+;/g, '/* finalize-skipped */;');
          // 5. No wrapping needed — keep as type="module" ESM for the remaining
          //    async code (initMobile is async and uses await internally)
        }
      },
      closeBundle() {
        const { renameSync, existsSync, copyFileSync, readdirSync } = require('fs');
        const src = resolve(__dirname, 'dist/mobile/mobile.html');
        const dest = resolve(__dirname, 'dist/mobile/index.html');
        if (existsSync(src)) renameSync(src, dest);
        // Copy WASM to unhashed path for the worker (which uses /assets/miden_client_web.wasm)
        const assetsDir = resolve(__dirname, 'dist/mobile/assets');
        if (existsSync(assetsDir)) {
          for (const f of readdirSync(assetsDir)) {
            if (f.startsWith('miden_client_web') && f.endsWith('.wasm')) {
              copyFileSync(resolve(assetsDir, f), resolve(assetsDir, 'miden_client_web.wasm'));
              break;
            }
          }
        }
      },
    } satisfies Plugin,
    // SVG → React component transform
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
        const jsxCode = await transform(svgContent, {
          plugins: ['@svgr/plugin-jsx'],
          exportType: 'named',
          namedExport: 'ReactComponent',
          jsxRuntime: 'automatic',
        }, { filePath });
        return { code: jsxCode + '\nexport default "";', moduleType: 'jsx' };
      },
    } satisfies Plugin,
    wasm(),
    nodePolyfills({
      include: ['buffer', 'stream', 'assert', 'process', 'util'],
      globals: { Buffer: true, process: true },
    }),
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
    minify: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, 'mobile.html'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: 'static/[name].[hash][extname]',
        inlineDynamicImports: true,
      },
    },
  },


  resolve: {
    alias: {
      lib: resolve(__dirname, 'src/lib'),
      app: resolve(__dirname, 'src/app'),
      shared: resolve(__dirname, 'src/shared'),
      components: resolve(__dirname, 'src/components'),
      screens: resolve(__dirname, 'src/screens'),
      utils: resolve(__dirname, 'src/utils'),
      stories: resolve(__dirname, 'src/stories'),
      // Mock webextension-polyfill for mobile
      'webextension-polyfill': resolve(__dirname, 'src/lib/webextension-polyfill-mock.js'),
    },
  },

  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
    'process.env.MIDEN_PLATFORM': JSON.stringify('mobile'),
    'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'),
    'process.env.MIDEN_NETWORK': JSON.stringify(process.env.MIDEN_NETWORK ?? ''),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
    'process.browser': 'true',
    'global': 'globalThis',
  },

  worker: {
    // ESM workers — the SDK's WASM glue has TLA which requires ESM.
    // WKWebView doesn't support module workers, so mobile WASM loading
    // hangs on iOS. This needs an SDK fix: wrap TLA in async function.
    format: 'es',
  },
});
