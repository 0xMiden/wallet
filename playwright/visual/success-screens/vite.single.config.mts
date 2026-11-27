// Builds the page as one classic script and one stylesheet with every font and image inlined, so
// build-single.py can paste both into a single HTML file that needs no server.
//
// The wallet's Miden SDK ships WebAssembly behind a top-level await, which cannot go into a classic
// script. The prototype never calls it (nothing here signs or sends), so it is replaced by an empty
// stand-in (see STUB below; the names come from sdk-stub-names.json, a list of what the app imports).
import { mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from './vite.config.mts';
import sdkNames from './sdk-stub-names.json' with { type: 'json' };

const EMPTY = '\0bread-empty-module';
const stubbed = /^@miden-sdk\//;
// Every name the app imports from the SDK becomes one inert value that accepts any property read,
// call or `new`, so module-level code such as enum lookups runs without the real thing.
const STUB =
  "const P = new Proxy(function () {}, { get: (_, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : P), apply: () => P, construct: () => P });\n" +
  'export default P;\n' +
  (sdkNames as string[]).map(name => `export const ${name} = P;`).join('\n');

// The base config's two page entries must not be merged in: this build has exactly one entry.
const { build: _pages, ...shared } = base;

export default mergeConfig(shared, {
  publicDir: false,
  // The app's web workers are never started by the prototype; built as modules they need no extra options.
  worker: { format: 'es' },
  plugins: [
    {
      name: 'bread-single-stubs',
      enforce: 'pre',
      resolveId: (id: string) => (stubbed.test(id) ? EMPTY : null),
      load: (id: string) => (id === EMPTY ? STUB : null)
    }
  ],
  build: {
    outDir: process.env.SINGLE_OUT,
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rolldownOptions: {
      input: resolve(import.meta.dirname, 'single.ts'),
      shimMissingExports: true,
      output: { format: 'es', codeSplitting: false, inlineDynamicImports: true, entryFileNames: 'single.js', assetFileNames: 'single[extname]' }
    }
  }
});
