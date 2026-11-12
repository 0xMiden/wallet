import { resolve } from 'node:path';

import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';

import extension from '../../../vite.extension.config';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'fixture.tsx');
const batchFixture = resolve(import.meta.dirname, 'batch-fixture.tsx');
const batchBoundaries: Record<string, string[]> = {
  'lib/store': [
    'app/templates/DeviceSettings.tsx',
    'app/templates/RecoveryPhraseKeepPrompt.tsx',
    'app/templates/EvmConnectModal/EvmBridgeTokenDrawer.tsx'
  ],
  'lib/miden/front': ['app/pages/MyBadges.tsx', 'app/templates/DeviceSettings.tsx'],
  'lib/miden/front/client': ['lib/badges/useBadgeBackfill.ts'],
  'lib/miden/repo': ['lib/badges/useBadgeBackfill.ts'],
  'lib/platform/storage-adapter': ['lib/miden/back/safe-storage.ts', 'lib/miden/front/storage.ts'],
  'lib/miden/front/useDeviceSigners': ['app/templates/DeviceSettings.tsx']
};
const batchData: Plugin = {
  name: 'batch-visual-data',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer) return;
    const module = source.replace(`${root}/src/`, '').replace(/\.(ts|tsx)$/, '').replace(/\/index$/, '');
    if (batchBoundaries[module]?.some(path => importer.split('?')[0] === resolve(root, 'src', path))) {
      return batchFixture;
    }
  }
};
const compileSvgJsx: Plugin = {
  name: 'one-click-svg-jsx-compile',
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

export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(root, 'public'),
  plugins: [
    tailwind(),
    react(),
    batchData,
    ...extension.plugins!.filter(plugin => plugin && 'name' in plugin && plugin.name === 'svg-to-react'),
    compileSvgJsx
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      ...[
        'components/NetworkModeBanner',
        'lib/mobile/useHideNavbarWhileOpen',
        'lib/telemetry/use-user-visible-error',
        'lib/miden/metadata/fetch',
        'lib/token-list/useTokenLogoUri',
        'lib/miden-chain/effective-endpoints',
        'lib/mobile/haptics'
      ].map(path => ({
        find: new RegExp('^' + path + '$'),
        replacement:
          path === 'lib/miden/metadata/fetch' ? resolve(import.meta.dirname, 'transaction-metadata.ts') : fixture
      })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(path => ({
        find: new RegExp('^' + path + '/'),
        replacement: resolve(root, 'src', path) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5190, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' }
});
