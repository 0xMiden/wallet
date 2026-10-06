import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const generator = readFileSync(join(repoRoot, 'scripts/generate-note-relay-patch.mjs'));
const bundles: string[] = JSON.parse(readFileSync(join(repoRoot, 'scripts/note-relay-bundles.json'), 'utf8'));
const helper = 'export function normalizeNoteRelayFetch(input, init, request) { return request; }\n';
const patchedBundle = `// BEGIN note-relay-fetch
function normalizeNoteRelayFetch(input, init, request) { return request; }
// END note-relay-fetch

function __wbg_get_imports() {
  return {
    first(arg0, arg1, arg2) {
      const ret = normalizeNoteRelayFetch(arg1, arg2, arg0.fetch(arg1, arg2));
      return ret;
    },
    second(arg0, arg1) {
      const ret = normalizeNoteRelayFetch(arg0, arg1, fetch(arg0, arg1));
      return ret;
    }
  };
}
`;
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function check(sourceHelper: string, staleBundle?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-patch-check-'));
  directories.push(directory);
  const write = (file: string, contents: string | Buffer) => {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write('scripts/generate-note-relay-patch.mjs', generator);
  write('scripts/note-relay-bundles.json', JSON.stringify(bundles));
  write('package.json', JSON.stringify({ dependencies: { '@miden-sdk/miden-sdk': '0.17.0' } }));
  write('node_modules/@miden-sdk/miden-sdk/package.json', JSON.stringify({ version: '0.17.0' }));
  write('src/lib/miden/sdk/note-relay-fetch.mjs', sourceHelper);
  for (const bundle of bundles) {
    write(
      `node_modules/@miden-sdk/miden-sdk/${bundle}`,
      bundle === staleBundle ? patchedBundle.replace('return request;', 'return null;') : patchedBundle
    );
  }
  write(
    'patches/@miden-sdk+miden-sdk+0.17.0.patch',
    bundles
      .map(
        bundle =>
          `diff --git a/node_modules/@miden-sdk/miden-sdk/${bundle} b/node_modules/@miden-sdk/miden-sdk/${bundle}`
      )
      .join('\n')
  );
  return spawnSync(process.execPath, [join(directory, 'scripts/generate-note-relay-patch.mjs'), '--check'], {
    encoding: 'utf8'
  });
}

describe('relay patch checkout portability', () => {
  it.each([
    ['LF', helper],
    ['CRLF', helper.replace(/\n/g, '\r\n')]
  ])('accepts the same installed SDK patch with a %s helper checkout', (_ending, sourceHelper) => {
    const result = check(sourceHelper);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified for 6 bundles');
  });

  it('refuses a genuinely changed helper after normalizing its checkout', () => {
    const result = check(helper.replace('return request;', 'return null;').replace(/\n/g, '\r\n'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installed SDK relay patch is stale:');
  });

  it('refuses a stale multithreaded bundle after checking the preceding bundles', () => {
    const staleBundle = bundles[bundles.length - 1];
    const result = check(helper.replace(/\n/g, '\r\n'), staleBundle);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Installed SDK relay patch is stale: ${staleBundle}`);
  });
});
