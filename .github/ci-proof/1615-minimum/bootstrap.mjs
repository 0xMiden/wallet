import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.versions.node.split('.')[0], '22');
const bundle = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const hash = data => createHash('sha256').update(data).digest('hex');
const request = JSON.parse(readFileSync(join(bundle, 'request.json')));
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
assert.equal(git('rev-parse', 'HEAD'), request.source_commit);
assert.equal(git('rev-parse', 'HEAD^{tree}'), request.source_tree);
assert.equal(git('status', '--porcelain'), '');
for (const [name, expected] of Object.entries(request.transport_files)) {
  assert.equal(hash(readFileSync(join(bundle, name))), expected, name);
}
for (const [name, expected] of Object.entries(request.base_files)) {
  assert.equal(hash(readFileSync(join(repo, name))), expected, name);
}
const patch = Buffer.from(readFileSync(join(bundle, 'checkpoint.patch.b64'), 'utf8'), 'base64');
assert.equal(hash(patch), request.patch_sha256);
writeFileSync(join(bundle, 'checkpoint.patch'), patch);
git('apply', '--check', join(bundle, 'checkpoint.patch'));
git('apply', join(bundle, 'checkpoint.patch'));
for (const [name, expected] of Object.entries(request.patched_files)) {
  assert.equal(hash(readFileSync(join(repo, name))), expected, name);
}
const changed = git('diff', '--name-only').split('\n').sort();
assert.deepEqual(changed, Object.keys(request.patched_files).sort());
writeFileSync(join(bundle, 'input-hashes.json'), JSON.stringify({ ...request, request_sha256: hash(readFileSync(join(bundle, 'request.json'))) }, null, 2) + '\n');
