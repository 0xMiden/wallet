import { midenVitePlugin } from '@miden-sdk/vite-plugin';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';

import { copyClassicWorkerWasm } from '../../../src/lib/build-assets/worker-wasm-assets';

const walletRoot = resolve(import.meta.dirname, '../../..');
const require = createRequire(resolve(walletRoot, 'package.json'));
const sdkRoot = dirname(require.resolve('@miden-sdk/miden-sdk/package.json'));
const mode = process.env.WALLET_MATRIX_MODE === 'mt' ? 'mt' : 'st';
const sdkLazy = resolve(sdkRoot, mode === 'mt' ? 'dist/mt/index.js' : 'dist/st/index.js');
const mock = false;
const output = resolve(process.env.WALLET_MATRIX_BUILD_ROOT ?? resolve(import.meta.dirname, 'builds'), mode);
const sdkSpecifier = /^@miden-sdk\/miden-sdk(?:\/(?:lazy|mt(?:\/lazy)?))?$/;
const exactSdk: Plugin = {
  name: 'wallet-proof-one-exact-sdk',
  enforce: 'pre',
  resolveId(id) {
    if (
      sdkSpecifier.test(id) ||
      id === sdkRoot ||
      /^dist\/(?:st|mt)\/(?:eager|index)\.js$/.test(id.slice(sdkRoot.length + 1))
    )
      return sdkLazy;
    return null;
  }
};
const svg: Plugin = {
  name: 'wallet-proof-real-svg-transform',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.endsWith('.svg') && importer) return resolve(dirname(importer), source) + '?factory-svg';
  },
  async load(id) {
    if (!id.endsWith('?factory-svg')) return;
    const filePath = id.slice(0, -'?factory-svg'.length);
    const { transform } = await import('@svgr/core');
    const jsx = await transform(
      readFileSync(filePath, 'utf8'),
      {
        plugins: ['@svgr/plugin-jsx'],
        exportType: 'named',
        namedExport: 'ReactComponent',
        jsxRuntime: 'classic'
      },
      { filePath }
    );
    const asset = this.emitFile({ type: 'asset', name: filePath.split('/').pop(), source: readFileSync(filePath) });
    const code = `${jsx}\nexport default import.meta.ROLLUP_FILE_URL_${asset};`;
    const compiled = await transformWithOxc(code, id, { lang: 'jsx', jsx: { runtime: 'classic' } });
    return { code: compiled.code, map: compiled.map, moduleType: 'js' };
  }
};

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  publicDir: false,
  plugins: [
    exactSdk,
    midenVitePlugin({ rpcProxyTarget: false, crossOriginIsolation: true }),
    react(),
    tailwind(),
    svg,
    wasm(),
    nodePolyfills({
      include: ['buffer', 'stream', 'assert', 'process', 'util'],
      globals: { Buffer: true, process: true }
    }),
    {
      name: 'wallet-proof-classic-assets',
      closeBundle() {
        copyClassicWorkerWasm(output);
      }
    }
  ],
  resolve: {
    dedupe: ['dexie', '@miden-sdk/miden-sdk', 'react', 'react-dom', '@miden-sdk/react'],
    alias: [
      { find: sdkSpecifier, replacement: sdkLazy },
      ...['app', 'components', 'lib', 'screens', 'shared', 'utils'].map(name => ({
        find: new RegExp(`^${name}/`),
        replacement: resolve(walletRoot, 'src', name) + '/'
      })),
      { find: /^webextension-polyfill$/, replacement: resolve(walletRoot, 'src/lib/webextension-polyfill-mock.js') }
    ]
  },
  define: {
    'process.env.WALLET_MATRIX_MODE': JSON.stringify(mode),
    global: 'globalThis',
    'process.env': JSON.stringify({
      NODE_ENV: 'test',
      MODE_ENV: 'development',
      VERSION: '1.17.7',
      MIDEN_PLATFORM: 'web',
      MIDEN_NETWORK: 'localnet',
      MIDEN_USE_MOCK_CLIENT: mock ? 'true' : 'false',
      MIDEN_USE_OFFSCREEN_CLIENT: 'false',
      MIDEN_USE_OFFSCREEN_PROVING: 'false',
      MIDEN_E2E_TEST: 'false',
      MIDEN_NOTE_TRANSPORT_URL: '',
      APTABASE_APP_KEY: '',
      APTABASE_HOST: '',
      SENTRY_DSN: '',
      FEATURE_ELIGIBILITY_URL: ''
    })
  },
  build: {
    outDir: output,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    manifest: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(import.meta.dirname, 'index.html'),
      output: { assetFileNames: 'static/[name].[hash][extname]' }
    }
  },
  worker: { format: 'es', rollupOptions: { output: { format: 'es', assetFileNames: 'static/[name].[hash][extname]' } } }
});
