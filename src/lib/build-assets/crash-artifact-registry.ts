import type { Plugin } from 'vite';

const REGISTRY_FILE = 'wallet-crash-artifacts.js';

/** The stable external module breaks the registry/chunk content-hash cycle. */
export function walletCrashArtifactRegistry(): Plugin {
  return {
    name: 'wallet-crash-artifact-registry',
    enforce: 'pre',
    apply: 'build',
    resolveId(id, importer) {
      if (
        (id === './crash-artifacts' || id.replace(/\\/g, '/').endsWith('/lib/telemetry/crash-artifacts.ts')) &&
        importer?.replace(/\\/g, '/').endsWith('/lib/telemetry/crash-frames.ts')
      ) {
        return { id: `/${REGISTRY_FILE}`, external: 'absolute' };
      }
      return null;
    },
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const lines: Record<string, number[]> = {};
        for (const file of Object.values(bundle)) {
          if (!/^[\w./-]+\.js$/.test(file.fileName)) continue;
          if (file.fileName.split('/').some(part => part === '.' || part === '..' || part === '')) continue;
          const code =
            file.type === 'chunk'
              ? file.code
              : typeof file.source === 'string'
                ? file.source
                : new TextDecoder().decode(file.source);
          lines[file.fileName] = code.split('\n').map(line => line.length);
        }
        this.emitFile({
          type: 'asset',
          fileName: REGISTRY_FILE,
          source:
            `export const crashArtifactLines=Object.freeze(${JSON.stringify(lines)});\n` +
            'for (const lengths of Object.values(crashArtifactLines)) Object.freeze(lengths);\n' +
            'export const crashAssetBase=new URL(".",import.meta.url).href;\n'
        });
      }
    }
  };
}
