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
      { find: /^webextension-polyfill$/, replacement: resolve(root, 'src/lib/webextension-polyfill-mock.js') },
      { find: /^components\/ui$/, replacement: resolve(import.meta.dirname, 'ui.ts') },
      ...[
        'lib/miden/front',
        'lib/miden/metadata/fetch',
        'lib/woozie',
        'lib/token-list/useTokenLogoUri',
        'app/hooks/useMidenFaucetId',
        'lib/mobile/useHideNavbarWhileOpen',
        'lib/remote-config/use-feature-availability',
        'lib/store'
      ].map(p => ({ find: new RegExp('^' + p + '$'), replacement: fixture })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(p => ({
        find: new RegExp('^' + p + '/'),
        replacement: resolve(root, 'src', p) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5191, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' },
  build: { outDir: '/private/tmp/claude-501/-Users-solodock/68b70ec2-5baa-4841-8633-d134d04a29b3/scratchpad/success-bundle', emptyOutDir: true,
    rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), dapp: resolve(import.meta.dirname, 'dapp.html') } }
  }
});
