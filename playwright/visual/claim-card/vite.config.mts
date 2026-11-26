import { resolve } from 'node:path';

import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, transformWithOxc, type Plugin } from 'vite';

import extension from '../../../vite.extension.config';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'fixture.tsx');
const compileSvgJsx: Plugin = {
  name: 'claim-card-svg-jsx-compile',
  enforce: 'pre',
  async transform(code, id) {
    if (!id.endsWith('?svgr')) return;
    const transformed = await transformWithOxc(code, id, {
      lang: 'jsx', jsx: { runtime: 'classic' }
    });
    return { code: transformed.code, map: transformed.map, moduleType: 'js' };
  }
};

const fixtureModules = [
  './activityUnread',
  'app/hooks/useClaimNotes',
  'app/hooks/useNativeFeeFaucetId',
  'app/hooks/useVerificationBaseFee',
  'lib/dexie-live-query',
  'lib/miden/activity',
  'lib/miden/activity/bridge-in',
  'lib/miden/front',
  'lib/miden/front/claim-telemetry',
  'lib/miden/front/guardian-sync',
  'lib/miden/guardian/direct-switch',
  'lib/miden/guardian/serialize',
  'lib/miden/helpers',
  'lib/miden/repo',
  'lib/miden/transaction/claim-fee',
  'lib/miden-chain/constants',
  'lib/miden-chain/effective-endpoints',
  'lib/mobile/haptics',
  'lib/remote-config/token-labels',
  'lib/remote-config/use-feature-availability',
  'lib/telemetry/use-user-visible-error'
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
      ...fixtureModules.map(path => ({ find: new RegExp('^' + (path === './activityUnread' ? '[.]/activityUnread' : path) + '$'), replacement: fixture })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(path => ({
        find: new RegExp('^' + path + '/'), replacement: resolve(root, 'src', path) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5196, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' }
});
