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
const request = JSON.parse(readFileSync(join(bundle, 'candidate-request.json')));
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
assert.equal(git('rev-parse', 'HEAD'), request.source_commit);
assert.equal(git('rev-parse', 'HEAD^{tree}'), request.source_tree);
assert.equal(git('status', '--porcelain'), '');
assert.match(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/);
assert.equal(hash(readFileSync(join(bundle, 'proof-usdcx-minimum.yml'))), request.workflow_sha256);
for (const [name, expected] of Object.entries(request.transport_files)) {
  assert.equal(hash(readFileSync(join(bundle, name))), expected, name);
}
assert.equal(hash(readFileSync(join(bundle, 'candidate-manifest.json'))), request.candidate_manifest_sha256);
const manifest = JSON.parse(readFileSync(join(bundle, 'candidate-manifest.json')));
assert.equal(manifest.intended_candidate_tree, request.candidate_tree);
assert.deepEqual(Object.fromEntries(manifest.files.map(file => [file.path, file.sha256])), request.candidate_files);
for (const [name, expected] of Object.entries(request.protected_files)) {
  assert.equal(hash(readFileSync(join(repo, name))), expected, name);
}
const patch = Buffer.from(readFileSync(join(bundle, 'candidate.patch.b64'), 'utf8'), 'base64');
assert.equal(hash(patch), request.patch_sha256);
assert.equal(patch.length, request.patch_bytes);
writeFileSync(join(bundle, 'candidate.patch'), patch);
git('apply', '--check', '--index', join(bundle, 'candidate.patch'));
git('apply', '--index', join(bundle, 'candidate.patch'));
assert.equal(git('write-tree'), request.candidate_tree);
git('diff', '--exit-code');
assert.deepEqual(
  git('diff', '--cached', '--name-only').split('\n').sort(),
  Object.keys(request.candidate_files).sort()
);
for (const [name, expected] of Object.entries({ ...request.protected_files, ...request.candidate_files })) {
  assert.equal(hash(readFileSync(join(repo, name))), expected, name);
}
writeFileSync(
  join(bundle, 'candidate-input-hashes.json'),
  JSON.stringify(
    {
      ...request,
      transport_commit: process.env.GITHUB_SHA,
      request_sha256: hash(readFileSync(join(bundle, 'candidate-request.json'))),
      applied_tree: git('write-tree')
    },
    null,
    2
  ) + '\n'
);
