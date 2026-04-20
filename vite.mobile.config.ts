/**
 * Vite config for the mobile (Capacitor) build.
 * Single entry point, webextension-polyfill mocked.
 */
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { midenVitePlugin } from '@miden-sdk/vite-plugin';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig, type Plugin } from 'vite';

const pkg = require('./package.json');

export default defineConfig({
  plugins: [
    midenVitePlugin({
      rpcProxyTarget: process.env.MIDEN_NETWORK === 'devnet'
        ? 'https://rpc.devnet.miden.io'
        : 'https://rpc.testnet.miden.io',
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
      },
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
        const jsxCode = await transform(svgContent, {
          plugins: ['@svgr/plugin-jsx'],
          exportType: 'named',
          namedExport: 'ReactComponent',
          jsxRuntime: 'automatic',
        }, { filePath });
        // Emit the SVG as a Vite asset so we get a hashed URL for the default
        // export. `this.emitFile` returns a reference id that Vite rewrites to
        // the final URL at bundle time.
        const refId = this.emitFile({
          type: 'asset',
          name: filePath.split('/').pop(),
          source: svgContent,
        });
        return {
          code: `${jsxCode}\nexport default import.meta.ROLLUP_FILE_URL_${refId};`,
          moduleType: 'jsx',
        };
      },
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
    'process.env.MIDEN_E2E_TEST': JSON.stringify(process.env.MIDEN_E2E_TEST ?? 'false'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
    'process.browser': 'true',
    'global': 'globalThis',
  },
});
