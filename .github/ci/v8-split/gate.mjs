import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { verifyResults } from './core.mjs';

const fail = message => { throw new Error(message); };
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const [planPath, artifactsPath, sourceRoot, workflowSha, canonicalDir] = process.argv.slice(2);
if (!planPath || !artifactsPath || !sourceRoot || !canonicalDir || !/^[0-9a-f]{40}$/.test(workflowSha ?? '')) fail('usage: gate.mjs PLAN ARTIFACT_ROOT SOURCE_ROOT WORKFLOW_SHA CANONICAL_DIR');
const plan = read(planPath);
const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== plan.source || git('rev-parse', 'HEAD^{tree}') !== plan.tree) fail('gate source identity mismatch');
if (sha(join(sourceRoot, 'jest.config.ts')) !== plan.configSha256 || sha(join(sourceRoot, 'scripts/merge-jest-coverage.mjs')) !== plan.mergeSha256) fail('coverage configuration or threshold script changed');
const ids = [...plan.general, ...plan.partitions].map(x => x.id);
const names = readdirSync(artifactsPath).sort();
if (!same(names, [...ids].sort())) fail('artifact directory set differs from plan');
let identities;
const rows = [];
const maps = [];
for (const id of ids) {
  const root = join(artifactsPath, id);
  const binding = read(join(root, 'proof/source.json'));
  if (binding.wallet_source !== plan.source || binding.wallet_tree !== plan.tree || binding.workflow !== workflowSha) fail(`${id}: source binding mismatch`);
  const replay = read(join(root, 'proof/frozen-replay.json'));
  if (!replay.fresh_dependency_tree || replay.source !== plan.source) fail(`${id}: non-frozen dependency replay`);
  if (sha(join(root, 'proof/installed-identities.json')) !== plan.packageSetSha256) fail(`${id}: installed package binding mismatch`);
  const installed = read(join(root, 'proof/installed-identities.json'));
  if (identities === undefined) identities = JSON.stringify(installed);
  else if (identities !== JSON.stringify(installed)) fail(`${id}: installed SDK identity differs`);
  const addon = read(join(root, 'proof/addon-binding.json'));
  if (addon.source !== plan.source || addon.sdk !== plan.sdk || addon.rustSdk !== plan.addon.rustSdk || addon.sha256 !== plan.addon.sha256 || addon.producerRunId !== plan.addon.runId || addon.artifactId !== plan.addon.artifactId || addon.cargoLockSha256 !== plan.addon.cargoLockSha256) fail(`${id}: addon identity mismatch`);
  const result = read(join(root, 'replay/coverage/jest-results.json'));
  const coveragePath = join(root, 'replay/coverage/coverage-final.json');
  const coverage = read(coveragePath);
  const checkout = resolve(read(join(root, 'proof/coverage-root.json')).root);
  const normalize = file => {
    const rel = relative(checkout, resolve(file));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/')) fail(`${id}: path outside checkout`);
    return rel.split(sep).join('/');
  };
  const canonical = {};
  const coverageFiles = Object.entries(coverage).map(([key, value]) => {
    const path = normalize(key);
    if (!value || normalize(value.path) !== path || !value.statementMap || !value.fnMap || !value.branchMap || !value.s || !value.f || !value.b) fail(`${id}: malformed coverage map`);
    const destination = resolve(sourceRoot, path);
    if (canonical[destination]) fail(`${id}: duplicate normalized coverage path`);
    canonical[destination] = { ...value, path: destination };
    return path;
  });
  maps.push({ id, canonical });
  if (result.numFailedTestSuites !== 0) fail(`${id}: failed test suite`);
  const suites = result.testResults.map(suite => ({ file: normalize(suite.name), tests: suite.assertionResults.map(test => ({ fullName: test.fullName, status: test.status })) }));
  rows.push({ id, source: binding.wallet_source, tree: binding.wallet_tree, sdk: addon.sdk, addonSha256: addon.sha256, planSha256: plan.planSha256, success: result.success, failed: result.numFailedTests, runtimeErrors: result.numRuntimeErrorTestSuites, suites, coverageFiles, coverageSha256: sha(coveragePath) });
}
verifyResults(plan, rows);
// Normalize absolute runner paths so identical source files merge rather than duplicate.
mkdirSync(canonicalDir, { recursive: false });
const coverageMaps = maps.map(({ id, canonical }) => {
  const file = join(canonicalDir, `${id}.json`);
  writeFileSync(file, JSON.stringify(canonical), { flag: 'wx' });
  return file;
});
// The caller invokes the checked-in merge-jest-coverage.mjs once with exactly these maps.
console.log(JSON.stringify({ planSha256: plan.planSha256, artifacts: ids, coverageMaps }));
