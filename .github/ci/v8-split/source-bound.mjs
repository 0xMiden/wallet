// Read-only CI preparation. This program never pushes or dispatches.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSplit } from './core.mjs';
import { renderAddonWorkflow } from './addon-workflow.mjs';
import { renderBaselineWorkflow } from './baseline-workflow.mjs';

const fail = message => { throw new Error(message); };
const hex40 = x => /^[0-9a-f]{40}$/.test(x ?? '');
const hex64 = x => /^[0-9a-f]{64}$/.test(x ?? '');
const digest = x => createHash('sha256').update(x).digest('hex');
const json = x => JSON.parse(x.toString('utf8'));
const command = (name, args, opts = {}) => execFileSync(name, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (...args) => command('git', args, { encoding: 'utf8' }).trim();
const api = path => json(command('gh', ['api', path]));
const [approvalPath, outputPath] = process.argv.slice(2);
if (!approvalPath || !outputPath) fail('usage: source-bound.mjs APPROVAL_JSON OUTPUT_JSON');
const approval = json(readFileSync(approvalPath));
const { source, sdk, sdkTree, rustSdk, cargoLockSha256, packageSetSha256, baseline, addon } = approval;
if (!hex40(sdkTree) || !hex40(rustSdk) || !hex64(cargoLockSha256) || !hex64(packageSetSha256)) fail('missing approved SDK dependency identities');
if (!hex40(source) || !hex40(sdk) || git('show', '-s', '--format=%G?', source) !== 'G') fail('wallet source must be signed');
const tree = git('rev-parse', `${source}^{tree}`);
function artifact(spec, label, required) {
  if (!spec || !Number.isSafeInteger(spec.runId) || !Number.isSafeInteger(spec.artifactId) || !hex40(spec.workflowSha) || !spec.proofBlobs || typeof spec.proofBlobs !== 'object' || !Object.keys(spec.proofBlobs).length) fail(`${label}: missing approved producer identity`);
  const run = api(`repos/0xMiden/wallet/actions/runs/${spec.runId}`);
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== spec.workflowSha) fail(`${label}: producer is not exact successful workflow`);
  if (git('show', '-s', '--format=%G?', spec.workflowSha) !== 'G' || git('rev-parse', `${spec.workflowSha}^`) !== source) fail(`${label}: workflow is not a signed direct child of source`);
  const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', spec.workflowSha).split('\n').filter(Boolean).sort();
  const approved = Object.keys(spec.proofBlobs).sort();
  if (JSON.stringify(changed) !== JSON.stringify(approved) || approved.some(path => !path.startsWith('.github/') || !hex40(spec.proofBlobs[path]) || git('rev-parse', `${spec.workflowSha}:${path}`) !== spec.proofBlobs[path])) fail(`${label}: producer proof code mismatch`);
  const info = api(`repos/0xMiden/wallet/actions/artifacts/${spec.artifactId}`);
  if (info.expired || info.workflow_run?.id !== spec.runId || typeof info.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(info.digest)) fail(`${label}: artifact provenance or digest unavailable`);
  const archive = command('gh', ['api', `repos/0xMiden/wallet/actions/artifacts/${spec.artifactId}/zip`]);
  if (`sha256:${digest(archive)}` !== info.digest) fail(`${label}: artifact digest mismatch`);
  const temp = mkdtempSync(join(tmpdir(), 'wallet-v8-proof-'));
  try {
    const zip = join(temp, 'artifact.zip'); writeFileSync(zip, archive);
    const names = command('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
    if (JSON.stringify(names) !== JSON.stringify([...required].sort())) fail(`${label}: archive contents mismatch`);
    const files = Object.fromEntries(required.map(name => [name, command('unzip', ['-p', zip, name])]));
    return { files, run, info };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
const produced = artifact(addon, 'addon', ['addon.json', 'miden_client_web.node']);
if (addon.workflowPath !== '.github/workflows/issue1948-sdk-injection.yml' || !addon.proofBlobs?.[addon.workflowPath] || command('git', ['show', `${addon.workflowSha}:${addon.workflowPath}`]).toString('utf8') !== renderAddonWorkflow({ source, sdk, sdkTree, rustSdk, cargoLockSha256 })) fail('addon: approved workflow implementation differs');
if (addon?.builderPath !== '.github/ci/v8-split/addon-builder.cjs' || JSON.stringify(Object.keys(addon.proofBlobs ?? {}).sort()) !== JSON.stringify([addon.builderPath, addon.workflowPath].sort()) || !command('git', ['show', `${addon.workflowSha}:${addon.builderPath}`]).equals(readFileSync(new URL('addon-builder.cjs', import.meta.url)))) fail('addon: approved builder implementation differs');
const addonInfo = json(produced.files['addon.json']);
if (addonInfo.source !== source || addonInfo.sdk !== sdk || addonInfo.sdkTree !== sdkTree || addonInfo.rustSdk !== rustSdk || addonInfo.cargoLockSha256 !== cargoLockSha256 || addonInfo.features !== 'nodejs' || addonInfo.noDefaultFeatures !== true || addonInfo.locked !== true || addonInfo.sha256 !== digest(produced.files['miden_client_web.node'])) fail('addon: source, features, lock or binary mismatch');
if (approval.mode === 'addon-only') {
  const output = { source, tree, sdk, packageSetSha256, addon: { verified: true, source, sdk, sdkTree, rustSdk: addonInfo.rustSdk, sha256: addonInfo.sha256, cargoLockSha256: addonInfo.cargoLockSha256, runId: addon.runId, artifactId: addon.artifactId, workflowSha: addon.workflowSha, archiveSha256: produced.info.digest.slice(7), features: addonInfo.features, noDefaultFeatures: addonInfo.noDefaultFeatures, locked: addonInfo.locked, conclusion: 'success' } };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ source, addonRun: addon.runId, addonArtifact: addon.artifactId, dispatched: false }));
  process.exit(0);
}
const baselinePaths = ['.github/workflows/issue1948-sdk-injection.yml', '.github/ci/issue1948-sdk-injection.py', '.github/ci/issue1948-sdk-injection-inputs.json', '.github/ci/v8-split/fetch-addon.cjs', '.github/ci/v8-split/baseline-runner.cjs', '.github/ci/v8-split/denominator.cjs', '.github/ci/v8-split/addon-plan.json'];
if (!baseline || JSON.stringify(Object.keys(baseline.proofBlobs ?? {}).sort()) !== JSON.stringify([...baselinePaths].sort())) fail('baseline: unexpected proof code closure');
if (baseline.runnerPath !== baselinePaths[4] || baseline.denominatorPath !== baselinePaths[5]) fail('baseline: producer paths differ');
const fromWorkflow = path => command('git', ['show', `${baseline.workflowSha}:${path}`]);
if (fromWorkflow(baselinePaths[0]).toString('utf8') !== renderBaselineWorkflow(source)) fail('baseline: approved workflow implementation differs');
if (!fromWorkflow(baselinePaths[1]).equals(readFileSync(new URL('../combined-external-boundary-baseline-execution/inject.py', import.meta.url))) || !fromWorkflow(baselinePaths[3]).equals(readFileSync(new URL('fetch-addon.cjs', import.meta.url)))) fail('baseline: injection or addon staging implementation differs');
const expectedConfig = json(readFileSync(new URL('../combined-external-boundary-baseline-execution/config.json', import.meta.url)));
Object.assign(expectedConfig, { wallet_source: source, wallet_tree: tree, phase: 'v8-source-bound-baseline', proof_paths: baselinePaths });
if (JSON.stringify(json(fromWorkflow(baselinePaths[2]))) !== JSON.stringify(expectedConfig)) fail('baseline: injection configuration differs');
const baselineAddonPlan = json(fromWorkflow(baselinePaths[6]));
if (baselineAddonPlan.source !== source || baselineAddonPlan.tree !== tree || baselineAddonPlan.sdk !== sdk || baselineAddonPlan.packageSetSha256 !== packageSetSha256 || baselineAddonPlan.addon?.sha256 !== addonInfo.sha256 || baselineAddonPlan.addon?.workflowSha !== addon.workflowSha || baselineAddonPlan.addon?.runId !== addon.runId || baselineAddonPlan.addon?.artifactId !== addon.artifactId || baselineAddonPlan.addon?.archiveSha256 !== produced.info.digest.slice(7) || baselineAddonPlan.addon?.sdkTree !== sdkTree || baselineAddonPlan.addon?.rustSdk !== rustSdk || baselineAddonPlan.addon?.cargoLockSha256 !== cargoLockSha256) fail('baseline: addon plan differs');
for (const [key, local] of [['runnerPath', 'baseline-runner.cjs'], ['denominatorPath', 'denominator.cjs']]) {
  const remote = baseline[key];
  if (typeof remote !== 'string' || !baseline.proofBlobs[remote] || !command('git', ['show', `${baseline.workflowSha}:${remote}`]).equals(readFileSync(new URL(local, import.meta.url)))) fail(`baseline: ${key} implementation differs`);
}
const observed = artifact(baseline, 'baseline', ['binding.json', 'denominator.json', 'inventory.json', 'jest-results.json']);
const binding = json(observed.files['binding.json']);
if (binding.source !== source || binding.tree !== tree || binding.sdk !== sdk || binding.addonSha256 !== addonInfo.sha256 || binding.packageSetSha256 !== packageSetSha256 || binding.configSha256 !== digest(command('git', ['show', `${source}:jest.config.ts`])) || binding.mergeSha256 !== digest(command('git', ['show', `${source}:scripts/merge-jest-coverage.mjs`]))) fail('baseline: source, SDK, addon or configuration mismatch');
const inventory = json(observed.files['inventory.json']);
const result = json(observed.files['jest-results.json']);
const denominator = json(observed.files['denominator.json']);
if (!result.success || !Number.isSafeInteger(result.numPassedTests) || result.numPassedTests < 1 || result.numFailedTests || result.numFailedTestSuites || result.numRuntimeErrorTestSuites || !Array.isArray(inventory.files) || !Array.isArray(denominator.files) || binding.inventorySha256 !== digest(observed.files['inventory.json']) || binding.resultsSha256 !== digest(observed.files['jest-results.json']) || binding.denominatorSha256 !== digest(observed.files['denominator.json'])) fail('baseline: inventory, denominator or result binding failed');
if (!Array.isArray(result.testResults) || result.testResults.length !== inventory.files.length || result.numTotalTestSuites !== inventory.files.length) fail('baseline: full suite count mismatch');
const allTests = result.testResults.flatMap(s => s.assertionResults ?? []);
if (result.numTotalTests !== allTests.length || result.numPassedTests !== allTests.filter(t => t.status === 'passed').length || result.numPendingTests !== allTests.filter(t => t.status === 'pending').length || result.numTodoTests !== allTests.filter(t => t.status === 'todo').length) fail('baseline: full test count mismatch');
const suites = result.testResults.map(s => {
  if (typeof s.file !== 'string' || !inventory.files.includes(s.file)) fail('baseline: unbound test file');
  return { file: s.file, blob: git('rev-parse', `${source}:${s.file}`), tests: s.assertionResults.map(t => ({ fullName: t.fullName, status: t.status })) };
});
const plan = planSplit({ source, tree, sdk, addon: { verified: true, source, sdk, sdkTree, rustSdk: addonInfo.rustSdk, sha256: addonInfo.sha256, cargoLockSha256: addonInfo.cargoLockSha256, runId: addon.runId, artifactId: addon.artifactId, workflowSha: addon.workflowSha, archiveSha256: produced.info.digest.slice(7), features: addonInfo.features, noDefaultFeatures: addonInfo.noDefaultFeatures, locked: addonInfo.locked, conclusion: 'success' }, files: inventory.files, suites, denominator: denominator.files, configSha256: binding.configSha256, mergeSha256: binding.mergeSha256, packageSetSha256 });
writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ source, planSha256: plan.planSha256, general: plan.general.length, partitions: plan.partitions.length, dispatched: false }));
