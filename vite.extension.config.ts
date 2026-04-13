/**
 * Vite config for the Chrome extension.
 *
 * Builds all UI pages (popup, fullpage, options, sidepanel, confirm),
 * content scripts, and the background service worker in one pass.
 *
 * Replaces webpack.config.js entirely for the extension build.
 */
import { resolve, join, sep } from 'path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync, readdirSync, statSync } from 'fs';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
// vite-plugin-svgr doesn't work with Vite 8's Rolldown -- use custom plugin
import wasm from 'vite-plugin-wasm';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, type Plugin } from 'vite';

const pkg = require('./package.json');
const TARGET_BROWSER = process.env.TARGET_BROWSER ?? 'chrome';
const MANIFEST_VERSION = process.env.MANIFEST_VERSION ?? '3';
const MANIFEST_FILE = MANIFEST_VERSION === '3' ? 'manifest.json' : 'manifest.v2.json';

// ── Manifest transform (ported from webpack.public.config.js) ───────────────

const browserVendors = ['chrome', 'firefox', 'opera', 'edge', 'safari'];
const vendorRegExp = new RegExp(`^__((?:(?:${browserVendors.join('|')})\\|?)+)__(.*)`);

function transformManifestKeys(manifest: any, vendor: string): any {
  if (Array.isArray(manifest)) return manifest.map(m => transformManifestKeys(m, vendor));
  if (typeof manifest === 'object' && manifest !== null) {
    return Object.entries(manifest).reduce((acc: any, [key, value]) => {
      const match = key.match(vendorRegExp);
      if (match) {
        const vendors = match[1].split('|');
        if (vendors.includes(vendor)) acc[match[2]] = value;
      } else if (key === 'version') {
        acc[key] = pkg.version;
      } else {
        acc[key] = transformManifestKeys(value, vendor);
      }
      return acc;
    }, {});
  }
  return manifest;
}

// ── Copy public assets (ported from webpack.public.config.js) ───────────────

function copyPublicAssets(outDir: string): Plugin {
  return {
    name: 'copy-public-assets',
    closeBundle() {
      const publicDir = resolve(__dirname, 'public');
      const localesDir = join(publicDir, '_locales');
      const enDir = join(localesDir, 'en');

      function copyRecursive(src: string, dest: string) {
        if (!existsSync(src)) return;
        const stat = statSync(src);
        if (stat.isDirectory()) {
          mkdirSync(dest, { recursive: true });
          for (const entry of readdirSync(src)) {
            copyRecursive(join(src, entry), join(dest, entry));
          }
        } else {
          mkdirSync(resolve(dest, '..'), { recursive: true });
          cpSync(src, dest);
        }
      }

      // Copy all public files except HTML, manifest.v2.json, and non-EN locales
      for (const entry of readdirSync(publicDir)) {
        const src = join(publicDir, entry);
        const dest = join(outDir, entry);
        if (entry.endsWith('.html')) continue;
        if (entry === 'manifest.v2.json') continue;
        if (entry === 'sw.js') continue; // Not needed -- background.js is the SW now
        if (entry === '_locales') {
          // Only copy EN locale
          if (existsSync(enDir)) copyRecursive(enDir, join(outDir, '_locales', 'en'));
          continue;
        }
        if (entry === 'manifest.json') continue; // Handled below
        copyRecursive(src, dest);
      }

      // Transform and write manifest
      const manifestSrc = join(publicDir, MANIFEST_FILE);
      const manifestContent = JSON.parse(readFileSync(manifestSrc, 'utf8'));
      const transformed = transformManifestKeys(manifestContent, TARGET_BROWSER);
      writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(transformed, null, 2));
    },
  };
}

// ── SW patches (TLA strip, document/window refs) ────────────────────────────

function swPatches(): Plugin {
  return {
    name: 'sw-patches',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const [, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.code) continue;

        // Patch document/window references for SW compatibility
        chunk.code = chunk.code
          .replace(/document\.getElementsByTagName\([^)]*\)/g, '[]')
          .replace(/document\.querySelector\([^)]*\)/g, 'null')
          .replace(/document\.head\.appendChild\([^)]*\)/g, 'undefined')
          .replace(/document\.createElement\([^)]*\)/g, '({setAttribute(){},addEventListener(){}})')
          .replace(/\bwindow\.dispatchEvent\b/g, 'self.dispatchEvent');

        // Strip top-level await for SW compatibility
        // Chrome MV3 SWs don't support TLA in ESM modules
        if (chunk.fileName === 'background.js') {
          chunk.code = chunk.code.replace(/^await /gm, '/* tla-stripped */ ');
        }
      }
    },
  };
}

// ── SVG stub for background (SW doesn't render UI) ──────────────────────────

function svgStubForBackground(): Plugin {
  return {
    name: 'svg-stub-background',
    enforce: 'pre',
    load(id) {
      // Only stub SVGs when building the background entry
      if (id.endsWith('.svg') && this.getModuleInfo?.(id)?.isEntry === false) {
        return 'export const ReactComponent = () => null; export default "";';
      }
    },
  };
}

// ── Config ──────────────────────────────────────────────────────────────────

const OUTPUT_DIR = `dist/${TARGET_BROWSER}_unpacked`;

