/**
 * Vite config for Chrome-extension content scripts.
 *
 * Chrome MV3 content_scripts (and scripts injected into the page via
 * `document.createElement('script')` without `type="module"`) run as
 * CLASSIC scripts. ES-module output with `import` statements fails to
 * parse silently, leaving window.midenWallet never set.
 *
 * This config builds a single entry at a time as an IIFE with all
 * dynamic imports inlined. Invoke once per entry via CS_ENTRY:
 *   CS_ENTRY=contentScript vite build --config vite.contentScripts.config.ts
 *   CS_ENTRY=addToWindow  vite build --config vite.contentScripts.config.ts
 */
import { resolve } from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { defineConfig, type Plugin } from 'vite';

const pkg = require('./package.json');
const TARGET_BROWSER = process.env.TARGET_BROWSER ?? 'chrome';
const ENTRY = process.env.CS_ENTRY;

if (ENTRY !== 'contentScript' && ENTRY !== 'addToWindow') {
  throw new Error(
    `CS_ENTRY must be 'contentScript' or 'addToWindow', got: ${ENTRY ?? '(unset)'}`
  );
}

// Content scripts run in extension pages only — never in mobile or desktop
// hosts — so the intercom mobile/desktop adapters are statically dead.
// `inlineDynamicImports: true` would still drag their transitive deps (the
// full backend `lib/miden/back/*`, which pulls the wasm-bindgen SDK) into
// the bundle, which breaks the IIFE build (TLA in eager.js) and would
// bloat the bundle by ~15 MB. Stub the adapters to empty modules for this
// build. Match both relative specifiers (`./mobile-adapter`) and resolved
// absolute paths.
function stubIntercomPlatformAdapters(): Plugin {
  const isTarget = (id: string) =>
    /(?:^|[\\/])(?:mobile|desktop)-adapter(?:\.[tj]sx?)?$/.test(id);
  const stubSource = 'export default {};';
  return {
    name: 'stub-intercom-platform-adapters',
    enforce: 'pre',
    resolveId(source) {
      if (isTarget(source)) return '\0cs-stub:' + source;
    },
    load(id) {
      if (id.startsWith('\0cs-stub:')) return stubSource;
    },
  };
}

export default defineConfig({
  plugins: [
    stubIntercomPlatformAdapters(),
    nodePolyfills({
      include: ['buffer', 'util', 'stream', 'assert', 'process'],
      globals: { Buffer: true, process: true },
    }),
  ],

  build: {
    outDir: `dist/${TARGET_BROWSER}_unpacked`,
    emptyOutDir: false,
    sourcemap: process.env.MODE_ENV !== 'production',
    target: 'es2022',
    minify: process.env.MODE_ENV === 'production',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, `src/${ENTRY}.ts`),
      output: {
        entryFileNames: `${ENTRY}.js`,
        format: 'iife',
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
      buffer: 'buffer',
      stream: 'stream-browserify',
      assert: 'assert',
    },
  },

  define: {
    'process.env.VERSION': JSON.stringify(pkg.version),
    'process.env.TARGET_BROWSER': JSON.stringify(TARGET_BROWSER),
    'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(
      process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'
    ),
    'process.env.MIDEN_NETWORK': JSON.stringify(process.env.MIDEN_NETWORK ?? ''),
    'process.env.MIDEN_E2E_TEST': JSON.stringify(process.env.MIDEN_E2E_TEST ?? 'false'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
    'process.browser': 'true',
    global: 'globalThis',
  },
});
