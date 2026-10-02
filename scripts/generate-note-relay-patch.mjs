import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = 'node_modules/@miden-sdk/miden-sdk';
const patchPath = resolve(root, 'patches/@miden-sdk+miden-sdk+0.16.3.patch');
const bundles = JSON.parse(readFileSync(resolve(root, 'scripts/note-relay-bundles.json'), 'utf8'));
const helper = readFileSync(resolve(root, 'src/lib/miden/sdk/note-relay-fetch.mjs'), 'utf8').replace(/^export /gm, '');
const block = `// BEGIN note-relay-fetch\n${helper}// END note-relay-fetch\n\n`;
const seams = [
  ['const ret = arg0.fetch(arg1, arg2);', 'const ret = normalizeNoteRelayFetch(arg1, arg2, arg0.fetch(arg1, arg2));'],
  ['const ret = fetch(arg0, arg1);', 'const ret = normalizeNoteRelayFetch(arg0, arg1, fetch(arg0, arg1));']
];
const check = process.argv.includes('--check');
// A linked web-sdk build (`Web SDK PR: #N`) installs a `file:` source build this patch cannot apply to.
const linked = String(
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).dependencies['@miden-sdk/miden-sdk']
).startsWith('file:');
if (linked && !check)
  throw new Error('Cannot generate the relay patch against a linked SDK build (`file:` dependency)');
if (linked) {
  console.log('Linked SDK build (`file:` dependency): the relay patch does not apply here; skipped');
  process.exit(0);
}
const version = JSON.parse(readFileSync(resolve(root, packagePath, 'package.json'), 'utf8')).version;
if (version !== '0.16.3') throw new Error(`Relay patch requires SDK 0.16.3, found ${version}`);

const temporary = check ? null : mkdtempSync(join(tmpdir(), 'note-relay-patch-'));
try {
  let patch = '';
  for (const bundle of bundles) {
    const path = `${packagePath}/${bundle}`;
    const current = readFileSync(resolve(root, path), 'utf8');
    let original = current.replace(/\/\/ BEGIN note-relay-fetch\n[^]*?\/\/ END note-relay-fetch\n\n/g, '');
    for (const [raw, wrapped] of seams) original = original.replace(wrapped, raw);
    let patched = original;
    for (const [raw, wrapped] of seams) {
      if (patched.split(raw).length !== 2) throw new Error(`Expected one SDK fetch seam in ${bundle}: ${raw}`);
      patched = patched.replace(raw, wrapped);
    }
    const imports = patched.match(/function __wbg_get_imports\([^)]*\) \{/g);
    if (imports?.length !== 1) throw new Error(`Missing imports in ${bundle}`);
    patched = patched.replace(imports[0], `${block}${imports[0]}`);
    if (check) {
      // Postinstall applied the committed patch, so these bytes are its proof. Its text is
      // never regenerated here: GNU and BSD diff align the same edit differently.
      if (current !== patched) {
        throw new Error(
          `Installed SDK relay patch is stale: ${bundle}. After a pull, reinstall the SDK so postinstall applies ` +
            'the committed patch: `rm -rf node_modules/@miden-sdk/miden-sdk && yarn install --check-files`. ' +
            'After editing the helper, regenerate with `node scripts/generate-note-relay-patch.mjs`.'
        );
      }
      continue;
    }
    writeFileSync(resolve(root, path), patched);
    const before = join(temporary, 'before');
    const after = join(temporary, 'after');
    writeFileSync(before, original);
    writeFileSync(after, patched);
    const result = spawnSync('diff', ['-u', '-L', `a/${path}`, '-L', `b/${path}`, before, after], { encoding: 'utf8' });
    if (result.status !== 1) throw new Error(`Cannot generate SDK diff: ${result.stderr}`);
    patch += `diff --git a/${path} b/${path}\n${result.stdout}`;
  }
  if (check) {
    // Write mode replaces the whole file, so anything else in it would be lost on regeneration.
    const files = [...readFileSync(patchPath, 'utf8').matchAll(/^diff --git a\/(\S+) b\//gm)].map(match => match[1]);
    const expected = bundles.map(bundle => `${packagePath}/${bundle}`);
    const unexpected = files.filter(file => !expected.includes(file));
    if (unexpected.length > 0)
      throw new Error(`Committed relay patch has an unexpected file: ${unexpected.join(', ')}`);
    if (files.join('\n') !== expected.join('\n'))
      throw new Error('Committed relay patch must list the six bundles in order');
  } else {
    writeFileSync(patchPath, patch);
  }
  console.log(`SDK relay patch ${check ? 'verified' : 'generated'} for ${bundles.length} bundles`);
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
