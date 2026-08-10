/**
 * Vite config for the desktop (Tauri) build.
 * Single entry point. Tauri has native Vite support.
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';

const pkg = require('./package.json');

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
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
        return { code: jsxCode + '\nexport default "";', moduleType: 'jsx' };
      }
    } satisfies Plugin,
    wasm(),
    nodePolyfills({
      include: ['buffer', 'stream', 'assert', 'process'],
      globals: { Buffer: true, process: true }
    })
  ],

  build: {
    outDir: 'dist/desktop',
    emptyOutDir: true,
    sourcemap: process.env.MODE_ENV !== 'production',
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'desktop.html'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: 'static/[name].[hash][extname]'
      }
    }
  },

  resolve: {
    // The file-linked web-sdk (@miden-sdk/miden-sdk 0.14.10) and the multisig-client's
    // nested @miden-sdk/miden-sdk (0.14.5) each INLINE their own dexie (4.4.2 vs 4.0.8)
    // into their wasm-glue chunks. Two different dexie versions trip dexie's global guard
    // ("Two different versions of Dexie loaded in the same app"). Dedupe @miden-sdk/miden-sdk
    // so only the single root copy (0.14.10) is ever resolved — this also prevents two
    // separate WebClient/WASM instances. Dedupe dexie too for any non-inlined imports
    // (root dexie is pinned to 4.4.2 via package.json resolutions).
    dedupe: ['dexie', '@miden-sdk/miden-sdk'],
    alias: {
      lib: resolve(__dirname, 'src/lib'),
      app: resolve(__dirname, 'src/app'),
      shared: resolve(__dirname, 'src/shared'),
      components: resolve(__dirname, 'src/components'),
      screens: resolve(__dirname, 'src/screens'),
      utils: resolve(__dirname, 'src/utils'),
      stories: resolve(__dirname, 'src/stories')
    }
  },

  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
    'process.env.MIDEN_PLATFORM': JSON.stringify('desktop'),
    'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'),
    'process.env.MIDEN_NETWORK': JSON.stringify(process.env.MIDEN_NETWORK ?? ''),
    'process.env.MIDEN_DEFAULT_NETWORK': JSON.stringify(process.env.MIDEN_DEFAULT_NETWORK ?? ''),
    'process.env.MIDEN_ENABLE_BRIDGE_UI': JSON.stringify(process.env.MIDEN_ENABLE_BRIDGE_UI ?? 'false'),
    'process.env.WALLETCONNECT_PROJECT_ID': JSON.stringify(
      process.env.WALLETCONNECT_PROJECT_ID ?? 'b54ef53f878d160bf63c6eae3a567e67'
    ),
    'process.env.EPOCH_ALLOCATOR_URL': JSON.stringify(
      process.env.EPOCH_ALLOCATOR_URL ?? 'https://testnet-dev.epochprotocol.xyz'
    ),
    'process.env.EPOCH_POSITIONS_URL': JSON.stringify(
      process.env.EPOCH_POSITIONS_URL ?? 'https://positions-testnet-dev.epochprotocol.xyz'
    ),
    'process.env.E2E_EVM_RPC_URL': JSON.stringify(process.env.E2E_EVM_RPC_URL ?? ''),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
    'process.browser': 'true',
    global: 'globalThis'
  },

  server: {
    port: 3000
  },

  worker: {
    format: 'es'
  }
});
