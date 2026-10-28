import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const generator = fileURLToPath(new URL('./generate-addon.mjs', import.meta.url));
const h40 = n => String(n).repeat(40);
const sha = data => createHash('sha256').update(data).digest('hex');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'v8-addon-generator-'));
  const git = join(dir, 'git'); const gh = join(dir, 'gh');
  const lock = Buffer.from(`version = 4\nsource = "git+fixture#${h40(4)}"\n`);
  writeFileSync(git, `#!/bin/sh\ncase "$1" in show) echo G;; rev-parse) echo ${h40(2)};; *) exit 1;; esac\n`);
  const commit = JSON.stringify({ sha: h40(3), tree: { sha: h40(8) } });
  const file = JSON.stringify({ encoding: 'base64', content: lock.toString('base64') });
  writeFileSync(gh, `#!/bin/sh\ncase "$2" in *git/commits*) printf '%s\\n' '${commit}';; *contents/Cargo.lock*) printf '%s\\n' '${file}';; *) exit 1;; esac\n`);
  chmodSync(git, 0o755); chmodSync(gh, 0o755);
  const parent = join(process.cwd(), 'docs/superpowers'); mkdirSync(parent, { recursive: true });
  return { dir, output: join(parent, `v8-addon-synthetic-${process.pid}`), env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, approval: { source: h40(1), sdk: h40(3), sdkTree: h40(8), rustSdk: h40(4), cargoLockSha256: sha(lock) } };
}
function invoke(f) {
  const input = join(f.dir, 'approval.json'); writeFileSync(input, JSON.stringify(f.approval));
  return spawnSync(process.execPath, [generator, input, f.output], { env: f.env, encoding: 'utf8' });
}
test('addon preparation rejects wrong source, SDK tree and lock before output', () => {
  for (const change of [{ source: 'bad' }, { sdkTree: h40(7) }, { cargoLockSha256: '0'.repeat(64) }, { rustSdk: h40(9) }]) {
    const f = setup(); try {
      Object.assign(f.approval, change); const result = invoke(f);
      assert.notEqual(result.status, 0); assert(!existsSync(f.output));
    } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(f.output, { recursive: true, force: true }); }
  }
});
test('valid synthetic identities prepare only a source-bound bundle', () => {
  const f = setup(); try {
    const result = invoke(f); assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.dispatched, false); assert.equal(manifest.source, f.approval.source); assert.equal(manifest.sdk_tree, f.approval.sdkTree);
    assert.equal(Object.keys(manifest.files).length, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(f.output, { recursive: true, force: true }); }
});
