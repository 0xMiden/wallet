import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';

import extension from '../../../vite.extension.config';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'fixture.tsx');
const historyFixture = resolve(import.meta.dirname, 'history.fixture.tsx');
const nativeFaucetFixture = resolve(import.meta.dirname, 'native-faucet.fixture.ts');
const compileSvgJsx: Plugin = {
  name: 'token-detail-svg-jsx-compile',
  enforce: 'pre',
  async transform(code, id) {
    if (!id.endsWith('?svgr')) return;
    const transformed = await transformWithOxc(code, id, {
      lang: 'jsx',
      jsx: { runtime: 'classic' }
    });
    return { code: transformed.code, map: transformed.map, moduleType: 'js' };
  }
};

const fixtureModules: Record<string, string> = {
  'app/env': fixture,
  'app/hooks/useHiddenTokens': fixture,
  'app/hooks/useMidenFaucetId': nativeFaucetFixture,
  'app/hooks/useActivityClaims': fixture,
  'app/hooks/useActivityHiddenNotes': fixture,
  'app/providers/DappBrowserProvider': fixture,
  'app/templates/history/History': historyFixture,
  'components/NetworkModeBanner': fixture,
  'lib/miden-chain/effective-endpoints': fixture,
  'lib/miden/front': fixture,
  'lib/miden/metadata/overrides': fixture,
  'lib/mobile/external-browser': fixture,
  'lib/mobile/haptics': fixture,
  'lib/mobile/useHideNavbarWhileOpen': fixture,
  'lib/platform': fixture,
  'lib/prices': fixture,
  'lib/remote-config/use-feature-availability': fixture,
  'lib/ui/dialog': fixture,
  'lib/store': fixture,
  'lib/swr': fixture,
  'lib/telemetry/use-user-visible-error': fixture,
  'lib/token-list/runtime': fixture,
  'lib/token-list/useTokenLogoUri': fixture,
  'lib/token-list/useTokenVerification': fixture,
  'lib/woozie': fixture
};

export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(root, 'public'),
  plugins: [
    tailwind(),
    react(),
    ...extension.plugins!.filter(plugin => plugin && 'name' in plugin && plugin.name === 'svg-to-react'),
    compileSvgJsx
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^lib\/miden\/metadata$/,
        replacement: resolve(root, 'src/lib/miden/metadata/index.ts'),
        customResolver(source, importer) {
          return importer === resolve(root, 'src/lib/i18n/numbers.ts')
            ? resolve(root, 'src/lib/miden/metadata/defaults.ts')
            : source;
        }
      },
      ...Object.entries(fixtureModules).map(([path, replacement]) => ({
        find: new RegExp('^' + path + '$'),
        replacement
      })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(path => ({
        find: new RegExp('^' + path + '/'),
        replacement: resolve(root, 'src', path) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5192, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' }
});
