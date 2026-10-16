import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const qa = fileURLToPath(new URL('./', import.meta.url));
const req = createRequire(repo + '/package.json');
const { defineConfig } = await import(req.resolve('vite'));
const { default: react } = await import(req.resolve('@vitejs/plugin-react-swc'));
const { default: tailwind } = await import(req.resolve('@tailwindcss/vite'));
const { transform } = await import(req.resolve('@svgr/core'));
const swc = req('@swc/core');
export default defineConfig({
  root: qa,
  define: { 'process.env': {} },
  plugins: [
    tailwind(),
    react(),
    {
      name: 'qa-svg',
      enforce: 'pre',
      resolveId(source, importer) {
        if (importer?.endsWith('/pages/Settings.tsx')) {
          if (
            source.includes('/app/templates/') ||
            source.startsWith('app/templates/') ||
            ['./AdvancedSettings', './ExportAccountFile', './Networks'].includes(source) ||
            /\/pages\/(AdvancedSettings|ExportAccountFile|Networks)(\.tsx)?$/.test(source)
          )
            return '\0qa-panel';
          if (source.endsWith('screens/encrypted-file-flow/EncryptedFileManager')) return '\0qa-encrypted';
          if (source.endsWith('lib/store')) return '\0qa-store';
          if (source.endsWith('lib/miden-chain/effective-endpoints')) return '\0qa-endpoints';
          if (source.endsWith('lib/i18n/core')) return '\0qa-locale';
        }
        if (source.endsWith('.svg') && importer) return resolve(importer, '..', source) + '?svgr';
      },
      async load(id) {
        if (id === '\0qa-panel') return 'export default () => null';
        if (id === '\0qa-encrypted') return 'export const EncryptedFileFlow = () => null';
        if (id === '\0qa-endpoints') return 'export const isEndpointOverrideActive = async () => false';
        if (id === '\0qa-locale') return "export const getCurrentLocale = () => 'en'";
        if (id === '\0qa-store')
          return "export const useWalletStore = selector => selector({currentAccount:{type:'guardian',hotPublicKey:'fixture'},accounts:[{type:'guardian'}],seedPhraseStatus:'stored'})";
        if (!id.endsWith('?svgr')) return;
        const path = id.slice(0, -5);
        const jsx = await transform(
          await readFile(path, 'utf8'),
          { plugins: ['@svgr/plugin-jsx'], exportType: 'named', namedExport: 'ReactComponent', jsxRuntime: 'classic' },
          { filePath: path }
        );
        const code = swc.transformSync(jsx, {
          jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } }
        }).code;
        return { code: code + `\nexport default ${JSON.stringify(path)};`, map: null };
      }
    }
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: 'lib/miden/front/storage', replacement: qa + '/storage.ts' },
      { find: /^lib[/]miden[/]front$/, replacement: qa + '/front.ts' },
      { find: 'lib/mobile/haptics', replacement: qa + '/haptics.ts' },
      { find: 'lib/woozie', replacement: qa + '/router.tsx' },
      ...['app', 'components', 'lib', 'screens', 'utils', 'shared'].map(name => ({
        find: name,
        replacement: repo + '/src/' + name
      })),
      ...[
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'react-i18next',
        'i18next',
        'framer-motion',
        'class-variance-authority',
        'clsx',
        'tailwind-merge'
      ].map(name => ({ find: new RegExp('^' + name + '$'), replacement: req.resolve(name) }))
    ]
  },
  server: { host: '127.0.0.1', port: 5187, strictPort: true, fs: { allow: [repo, qa] } },
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'react-i18next',
      'i18next',
      'framer-motion',
      'class-variance-authority',
      'clsx',
      'tailwind-merge'
    ]
  }
});
