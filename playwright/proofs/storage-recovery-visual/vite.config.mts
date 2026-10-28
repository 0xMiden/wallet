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
    dedupe: ['react', 'react-dom', 'dexie', '@miden-sdk/miden-sdk'],
    alias: [
      ...['lib/miden/front', 'lib/mobile/useMobileBackHandler', 'lib/mobile/useHideNavbarWhileOpen',
        'lib/mobile/haptics', 'lib/platform', 'components/StrictActionAuthentication'].map(p => ({
          find: new RegExp('^' + p + '$'), replacement: fixture
        })),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(p => ({
        find: new RegExp('^' + p + '/'), replacement: resolve(root, 'src', p) + '/'
      }))
    ]
  },
  server: { host: '127.0.0.1', port: 5194, strictPort: true, fs: { allow: [root] } },
  define: { 'process.env': {}, global: 'globalThis' },
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true }
});
