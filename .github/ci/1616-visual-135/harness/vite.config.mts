import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, type Plugin } from 'vite';

import extension from '../../../vite.extension.config';

const root = resolve(import.meta.dirname, '../../..');
const data = resolve(import.meta.dirname, 'data.tsx');
const source = (path: string) => resolve(root, 'src', path);
const virtual = (name: string) => `\0display-acceptance:${name}`;
const exactDataBoundaries = new Set([
  'lib/miden/front',
  'lib/store',
  'lib/remote-config/use-feature-availability',
  'lib/remote-config/runtime',
  'lib/token-list/useTokenLogoUri',
  'lib/miden-chain/effective-endpoints',
  'lib/miden-chain/native-asset',
  'lib/mobile/haptics',
  'lib/mobile/status-bar',
  'lib/mobile/external-browser',
  'lib/miden/metadata/utils',
  'lib/miden/sdk/helpers',
  'lib/telemetry/route-flow',
  'lib/telemetry/bridge-receive-failure',
  'screens/generating-transaction/useTransactionRow'
]);
const boundaryPlugin: Plugin = {
  name: 'display-acceptance-data-boundaries',
  enforce: 'pre',
  resolveId(request, importer) {
    const prefix = `${source('')}/`;
    const absolute =
      request.startsWith('.') && importer && !importer.startsWith('\0') ? resolve(dirname(importer), request) : request;
    const id = absolute.startsWith(prefix) ? absolute.slice(prefix.length).replace(/\.tsx?$/, '') : absolute;
    if (exactDataBoundaries.has(id)) return data;
    if (id === 'lib/agglayer') return source('lib/agglayer/constant.ts');
    if (id === 'lib/miden/metadata') return source('lib/miden/metadata/defaults.ts');
    if (id === 'lib/epoch') return virtual('epoch');
    if (id === 'app/hooks/useMidenFaucetId' || id === 'app/hooks/useNativeFeeFaucetId') return virtual('native-id');
    if (id === 'app/hooks/useVerificationBaseFee') return virtual('base-fee');
    if (request === './useEarnCollateral' && importer === source('screens/earn-flow/EarnDepositAmount.tsx')) return data;
    if (request === './useEarnPositions' && importer === source('screens/earn-flow/EarnDepositAmount.tsx'))
      return virtual('positions');
    if (request === './helpers' && importer === source('lib/settings/theme.ts')) return virtual('theme-storage');
    if (request === './user-visible-error' && importer === source('lib/telemetry/use-user-visible-error.ts')) return data;
    if (
      (request === './UsdcxDepositSteps' || request === './UsdcxExecuteAction') &&
      importer === source('app/templates/EvmConnectModal/EvmBridgeDepositStatus.tsx')
    )
      return data;
  },
  load(id) {
    if (id === virtual('native-id'))
      return `import {NATIVE_ID} from ${JSON.stringify(data)}; export default () => NATIVE_ID;`;
    if (id === virtual('base-fee')) return 'export default () => 0;';
    if (id === virtual('theme-storage'))
      return `export const getThemeSetting = () => localStorage.getItem('theme_setting') ?? 'light'; export const setThemeSetting = value => localStorage.setItem('theme_setting', value);`;
    if (id === virtual('epoch'))
      return `import {forbidden} from ${JSON.stringify(data)}; export const normalizeMidenIdToHex = id => {if (!/^0x[0-9a-f]{30}$/.test(id)) forbidden('non-canonical fixture faucet'); return id;};`;
    if (id === virtual('positions')) {
      const text = readFileSync(source('screens/earn-flow/useEarnPositions.ts'), 'utf8');
      const start = text.indexOf('export function earnItemLoadState(');
      const end = text.indexOf('\n}\n', start);
      if (start < 0 || end < start) throw new Error('Cannot locate actual earnItemLoadState');
      return `${text.slice(start, end + 3)}\nexport {useEarnPositions} from ${JSON.stringify(data)};`;
    }
  },
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'module-inventory.json',
      source: JSON.stringify([...this.getModuleIds()].sort(), null, 2)
    });
  }
};

export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(root, 'public'),
  plugins: [
    boundaryPlugin,
    tailwind(),
    react(),
    ...extension.plugins!.filter(plugin => plugin && 'name' in plugin && plugin.name === 'svg-to-react')
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: Object.fromEntries(
      ['app', 'components', 'lib', 'screens', 'shared', 'utils'].map(name => [name, source(name)])
    )
  },
  define: { 'process.env': {}, global: 'globalThis' },
  build: { target: 'es2022', outDir: resolve(root, '.ci-proof/1616-visual/bundle'), emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 5191, strictPort: true }
});
