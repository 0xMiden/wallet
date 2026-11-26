import { resolve } from 'node:path';

import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';

import extension from '../../../vite.extension.config';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'fixture.tsx');
const compileSvgJsx: Plugin = {
  name: 'bridge-status-svg-jsx-compile',
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

const fixtureModules = [
  'app/hooks/useMidenFaucetId',
  'app/templates/EvmConnectModal/UsdcxExecuteAction',
  'lib/miden-chain/effective-endpoints',
  'lib/miden-chain/native-asset',
  'lib/miden/front',
  'lib/miden/metadata',
  'lib/mobile/external-browser',
  'lib/mobile/haptics',
  'lib/mobile/useHideNavbarWhileOpen',
  'lib/remote-config/runtime',
  'lib/remote-config/use-feature-availability',
  'lib/store',
  'lib/telemetry/use-user-visible-error',
  'lib/token-list/runtime',
  'screens/command/CommandWorkbench',
  'screens/generating-transaction/useTransactionRow'
];

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
      { find: /^\.\/UsdcxExecuteAction$/, replacement: fixture },
      ...fixtureModules.map(path => ({
        find: new RegExp('^' + path + '$'),
        replacement: fixture
      })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(path => ({
        find: new RegExp('^' + path + '/'),
        replacement: resolve(root, 'src', path) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5193, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' }
});