const sharedAlias = {
  lib: resolve(__dirname, 'src/lib'),
  app: resolve(__dirname, 'src/app'),
  shared: resolve(__dirname, 'src/shared'),
  components: resolve(__dirname, 'src/components'),
  screens: resolve(__dirname, 'src/screens'),
  utils: resolve(__dirname, 'src/utils'),
  stories: resolve(__dirname, 'src/stories'),
};

const sharedDefine = {
  'process.env.VERSION': JSON.stringify(pkg.version),
  'process.env.TARGET_BROWSER': JSON.stringify(TARGET_BROWSER),
  'process.env.MIDEN_USE_MOCK_CLIENT': JSON.stringify(process.env.MIDEN_USE_MOCK_CLIENT ?? 'false'),
  'process.env.MIDEN_DEFAULT_NETWORK': JSON.stringify(process.env.MIDEN_DEFAULT_NETWORK ?? ''),
  'process.env.MIDEN_E2E_TEST': JSON.stringify(process.env.MIDEN_E2E_TEST ?? 'false'),
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  'process.env.MODE_ENV': JSON.stringify(process.env.MODE_ENV ?? 'development'),
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    // Custom SVG → React component transform (replaces vite-plugin-svgr for Vite 8)
    // Uses resolveId + load (not transform) to intercept before Rolldown parses the SVG
    {
      name: 'svg-to-react',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source.endsWith('.svg') && importer) {
          // Resolve to the actual file path but mark with a query param
          const resolved = resolve(importer ? resolve(importer, '..', source) : source);
          return resolved + '?svgr';
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
          prettier: false,
          svgo: false,
          titleProp: true,
          ref: true,
        }, { filePath });
        const code = jsxCode + '\nexport default "";';
        // Return as JSX so Vite/Rolldown transforms it to JS
        return { code, moduleType: 'jsx' };
      },
    } satisfies Plugin,
    wasm(),
    // NOTE: nodePolyfills is NOT included for the UI build -- these pages run in
    // a real browser with real document/window. The node polyfills plugin provides
    // fake document/window that break React's CSS animation detection.
    // Buffer is provided via resolve.alias instead.
    // Extension HTML fixes
    {
      name: 'extension-html-fixes',
      enforce: 'post',
      transformIndexHtml(html) {
        return html
          .replace(/ crossorigin/g, '')
          // Inject process global before any module script
          .replace(
            '<script type="module"',
            '<script>window.process = { env: {}, browser: true };</script>\n    <script type="module"'
          );
      },
      // Inject global React + Buffer for CJS dependencies that expect them.
      // Rolldown's CJS-to-ESM interop scopes `var React = require_react()` inside
      // a function, but other code in the same chunk references unscoped `React`.
      generateBundle(_, bundle) {
        for (const [, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk' || !chunk.code) continue;
          if (!chunk.code.includes('React.createElement')) continue;
          // Wrap chunk in an IIFE that provides React globally
          chunk.code = chunk.code.replace(
            /var React = (require_react\(\));/,
            'var React = $1; globalThis.React = globalThis.React || React;'
          );
        }
      },
    } satisfies Plugin,
    copyPublicAssets(resolve(__dirname, OUTPUT_DIR)),
  ],

  build: {
    outDir: OUTPUT_DIR,
    emptyOutDir: false, // background build puts files here first
    sourcemap: process.env.MODE_ENV !== 'production',
    target: 'es2022',
    minify: process.env.MODE_ENV === 'production',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        // UI pages (HTML entry points at project root for Vite processing)
        popup: resolve(__dirname, 'popup.html'),
        fullpage: resolve(__dirname, 'fullpage.html'),
        confirm: resolve(__dirname, 'confirm.html'),
        options: resolve(__dirname, 'options.html'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        // Content scripts (need to be standalone JS files)
        contentScript: resolve(__dirname, 'src/contentScript.ts'),
        addToWindow: resolve(__dirname, 'src/addToWindow.ts'),
        // NOTE: background is built separately via vite.background.config.ts
        // because it needs inlineDynamicImports (import() is banned in SWs)
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Content scripts and background need fixed names
          if (chunkInfo.name === 'contentScript') return 'contentScript.js';
          if (chunkInfo.name === 'addToWindow') return 'addToWindow.js';
          if (chunkInfo.name === 'background') return 'background.js';
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.[0]?.endsWith('.wasm')) {
            return 'static/wasm/[name].[hash][extname]';
          }
          if (assetInfo.names?.[0]?.endsWith('.css')) {
            return 'static/styles/[name][extname]';
          }
          return 'static/media/[name].[hash][extname]';
        },
      },
    },
  },

  worker: {
    format: 'es',
  },

  resolve: {
    alias: {
      ...sharedAlias,
      // Ensure consistent React instance across all imports
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      // Node module polyfills for browser context
      buffer: 'buffer',
      stream: 'stream-browserify',
      assert: 'assert',
    },
  },

  define: {
    ...sharedDefine,
    // Provide process.browser for libraries that check it
    'process.browser': 'true',
    // Global process object for compatibility
    'global': 'globalThis',
  },

  css: {
    modules: {
      generateScopedName: '[path][name]__[local]--[hash:base64:5]',
    },
  },
});
