import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function buildFixture(root: string): void {
  const plugin = pathToFileURL(resolve(__dirname, 'crash-artifact-registry.ts')).href;
  const vite = pathToFileURL(resolve('node_modules/vite/dist/node/index.js')).href;
  const code = `import {build} from ${JSON.stringify(vite)};
    import {walletCrashArtifactRegistry} from ${JSON.stringify(plugin)};
    await build({configFile:false,root:${JSON.stringify(root)},logLevel:'silent',
      plugins:[walletCrashArtifactRegistry(), {name:'final-code-change',generateBundle(_,bundle){
        for(const file of Object.values(bundle))if(file.type==='chunk')file.code+='\\n// final emitted line';
        this.emitFile({type:'asset',fileName:'assets/worker.js',source:'globalThis.workerReady=true;'});
        this.emitFile({type:'asset',fileName:'assets/binary-worker.js',source:new TextEncoder().encode('globalThis.ready=true;')});
      }}],
      build:{write:true,outDir:'dist',minify:true,sourcemap:false,
        rollupOptions:{input:'entry.js',preserveEntrySignatures:'strict',output:{entryFileNames:'entry.js',chunkFileNames:'chunks/[name].[hash].js'}}}});`;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    stdio: 'pipe'
  });
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wallet-crash-registry-'));
  roots.push(root);
  const frames = resolve(__dirname, '../telemetry/crash-frames.ts');
  writeFileSync(
    join(root, 'entry.js'),
    `import {sanitizeWalletFrame} from ${JSON.stringify(frames)};
    export const check=sanitizeWalletFrame;export const load=()=>import('./child.js');`
  );
  writeFileSync(join(root, 'child.js'), 'export const child = 42;');
  return root;
}

function linesInRegistry(root: string): Record<string, number[]> {
  const registry = readFileSync(join(root, 'dist/wallet-crash-artifacts.js'), 'utf8');
  const match = registry.match(/crashArtifactLines=Object\.freeze\((.*)\);/);
  if (!match?.[1]) throw new Error('missing generated artifact bounds');
  return JSON.parse(match[1]);
}

describe('native bundle crash artifact registry', () => {
  it('emits exact chunk bounds after final code changes without a content-hash dependency cycle', () => {
    const root = fixture();
    buildFixture(root);
    const lines = linesInRegistry(root);
    expect(Object.keys(lines).sort()).toEqual(
      [
        'entry.js',
        'assets/worker.js',
        'assets/binary-worker.js',
        ...readdirSync(join(root, 'dist/chunks')).map(n => `chunks/${n}`)
      ].sort()
    );
    for (const [filename, lengths] of Object.entries(lines)) {
      expect(lengths).toEqual(
        readFileSync(join(root, 'dist', filename), 'utf8')
          .split('\n')
          .map(line => line.length)
      );
    }
    const entry = readFileSync(join(root, 'dist/entry.js'), 'utf8');
    expect(entry).toContain('/wallet-crash-artifacts.js');
    expect(readFileSync(join(root, 'dist/wallet-crash-artifacts.js'), 'utf8')).toContain('import.meta.url');
    expect(readdirSync(join(root, 'dist')).some(n => n.endsWith('.map'))).toBe(false);
  });

  it('bounds compiled worker assets emitted by the nested worker build', () => {
    const root = fixture();
    buildFixture(root);
    const lines = linesInRegistry(root);
    expect(lines['assets/worker.js']).toEqual([28]);
    expect(lines['assets/binary-worker.js']).toEqual([22]);
  });

  it('replaces stale hashed entries on a clean rebuild', () => {
    const root = fixture();
    buildFixture(root);
    const initial = Object.keys(linesInRegistry(root)).find(name => name.startsWith('chunks/'));
    writeFileSync(join(root, 'child.js'), 'export const child = 12345;');
    buildFixture(root);
    const lines = Object.keys(linesInRegistry(root));
    expect(lines).not.toContain(initial);
    expect(lines.some(name => name.startsWith('chunks/'))).toBe(true);
  });
});
