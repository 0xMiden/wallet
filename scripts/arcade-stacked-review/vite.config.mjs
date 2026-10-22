import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
export default defineConfig({
  cacheDir: '/tmp/arcade-stacked-vite-cache',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'svg-react',
      enforce: 'pre',
      async load(id) {
        if (!id.endsWith('.svg')) return;
        const { transform } = await import('@svgr/core');
        const jsx = await transform(
          readFileSync(id, 'utf8'),
          {
            plugins: ['@svgr/plugin-jsx'],
            jsxRuntime: 'automatic',
            exportType: 'named',
            namedExport: 'ReactComponent'
          },
          { componentName: 'SvgIcon' }
        );
        const swc = await import('@swc/core');
        return {
          code: (
            await swc.transform(jsx, {
              jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } },
              filename: id + '.jsx'
            })
          ).code
        };
      }
    }
  ],
  resolve: {
    alias: [
      { find: 'app/hooks/useBackWithFallback', replacement: resolve('scripts/arcade-stacked-review/back-fixture.ts') },
      { find: /^components\/ui$/, replacement: resolve('scripts/arcade-stacked-review/ui-barrel.ts') },
      { find: /^lib\/dapp-browser$/, replacement: resolve('src/lib/dapp-browser/explore-catalog.ts') },
      {
        find: 'lib/mobile/useMobileBackHandler',
        replacement: resolve('scripts/arcade-stacked-review/platform-fixture.tsx')
      },
      { find: 'lib/woozie', replacement: resolve('scripts/arcade-stacked-review/platform-fixture.tsx') },
      {
        find: 'app/templates/ArcadeAllowance',
        replacement: resolve('scripts/arcade-stacked-review/allowance-fixture.tsx')
      },
      { find: 'lib/mobile/haptics', replacement: resolve('scripts/arcade-stacked-review/haptics.ts') },
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(name => ({
        find: name,
        replacement: resolve('src', name)
      }))
    ]
  },
  define: { 'process.env': JSON.stringify({ NODE_ENV: 'development', MIDEN_NETWORK: 'mainnet' }) },
  optimizeDeps: { entries: ['scripts/arcade-stacked-review/index.html'] },
  server: { host: '127.0.0.1', port: 5188, fs: { allow: [resolve('.'), realpathSync('node_modules')] } }
});
