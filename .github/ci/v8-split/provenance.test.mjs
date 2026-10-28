import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAddonWorkflow } from './addon-workflow.mjs';
import { renderBaselineWorkflow } from './baseline-workflow.mjs';
const script = fileURLToPath(new URL('./source-bound.mjs', import.meta.url));
const h40 = n => String(n).repeat(40);
const h64 = n => String(n).repeat(64);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'v8-provenance-test-'));
  const git = join(dir, 'git'); const gh = join(dir, 'gh');
  writeFileSync(git, `#!/bin/sh\ncase "$1" in show) echo G;; rev-parse) echo ${h40(2)};; *) exit 1;; esac\n`);
  writeFileSync(gh, `#!/bin/sh\nprintf called > "${dir}/called"\nprintf '%s\\n' '{"status":"completed","conclusion":"failure","head_sha":"${h40(5)}"}'\n`);
  chmodSync(git, 0o755); chmodSync(gh, 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, approval: { source: h40(1), sdk: h40(3), sdkTree: h40(8), rustSdk: h40(4), cargoLockSha256: h64(1), packageSetSha256: h64(2), mode: 'addon-only' } };
}
test('no exact addon producer refuses before any API call or output', () => {
  const f = setup(); try {
    const input = join(f.dir, 'approval.json'); const output = join(f.dir, 'plan.json'); writeFileSync(input, JSON.stringify(f.approval));
    const result = spawnSync(process.execPath, [script, input, output], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /missing approved producer identity/); assert(!existsSync(output)); assert(!existsSync(join(f.dir, 'called')));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('failed producer cannot authorize bundle generation', () => {
  const f = setup(); try {
    f.approval.addon = { runId: 1, artifactId: 2, workflowSha: h40(5), proofBlobs: { '.github/workflows/proof.yml': h40(6) } };
    const input = join(f.dir, 'approval.json'); const output = join(f.dir, 'plan.json'); writeFileSync(input, JSON.stringify(f.approval));
    const result = spawnSync(process.execPath, [script, input, output], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /producer is not exact successful workflow/); assert(!existsSync(output)); assert.equal(readFileSync(join(f.dir, 'called'), 'utf8'), 'called');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('full and baseline bundle generators fail before output when addon is absent', () => {
  const f = setup();
  const repo = process.cwd();
  const parent = join(repo, 'docs/superpowers');
  const output = join(parent, `v8-no-addon-synthetic-${process.pid}`);
  try {
    const input = join(f.dir, 'approval.json'); writeFileSync(input, JSON.stringify(f.approval));
    for (const name of ['generate.mjs', 'generate-baseline.mjs']) {
      const generator = fileURLToPath(new URL(`./${name}`, import.meta.url));
      const result = spawnSync(process.execPath, [generator, input, output], { env: f.env, encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert(!existsSync(output)); assert(!existsSync(join(f.dir, 'called')));
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});
test('addon producer refuses missing source identities before build', () => {
  const builder = fileURLToPath(new URL('./addon-builder.cjs', import.meta.url));
  const result = spawnSync(process.execPath, [builder], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Missing addon producer arguments/);
});

test('deterministic producer workflows bind source and avoid testing feature', () => {
  const source = h40(1); const sdk = h40(3); const sdkTree = h40(8); const rustSdk = h40(4); const cargoLockSha256 = h64(1);
  const addon = renderAddonWorkflow({ source, sdk, sdkTree, rustSdk, cargoLockSha256 });
  assert(addon.includes(`addon-builder.cjs sdk addon addon-proof ${source} ${sdk} ${sdkTree} ${rustSdk} ${cargoLockSha256}`));
  const builder = readFileSync(fileURLToPath(new URL('./addon-builder.cjs', import.meta.url)), 'utf8');
  assert(builder.includes("'--no-default-features', '--features', 'nodejs', '--release', '--locked'"));
  assert(!builder.includes("'--features', 'testing'"));
  assert(addon.includes('if: success()'));
  const baseline = renderBaselineWorkflow(source);
  assert(baseline.includes(`ref: ${source}`));
  assert(baseline.includes('fetch-addon.cjs'));
  assert(baseline.includes('baseline-runner.cjs'));
});
