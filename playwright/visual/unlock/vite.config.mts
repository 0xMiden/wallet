import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import oneClick from '../one-click/vite.config.mts';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'fixture.tsx');

export default defineConfig({
  ...oneClick,
  root: import.meta.dirname,
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      ...[
        'app/env',
        'app/layouts/SimplePageLayout',
        'components/PasscodeScreen',
        'lib/miden/front',
        'lib/miden/types',
        'lib/miden-chain/constants',
        'lib/miden/back/vault',
        'lib/platform',
        'lib/woozie',
        'lib/mobile/haptics',
        'lib/biometric',
        'lib/desktop/secure-storage',
        'lib/telemetry/use-user-visible-error'
      ].map(path => ({ find: new RegExp('^' + path + '$'), replacement: fixture })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(path => ({
        find: new RegExp('^' + path + '/'),
        replacement: resolve(root, 'src', path) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5192, strictPort: true, fs: { allow: [root] } }
});
