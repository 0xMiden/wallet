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
        return html.replace(/ crossorigin/g, '');
      },
      closeBundle() {
        const { renameSync, existsSync } = require('fs');
        const src = resolve(__dirname, 'dist/mobile/mobile.html');
        const dest = resolve(__dirname, 'dist/mobile/index.html');
        if (existsSync(src)) renameSync(src, dest);
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

  publicDir: false, // Our build handles public assets; prevents overwriting processed HTML

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
        // Single bundle like webpack — Capacitor's local server has issues
        // with ES module loading (import statements at top level).
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
    format: 'es',
  },
});
