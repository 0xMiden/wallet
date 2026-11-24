import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
import extension from '../../../vite.extension.config';
const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'fixture.tsx');
export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(root, 'public'),
  plugins: [tailwind(), react(), ...extension.plugins!.filter(p => p && 'name' in p && p.name === 'svg-to-react')],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^components\/ui$/, replacement: resolve(import.meta.dirname, 'ui.ts') },
      ...[
        'lib/miden/metadata',
        'lib/epoch',
        'lib/epoch/earn-withdraw-quote',
        'lib/miden/front',
        'lib/woozie',
        'lib/mobile/haptics',
        'lib/i18n/core',
        'lib/token-list/useTokenLogoUri',
        'lib/miden-chain/effective-endpoints',
        'components/NetworkModeSheet',
        'app/templates/history/transactionUtils',
        'app/hooks/useMidenFaucetId',
        'lib/miden-chain/native-asset',
        'lib/mobile/useHideNavbarWhileOpen',
        'lib/remote-config/use-feature-availability',
        'lib/store',
        'screens/generating-transaction/useTransactionRow',
        'lib/platform'
      ].map(p => ({ find: new RegExp('^' + p + '$'), replacement: fixture })),
      { find: /^\.\/useEarnPositions$/, replacement: fixture },
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(p => ({
        find: new RegExp('^' + p + '/'),
        replacement: resolve(root, 'src', p) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5189, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' },
  build: { outDir: resolve(root, '../evidence/visual-bundle'), emptyOutDir: true }
});
