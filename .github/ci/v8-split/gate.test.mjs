import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSplit } from './core.mjs';

const root = process.cwd();
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha(readFileSync(file));
const value = n => String(n).repeat(40);
const digest = n => String(n).repeat(64);
const files = ['src/lib/miden/back/miden-client-proxy.test.ts', 'src/offscreen/main.test.ts', 'src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
const testRecord = file => [{ fullName: `${file} selected`, status: 'passed' }];
const gate = fileURLToPath(new URL('./gate.mjs', import.meta.url));
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'v8-gate-test-'));
  const source = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}');
  const installedBytes = Buffer.from('{"sdk":"fixture"}\n');
  const plan = planSplit({ source, tree, sdk: value(3), configSha256: hashFile('jest.config.ts'), mergeSha256: hashFile('scripts/merge-jest-coverage.mjs'), packageSetSha256: sha(installedBytes), addon: { verified: true, source, sdk: value(3), sdkTree: value(8), rustSdk: value(4), workflowSha: value(6), archiveSha256: digest(6), sha256: digest(3), cargoLockSha256: digest(4), runId: 1, artifactId: 2, features: 'nodejs', noDefaultFeatures: true, locked: true, conclusion: 'success' }, files, denominator: ['src/fake.ts'], suites: files.map(file => ({ file, blob: value(5), tests: testRecord(file) })) });
  const planFile = join(temp, 'plan.json'); writeFileSync(planFile, JSON.stringify(plan));
  const shards = join(temp, 'shards'); mkdirSync(shards);
  const make = (target, targetFiles) => {
    const dir = join(shards, target.id); mkdirSync(join(dir, 'proof'), { recursive: true }); mkdirSync(join(dir, 'replay/coverage'), { recursive: true });
    const write = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data));
    write('proof/source.json', { wallet_source: source, wallet_tree: tree, workflow: value(9) });
    write('proof/frozen-replay.json', { fresh_dependency_tree: true, source });
    writeFileSync(join(dir, 'proof/installed-identities.json'), installedBytes);
    write('proof/addon-binding.json', { source, sdk: value(3), sdkTree: value(8), rustSdk: value(4), sha256: digest(3), producerRunId: 1, artifactId: 2, cargoLockSha256: digest(4) });
    write('proof/coverage-root.json', { root });
    write('replay/coverage/jest-results.json', { success: true, numFailedTests: 0, numFailedTestSuites: 0, numRuntimeErrorTestSuites: 0, testResults: targetFiles.map(file => ({ name: join(root, file), assertionResults: testRecord(file) })) });
    const sourceFile = join(root, 'src/fake.ts');
    write('replay/coverage/coverage-final.json', { [sourceFile]: { path: sourceFile, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} } });
  };
  for (const g of plan.general) make(g, g.files);
  for (const p of plan.partitions) make(p, [p.file]);
  const gateProof = join(temp, 'gate-proof'); mkdirSync(gateProof);
  writeFileSync(join(gateProof, 'source.json'), JSON.stringify({ wallet_source: source, wallet_tree: tree, workflow: value(9) }));
  writeFileSync(join(gateProof, 'frozen-replay.json'), JSON.stringify({ fresh_dependency_tree: true, source }));
  writeFileSync(join(gateProof, 'installed-identities.json'), installedBytes);
  return { temp, shards, planFile, plan, gateProof };
}
test('gate checks source, complete shard evidence and canonicalizes maps', () => {
  const f = fixture();
  try {
    const output = execFileSync(process.execPath, [gate, f.planFile, f.shards, root, value(9), join(f.temp, 'canonical'), f.gateProof], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).coverageMaps.length, f.plan.general.length + f.plan.partitions.length);
    rmSync(join(f.shards, f.plan.general[0].id), { recursive: true });
    const bad = spawnSync(process.execPath, [gate, f.planFile, f.shards, root, value(9), join(f.temp, 'canonical-bad'), f.gateProof]);
    assert.notEqual(bad.status, 0);
  } finally { rmSync(f.temp, { recursive: true, force: true }); }
});
