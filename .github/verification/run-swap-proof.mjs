import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync(new URL('./swap-mutants.json', import.meta.url), 'utf8'));
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(sourceHead, process.env.PRODUCT_SHA);
assert.equal(config.productSha, sourceHead);
assert.ok(config.mutants.length > 0, 'No regression mutations supplied');
const outputDir = path.resolve(process.env.PROOF_OUTPUT_DIR);
mkdirSync(outputDir, { recursive: true });

function runTests(label, tests, namePattern) {
  const reportFile = path.join(outputDir, `${label}.json`);
  const args = ['node_modules/jest/bin/jest.js', '--runInBand', '--coverage=false', '--json',
    `--outputFile=${reportFile}`, '--runTestsByPath', ...tests];
  if (namePattern) args.push(`--testNamePattern=${namePattern}`);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(result.error);
  writeFileSync(path.join(outputDir, `${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  console.log(JSON.stringify({ label, exitCode: result.status, passed: report.numPassedTests,
    failed: report.numFailedTests, runtimeErrors: report.numRuntimeErrorTestSuites }));
  return { result, report };
}

function requirePassing(label, tests) {
  const { result, report } = runTests(label, tests);
  assert.equal(result.status, 0, `${label} failed; see its log`);
  assert.equal(report.numFailedTests, 0);
  assert.ok(report.numPassedTests > 0);
  assert.equal(report.numRuntimeErrorTestSuites, 0);
}

requirePassing('baseline', config.tests);
for (const mutant of config.mutants) {
  assert.match(mutant.id, /^[a-z0-9-]+$/);
  const originals = new Map();
  try {
    for (const change of mutant.changes) {
      assert.ok(!path.isAbsolute(change.path) && !change.path.split('/').includes('..'));
      const original = readFileSync(change.path, 'utf8');
      assert.ok(!originals.has(change.path), `Duplicate mutation path: ${change.path}`);
      originals.set(change.path, original);
      assert.equal(original.split(change.before).length - 1, 1,
        `${mutant.id}: source fragment must occur once in ${change.path}`);
      writeFileSync(change.path, original.replace(change.before, change.after));
    }
    const { result, report } = runTests(mutant.id, mutant.tests, mutant.namePattern);
    assert.equal(result.status, 1, `${mutant.id}: mutation did not fail normally`);
    assert.equal(report.numRuntimeErrorTestSuites, 0, `${mutant.id}: runtime/type failure is not proof`);
    const failures = report.testResults.flatMap(suite => suite.assertionResults)
      .filter(test => test.status === 'failed');
    assert.ok(failures.length > 0, `${mutant.id}: no assertion failed`);
    for (const prediction of mutant.predictions) {
      const matching = failures.filter(test => new RegExp(prediction.test).test(test.fullName));
      assert.ok(matching.length > 0, `${mutant.id}: predicted test did not fail`);
      assert.ok(matching.some(test => test.failureMessages.some(message =>
        new RegExp(prediction.message).test(message))), `${mutant.id}: predicted assertion did not fail`);
    }
    writeFileSync(path.join(outputDir, `${mutant.id}-failures.json`), JSON.stringify(failures, null, 2));
    console.log(`${mutant.id}: predicted assertions failed`);
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original);
  }
  execFileSync('git', ['diff', '--exit-code', sourceHead, '--', ...originals.keys()]);
}
requirePassing('restored', config.tests);
