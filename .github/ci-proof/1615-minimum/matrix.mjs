import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.versions.node.split('.')[0], '22');
const bundle = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const request = JSON.parse(readFileSync(join(bundle, 'request.json')));
const hash = data => createHash('sha256').update(data).digest('hex');
const results = join(bundle, 'results');
mkdirSync(results, { recursive: true });
const hook = 'src/lib/usdcx/use-burn-minimum.test.ts';
const fixture = 'playwright/e2e/helpers/usdcx-config.test.ts';
const production = 'src/lib/usdcx/use-burn-minimum.ts';
const original = readFileSync(join(repo, production));
const stale = 'ignores a stale read after disabling and re-enabling';
const hookNames = ['shows 5 USDCx until the read lands, then the read minimum', 'makes no read while disabled', stale];
const consumerNames = ['Arc Testnet', 'Base Sepolia', 'Arbitrum Sepolia', 'Sepolia'].map(name => `allows the live burn amount through the wallet minimum check on ${name}`);
const fixtureNames = ['keeps the E2E burn protocol values equal to the wallet values', ...consumerNames,
  'keeps the E2E payout floor equal to the configured wallet payout floor',
  ...[84532, 421614, 11155111].map(id => `reads the executor route of chain ${id} from the fixture as the wallet reads it`),
  'lists Base Sepolia, Arbitrum Sepolia, then Ethereum Sepolia, each read where usdcx-burn-l2 reads it'];
const expectedFiles = { ...request.base_files, ...request.patched_files };
function verify() {
  for (const [name, expected] of Object.entries(expectedFiles)) assert.equal(hash(readFileSync(join(repo, name))), expected, name);
}
verify();
const arms = [
  { name: 'checkpoint-normal', files: [hook, fixture], failed: consumerNames, names: [...hookNames, ...fixtureNames] },
  { name: 'hook-normal', files: [hook], failed: [], names: hookNames },
  { name: 'guard-removed', files: [hook], failed: [stale], names: hookNames, from: 'if (!disposed) setMinimum(value);', to: 'setMinimum(value);' },
  { name: 'cleanup-removed', files: [hook], failed: [stale], names: hookNames, from: 'disposed = true;', to: '' }
];
const observed = [];
let completed = false;
try {
  for (const arm of arms) {
    verify();
    try {
      if (arm.from) {
        const text = original.toString();
        assert.equal(text.split(arm.from).length - 1, 1);
        writeFileSync(join(repo, production), text.replace(arm.from, arm.to));
      }
      const output = join(results, `${arm.name}.json`);
      const run = spawnSync(process.execPath, [join(repo, 'node_modules/jest/bin/jest.js'), '--runTestsByPath', ...arm.files,
        '--maxWorkers=2', '--coverage=false', '--watch=false', '--testResultsProcessor', join(bundle, 'results-processor.cjs'),
        '--json', '--outputFile', output],
      { cwd: repo, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(join(results, `${arm.name}.log`), `${run.stdout || ''}\n${run.stderr || ''}`);
      assert.ifError(run.error);
      assert.equal(run.signal, null);
      assert.equal(run.status, arm.failed.length ? 1 : 0, `${arm.name}: unexpected exit`);
      const report = JSON.parse(readFileSync(output));
      assert.equal(report.numRuntimeErrorTestSuites || 0, 0);
      assert.equal(report.numTotalTestSuites, arm.files.length);
      const rows = report.testResults.flatMap(suite => {
        assert.ok(!suite.testExecError);
        assert.ok(arm.files.some(file => suite.name.endsWith(`/${file}`)));
        return suite.assertionResults;
      });
      assert.deepEqual(rows.map(row => row.fullName).sort(), [...arm.names].sort());
      assert.equal(report.numTotalTests, arm.names.length);
      assert.equal(report.numFailedTests, arm.failed.length);
      assert.equal(report.numPassedTests, arm.names.length - arm.failed.length);
      for (const row of rows) {
        const fails = arm.failed.includes(row.fullName);
        assert.equal(row.status, fails ? 'failed' : 'passed', row.fullName);
        if (!fails) continue;
        const message = row.failureMessages.join('\n');
        if (arm.from) {
          assert.ok(message.includes('Expected: 8000000n') && message.includes('Received: 9000000n'), message);
          assert.ok(message.includes('use-burn-minimum.test.ts:49:'), message);
        } else {
          assert.ok(message.includes('toBeUndefined') && /Received:\s*\{"amount": "5"\}/.test(message), message);
          assert.ok(message.includes('usdcx-config.test.ts:21:'), message);
        }
      }
      observed.push({ arm: arm.name, actual_exit: run.status, actual_passed: report.numPassedTests, actual_failed: report.numFailedTests,
        exact_expected_outcome_matched: true, production_sha256: hash(readFileSync(join(repo, production))), assertions: rows });
      console.log(`${arm.name}: expected outcome matched; actual Jest exit ${run.status}, ${report.numPassedTests} passed, ${report.numFailedTests} failed`);
    } finally {
      writeFileSync(join(repo, production), original);
      verify();
    }
  }
  completed = true;
} finally {
  writeFileSync(join(repo, production), original);
  verify();
  writeFileSync(join(results, 'summary.json'), JSON.stringify({ source_commit: request.source_commit, source_tree: request.source_tree,
    patch_sha256: request.patch_sha256, historical_checkpoint_only: true, all_expected_outcomes_matched: completed,
    source_restored: true, observed }, null, 2) + '\n');
}
