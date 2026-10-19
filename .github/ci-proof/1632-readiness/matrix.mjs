import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This runner executes only in GitHub Actions');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node22 or newer is required');
const bundle = path.dirname(fileURLToPath(import.meta.url));
const request = JSON.parse(readFileSync(path.join(bundle, 'request.json'), 'utf8'));
const repo = realpathSync(process.argv[2] || process.cwd());
const resultsDir = path.join(bundle, 'results');
mkdirSync(resultsDir, { recursive: true });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const artifact = name => readFileSync(path.join(bundle, name));
for (const [name, expected] of Object.entries(request.files)) {
  assert.equal(sha256(artifact(name)), expected, `Artifact hash mismatch: ${name}`);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
assert.equal(head.status, 0, 'Could not identify CI checkout');
assert.equal(head.stdout.trim(), request.source_commit, 'Check out the exact reviewed source commit for this proof');
const testPath = path.join(repo, request.test_path);
const productionPath = path.join(repo, request.production_path);
const originalTest = readFileSync(testPath);
const originalProduction = readFileSync(productionPath);
assert.equal(sha256(originalTest), request.files[request.old_test], 'CI test baseline differs from the reviewed source');
assert.equal(sha256(originalProduction), request.files[request.normal_production], 'CI production baseline differs from the reviewed source');
const normal = artifact(request.normal_production);
const mutant = artifact(request.mutant_production);
const mutation = request.production_mutation;
const normalText = normal.toString('utf8');
assert.equal(normalText.split(mutation.from).length - 1, 1, 'Readiness mutation must match once');
assert.equal(normalText.replace(mutation.from, mutation.to), mutant.toString('utf8'), 'Production mutant contains another change');
const escapedName = request.exact_test_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = `^${escapedName}$`;
const arms = [
  { name: 'old-normal', test: request.old_test, production: normal, exit: 0, status: 'passed' },
  { name: 'old-mutant', test: request.old_test, production: mutant, exit: 0, status: 'passed' },
  { name: 'new-normal', test: request.new_test, production: normal, exit: 0, status: 'passed' },
  { name: 'new-mutant', test: request.new_test, production: mutant, exit: 1, status: 'failed' }
];
const observed = [];
function runCase(arm, focused) {
  writeFileSync(testPath, artifact(arm.test));
  writeFileSync(productionPath, arm.production);
  const output = path.join(resultsDir, `${arm.name}.json`);
  const args = [
    path.join(repo, 'node_modules/jest/bin/jest.js'),
    '--runTestsByPath', request.test_path,
    '--maxWorkers=2', '--coverage=false', '--watch=false',
    '--json', '--outputFile', output
  ];
  if (focused) args.push('--testNamePattern', pattern);
  const run = spawnSync(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024
  });
  writeFileSync(path.join(resultsDir, `${arm.name}.log`), `${run.stdout || ''}\n${run.stderr || ''}`);
  assert.ifError(run.error);
  assert.equal(run.signal, null, `${arm.name} was interrupted`);
  assert.equal(run.status, arm.exit, `${arm.name} exited unexpectedly; inspect its log`);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.numRuntimeErrorTestSuites || 0, 0, `${arm.name} had a runtime/collection error`);
  const assertions = report.testResults.flatMap(row => {
    assert.ok(!row.testExecError, `${arm.name} had an execution error`);
    return row.assertionResults;
  });
  const selected = assertions.filter(row => row.status !== 'pending');
  if (focused) {
    assert.equal(selected.length, 1, `${arm.name} must run exactly the pending-readiness case`);
    assert.equal(selected[0].fullName, request.exact_test_name);
    assert.equal(selected[0].status, arm.status);
    assert.equal(report.numPassedTests, arm.exit === 0 ? 1 : 0);
    assert.equal(report.numFailedTests, arm.exit === 1 ? 1 : 0);
    if (arm.exit === 1) {
      const failure = selected[0].failureMessages.join('\n');
      assert.ok(failure.includes('not.toHaveBeenCalled'), 'Mutant failed at another assertion');
      for (const message of request.expected_failure.messages) {
        assert.ok(failure.includes(message), `Expected mutant assertion detail missing: ${message}`);
      }
      assert.ok(failure.includes(`fetch.test.ts:${request.expected_failure.line}:`), 'Mutant failed at another source location');
    }
  } else {
    assert.ok(selected.length > 1, 'Combined normal validation did not run the full named test file');
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPassedTests, report.numTotalTests);
    assert.ok(selected.every(row => row.status === 'passed'), 'Combined named test suite did not pass');
  }
  const row = {
    arm: arm.name,
    exit: run.status,
    test_sha256: sha256(readFileSync(testPath)),
    production_sha256: sha256(readFileSync(productionPath)),
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    selected: selected.map(({ fullName, status }) => ({ fullName, status }))
  };
  observed.push(row);
  console.log(JSON.stringify(row));
}
try {
  for (const arm of arms) runCase(arm, true);
  runCase({ name: 'combined-normal', test: request.combined_test, production: normal, exit: 0, status: 'passed' }, false);
  writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify({ source_commit: request.source_commit, observed }, null, 2) + '\n');
} finally {
  writeFileSync(testPath, originalTest);
  writeFileSync(productionPath, originalProduction);
  assert.equal(sha256(readFileSync(testPath)), sha256(originalTest), 'Test checkout was not restored');
  assert.equal(sha256(readFileSync(productionPath)), sha256(originalProduction), 'Production checkout was not restored');
}
