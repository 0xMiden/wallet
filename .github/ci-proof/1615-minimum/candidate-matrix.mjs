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
const request = JSON.parse(readFileSync(join(bundle, 'candidate-request.json')));
const hash = data => createHash('sha256').update(data).digest('hex');
const results = join(bundle, 'candidate-results');
mkdirSync(results, { recursive: true });
const fixture = 'playwright/e2e/helpers/usdcx-config.test.ts';
const constants = 'playwright/e2e/helpers/usdcx-constants.ts';
const original = readFileSync(join(repo, constants));
const expectedFiles = { ...request.protected_files, ...request.candidate_files };
const identity = {
  transport_commit: process.env.GITHUB_SHA,
  source_commit: request.source_commit,
  source_tree: request.source_tree,
  candidate_tree: request.candidate_tree,
  patch_sha256: request.patch_sha256,
  candidate_manifest_sha256: request.candidate_manifest_sha256,
  request_sha256: hash(readFileSync(join(bundle, 'candidate-request.json')))
};
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
function verify() {
  const hashes = {};
  for (const [name, expected] of Object.entries(expectedFiles)) {
    hashes[name] = hash(readFileSync(join(repo, name)));
    assert.equal(hashes[name], expected, name);
  }
  assert.equal(git('rev-parse', 'HEAD'), request.source_commit);
  assert.equal(git('write-tree'), request.candidate_tree);
  git('diff', '--exit-code');
  return hashes;
}
const consumerNames = ['Arc Testnet', 'Base Sepolia', 'Arbitrum Sepolia', 'Sepolia'].map(
  name => `allows the live burn amount through the wallet minimum check on ${name}`
);
const fixtureNames = [
  'keeps the E2E burn protocol values equal to the wallet values',
  ...consumerNames,
  'keeps the E2E payout floor equal to the configured wallet payout floor',
  ...[84532, 421614, 11155111].map(
    id => `reads the executor route of chain ${id} from the fixture as the wallet reads it`
  ),
  'lists Base Sepolia, Arbitrum Sepolia, then Ethereum Sepolia, each read where usdcx-burn-l2 reads it'
];
const arms = [
  { name: 'candidate-normal', files: request.focused_files, failed: [] },
  {
    name: 'shared-default-1-with-sepolia-5',
    files: [fixture],
    failed: consumerNames.slice(0, 3),
    sharedDefault: true,
    sepolia: '5_000_000n'
  },
  { name: 'sepolia-2-with-default-5', files: [fixture], failed: [consumerNames[3]], sepolia: '2_000_000n' },
  { name: 'candidate-restored-positive-control', files: request.focused_files, failed: [] }
];
const observed = [];
let completed = false;
try {
  for (const arm of arms) {
    const armDir = join(results, arm.name);
    mkdirSync(armDir, { recursive: true });
    const before = verify();
    const record = { ...identity, arm: arm.name, before, restoration_verified: false };
    writeFileSync(join(armDir, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
    try {
      let text = original.toString();
      if (arm.sharedDefault) {
        const from = 'export const BURN_UNITS = USDCX_MIN_BURN;';
        assert.equal(text.split(from).length - 1, 1);
        text = text.replace(from, 'export const BURN_UNITS = 1_000_000n;');
      }
      if (arm.sepolia) {
        const from = 'export const ETHEREUM_SEPOLIA_PAYOUT: PayoutChain = payoutChainFor(11155111, {\n';
        assert.equal(text.split(from).length - 1, 1);
        text = text.replace(from, `${from}  burnUnits: ${arm.sepolia},\n`);
      }
      writeFileSync(join(repo, constants), text);
      record.mutated_constants_sha256 = hash(readFileSync(join(repo, constants)));
      record.mutated = Object.fromEntries(
        Object.keys(expectedFiles).map(name => [name, hash(readFileSync(join(repo, name)))])
      );
      writeFileSync(join(armDir, 'mutation.patch'), git('diff', '--', constants) + '\n');
      for (const [name, expected] of Object.entries(expectedFiles)) {
        if (name !== constants) assert.equal(hash(readFileSync(join(repo, name))), expected, name);
      }
      const output = join(armDir, 'jest.json');
      const run = spawnSync(
        process.execPath,
        [
          join(repo, 'node_modules/jest/bin/jest.js'),
          '--runTestsByPath',
          ...arm.files,
          '--maxWorkers=2',
          '--coverage=false',
          '--watch=false',
          '--testResultsProcessor',
          join(bundle, 'results-processor.cjs'),
          '--json',
          '--outputFile',
          output
        ],
        {
          cwd: repo,
          env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
          encoding: 'utf8',
          timeout: 180000,
          maxBuffer: 32 * 1024 * 1024
        }
      );
      writeFileSync(join(armDir, 'jest.log'), `${run.stdout || ''}\n${run.stderr || ''}`);
      Object.assign(record, { actual_exit: run.status, signal: run.signal, process_error: run.error?.message || null });
      assert.ifError(run.error);
      assert.equal(run.signal, null);
      assert.equal(run.status, arm.failed.length ? 1 : 0, `${arm.name}: unexpected exit`);
      const report = JSON.parse(readFileSync(output));
      assert.equal(report.numRuntimeErrorTestSuites || 0, 0);
      assert.equal(report.numTotalTestSuites, arm.files.length);
      assert.equal(report.numPendingTestSuites || 0, 0);
      assert.equal(report.numPendingTests || 0, 0);
      assert.equal(report.numTodoTests || 0, 0);
      assert.deepEqual(
        report.testResults.map(suite => suite.name.slice(repo.length + 1)).sort(),
        [...arm.files].sort()
      );
      const rows = report.testResults.flatMap(suite => {
        assert.ok(!suite.testExecError);
        return suite.assertionResults;
      });
      assert.ok(rows.length > 0);
      assert.equal(report.numTotalTests, rows.length);
      assert.equal(report.numFailedTests, arm.failed.length);
      assert.equal(report.numPassedTests, rows.length - arm.failed.length);
      const configRows = report.testResults.find(suite => suite.name.endsWith(`/${fixture}`)).assertionResults;
      assert.deepEqual(configRows.map(row => row.fullName).sort(), [...fixtureNames].sort());
      if (arm.sepolia) assert.equal(rows.length, 10);
      for (const row of rows) {
        const fails = arm.failed.includes(row.fullName);
        assert.equal(row.status, fails ? 'failed' : 'passed', row.fullName);
        if (!fails) continue;
        const message = row.failureMessages.join('\n');
        assert.ok(message.includes('toBeUndefined') && /Received:\s*\{"amount": "5"\}/.test(message), message);
        assert.ok(message.includes('usdcx-config.test.ts:21:'), message);
      }
      Object.assign(record, {
        actual_suites: report.numTotalTestSuites,
        actual_total: report.numTotalTests,
        actual_passed: report.numPassedTests,
        actual_failed: report.numFailedTests,
        runtime_error_suites: report.numRuntimeErrorTestSuites || 0,
        exact_expected_outcome_matched: true,
        assertions: rows
      });
      console.log(
        `${arm.name}: expected outcome matched; actual Jest exit ${run.status}, ${report.numPassedTests} passed, ${report.numFailedTests} failed`
      );
    } finally {
      writeFileSync(join(repo, constants), original);
      record.restored = verify();
      record.restoration_verified = true;
      writeFileSync(join(armDir, 'evidence.json'), JSON.stringify(record, null, 2) + '\n');
      observed.push(record);
    }
  }
  completed = true;
} finally {
  writeFileSync(join(repo, constants), original);
  const restored = verify();
  writeFileSync(
    join(results, 'summary.json'),
    JSON.stringify(
      {
        ...identity,
        corrected_candidate_checkpoint_only: true,
        final_pr_head_approval: false,
        all_expected_outcomes_matched: completed,
        source_restored: true,
        restored,
        observed
      },
      null,
      2
    ) + '\n'
  );
}
