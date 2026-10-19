import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.versions.node.split('.')[0], '22');
assert.equal(process.env.GITHUB_REF, 'refs/heads/ci/1615-minimum-visual');
const bundle = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const evidence = process.env.VISUAL_EVIDENCE;
const hash = data => createHash('sha256').update(data).digest('hex');
const request = JSON.parse(readFileSync(join(bundle, 'request.json')));
const candidate = JSON.parse(readFileSync(join(bundle, '../candidate-inputs/candidate-request.json')));
assert.equal(hash(readFileSync(join(evidence, 'workflow.yml'))), request.workflow_sha256);
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
assert.equal(git('rev-parse', 'HEAD'), request.source_commit);
assert.equal(git('write-tree'), request.candidate_tree);
assert.equal(candidate.patch_sha256, request.patch_sha256);
git('diff', '--exit-code');
for (const [name, expected] of Object.entries(request.fixture_files))
  assert.equal(hash(readFileSync(join(bundle, name))), expected, name);
const source = {};
for (const [name, expected] of Object.entries({
  ...candidate.protected_files,
  ...candidate.candidate_files,
  ...request.production_files
})) {
  source[name] = hash(readFileSync(join(repo, name)));
  assert.equal(source[name], expected, name);
}
const fixture = join(repo, 'playwright/visual/usdcx-minimum-proof');
mkdirSync(fixture, { recursive: true });
for (const name of request.staged_fixture_files) copyFileSync(join(bundle, name), join(fixture, name));
mkdirSync(evidence, { recursive: true });
writeFileSync(
  join(evidence, 'identity.json'),
  JSON.stringify(
    {
      transport_commit: process.env.GITHUB_SHA,
      source_commit: request.source_commit,
      source_tree: request.source_tree,
      candidate_tree: git('write-tree'),
      patch_sha256: request.patch_sha256,
      accepted_candidate_transport: request.accepted_candidate_transport,
      accepted_candidate_run: request.accepted_candidate_run,
      visual_request_sha256: hash(readFileSync(join(bundle, 'request.json'))),
      candidate_request_sha256: hash(readFileSync(join(bundle, '../candidate-inputs/candidate-request.json'))),
      fixture_files: request.fixture_files,
      unchanged_candidate_files: candidate.candidate_files,
      unchanged_protected_and_production_files: source,
      fixture_added_only_to_disposable_ci_checkout: true,
      candidate_tree_excludes_untracked_fixture: true
    },
    null,
    2
  ) + '\n'
);
