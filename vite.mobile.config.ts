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
          // Use defer instead of type="module" — WKWebView may not load ESM modules
          .replace(' type="module"', ' defer')
          .replace(/<link rel="modulepreload"[^>]*>\n?/g, '');
      },
      generateBundle(_, bundle) {
        for (const [, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code) continue;
          // ── Mobile-specific patches (same approach as extension SW build) ──
          // 1. Replace import.meta.url for classic script
          chunk.code = chunk.code.replace(/import\.meta\.url/g, '(document.currentScript&&document.currentScript.src||self.location.href)');
          // 2. Strip Worker module type
          chunk.code = chunk.code.replace(/,\s*\{\s*type:\s*"module"\s*\}/g, '');
          // 3. Skip WASM init on main thread (Worker handles it)
          chunk.code = chunk.code.replace(/\tawait __wbg_init[^;]+;/g, '\t/* wasm-skipped */');
          chunk.code = chunk.code.replace(/__wbg_finalize_init[^;]+;/g, '/* finalize-skipped */;');
          // 4. Strip ALL TLAs — convert to fire-and-forget
          chunk.code = chunk.code.replace(/^await /gm, '/* tla */ ');
          chunk.code = chunk.code.replace(/\tawait (init_\w+\(\))/g, '\t/* tla */ $1');
          // 5. Wrap in async IIFE (classic script can't have TLA remnants in inner async fns)
          chunk.code = '(async function(){' + chunk.code + '})().catch(function(e){console.error("[mobile]",e)});';
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
