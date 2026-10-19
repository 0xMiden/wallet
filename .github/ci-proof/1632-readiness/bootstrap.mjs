import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Bootstrap executes only in GitHub Actions');
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Node22 is required');
const bundle = path.dirname(fileURLToPath(import.meta.url));
const request = JSON.parse(readFileSync(path.join(bundle, 'request.json'), 'utf8'));
const repo = realpathSync(process.argv[2]);
const sha256 = data => createHash('sha256').update(data).digest('hex');
function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
assert.equal(git('rev-parse', 'HEAD'), request.source_commit);
assert.equal(git('rev-parse', 'HEAD^{tree}'), request.source_tree);
const testPath = path.join(repo, request.test_path);
const originalTest = readFileSync(testPath);
const originalProduction = readFileSync(path.join(repo, request.production_path));
assert.equal(sha256(originalTest), request.files[request.old_test]);
assert.equal(sha256(originalProduction), request.files[request.normal_production]);
for (const name of [
  'README.md',
  'matrix.mjs',
  'f001-readiness.patch',
  'f002-description.patch',
  'test-fixes.patch',
  'temporary-production-mutant.patch'
]) {
  assert.equal(sha256(readFileSync(path.join(bundle, name))), request.files[name], name);
}
writeFileSync(path.join(bundle, request.old_test), originalTest);
writeFileSync(path.join(bundle, request.normal_production), originalProduction);
const normal = originalProduction.toString('utf8');
const mutation = request.production_mutation;
assert.equal(mutation.occurrences, 1);
assert.equal(normal.split(mutation.from).length - 1, mutation.occurrences);
writeFileSync(path.join(bundle, request.mutant_production), normal.replace(mutation.from, mutation.to));
try {
  git('apply', '--check', path.join(bundle, 'f001-readiness.patch'));
  git('apply', path.join(bundle, 'f001-readiness.patch'));
  writeFileSync(path.join(bundle, request.new_test), readFileSync(testPath));
  git('apply', '--check', path.join(bundle, 'f002-description.patch'));
  git('apply', path.join(bundle, 'f002-description.patch'));
  writeFileSync(path.join(bundle, request.combined_test), readFileSync(testPath));
} finally {
  writeFileSync(testPath, originalTest);
  assert.equal(sha256(readFileSync(testPath)), sha256(originalTest));
  assert.equal(sha256(readFileSync(path.join(repo, request.production_path))), sha256(originalProduction));
}
const hashes = {};
for (const [name, expected] of Object.entries(request.files)) {
  hashes[name] = sha256(readFileSync(path.join(bundle, name)));
  assert.equal(hashes[name], expected, `Artifact hash mismatch: ${name}`);
}
hashes['request.json'] = sha256(readFileSync(path.join(bundle, 'request.json')));
hashes['bootstrap.mjs'] = sha256(readFileSync(fileURLToPath(import.meta.url)));
writeFileSync(path.join(bundle, 'proof-input-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
