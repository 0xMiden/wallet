import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import extension from '../../../vite.extension.config';

const root = resolve(import.meta.dirname, '../../..');
const own = (name: string) => resolve(import.meta.dirname, name);
const evidence = process.env.VISUAL_EVIDENCE!;
const controlled: { imported: string; importer: string }[] = [];
const aliases = (names: string[], file: string) =>
  names.map(name => ({ find: new RegExp('^' + name.replaceAll('/', '\\/') + '$'), replacement: own(file) }));
const critical = [
  'src/screens/send-flow/ReviewTransaction.tsx',
  'src/lib/usdcx/use-burn-minimum.ts',
  'src/lib/usdcx/burn.ts',
  'src/lib/miden-chain/rpc-timeout.ts',
  'src/lib/usdcx/withdrawal.ts',
  'src/lib/remote-config/use-feature-availability.ts',
  'src/lib/remote-config/availability.ts',
  'src/components/ui/DetailCard.tsx',
  'src/app/layouts/FullScreenPage.tsx',
  'src/app/a11y/AwaitFonts.tsx',
  'src/i18n.ts',
  'src/main.css'
];

export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(root, 'public'),
  plugins: [
    {
      name: 'minimum-visual-rpc-boundary',
      enforce: 'pre',
      async resolveId(id, importer) {
        if (importer && (id.endsWith('/runtime') || id.endsWith('/runtime.ts'))) {
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          if (resolved?.id.split('?')[0] === resolve(root, 'src/lib/remote-config/runtime.ts')) {
            controlled.push({ imported: id, importer });
            return own('state.ts');
          }
        }
        if (
          (id === './rpc-client' && importer?.split('?')[0] === resolve(root, 'src/lib/usdcx/burn.ts')) ||
          id === 'lib/usdcx/rpc-client'
        ) {
          controlled.push({ imported: id, importer: importer ?? '' });
          return own('rpc.ts');
        }
        if (
          id === './send-telemetry' &&
          importer?.split('?')[0] === resolve(root, 'src/screens/send-flow/ReviewTransaction.tsx')
        )
          return own('actions.tsx');
        if (id === './destination-status' && importer?.split('?')[0] === resolve(root, 'src/lib/usdcx/burn.ts'))
          return own('actions.tsx');
        return null;
      },
      generateBundle() {
        const modules = [...this.getModuleIds()].map(id => id.split('?')[0]);
        if (modules.includes(resolve(root, 'src/lib/remote-config/runtime.ts'))) {
          throw new Error('Uncontrolled remote-config runtime escaped the fixture boundary');
        }
        for (const name of critical) {
          if (!modules.includes(resolve(root, name))) throw new Error(`Missing real production module: ${name}`);
        }
        if (
          !controlled.some(
            item => item.imported === './rpc-client' && item.importer === resolve(root, 'src/lib/usdcx/burn.ts')
          )
        ) {
          throw new Error('Real burn reader did not resolve the controlled relative RPC boundary');
        }
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
          resolve(evidence, 'production-modules.json'),
          JSON.stringify(
            {
              critical: Object.fromEntries(
                critical.map(name => [
                  name,
                  createHash('sha256')
                    .update(readFileSync(resolve(root, name)))
                    .digest('hex')
                ])
              ),
              controlled,
              aliases: this.meta.rollupVersion,
              real_production_modules_present: true
            },
            null,
            2
          ) + '\n'
        );
      }
    },
    tailwind(),
    react(),
    ...extension.plugins!.filter(plugin => plugin && 'name' in plugin && plugin.name === 'svg-to-react')
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'dexie', '@miden-sdk/miden-sdk'],
    alias: [
      { find: /^components\/ui$/, replacement: own('ui.ts') },
      ...aliases(
        [
          'lib/miden/front',
          'lib/store',
          'lib/miden-chain/native-asset',
          'lib/miden-chain/effective-endpoints',
          'lib/remote-config/runtime',
          'lib/token-list/useTokenLogoUri',
          'lib/miden/metadata',
          'lib/miden/metadata/utils'
        ],
        'state.ts'
      ),
      ...aliases(
        [
          'lib/miden/front/client',
          'lib/miden/front/guardian-sync',
          'lib/agglayer/b2agg',
          'lib/biometric',
          'lib/epoch',
          'lib/miden/activity',
          'lib/miden/back/protector-probe',
          'lib/miden/transaction/initiate',
          'lib/settings/helpers',
          'lib/telemetry',
          'lib/mobile/haptics',
          'components/NetworkModeSheet',
          'components/SpendingLimitChallenge'
        ],
        'actions.tsx'
      ),
      ...aliases(['lib/miden-chain/constants'], 'constants.ts'),
      ...['app', 'components', 'lib', 'utils', 'screens', 'shared'].map(name => ({
        find: new RegExp('^' + name + '/'),
        replacement: resolve(root, 'src', name) + '/'
      }))
    ]
  },
  define: { 'process.env': {}, global: 'globalThis' },
  server: { host: '127.0.0.1', port: 5191, strictPort: true, fs: { allow: [root] } },
  build: { target: 'esnext', outDir: resolve(evidence, 'bundle'), emptyOutDir: true }
});
