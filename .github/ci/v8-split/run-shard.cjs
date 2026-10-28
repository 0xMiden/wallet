// CI-only. The workflow verifies and stages the pinned addon before invoking this file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const [planPath, id, proofArg] = process.argv.slice(2);
if (!planPath || !id || !proofArg) throw new Error('usage: run-shard.cjs PLAN ID PROOF_DIR');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const targets = [...plan.general.map(x => ({ ...x, kind: 'general' })), ...plan.partitions.map(x => ({ ...x, kind: 'partition' }))];
const matches = targets.filter(x => x.id === id);
if (matches.length !== 1) throw new Error('Unknown or duplicate target');
const target = matches[0];
const proof = path.resolve(proofArg);
const addon = JSON.parse(fs.readFileSync(path.join(proof, 'addon-binding.json'), 'utf8'));
const binary = path.resolve('node_modules/@miden-sdk/node-linux-x64-gnu/miden_client_web.node');
const binaryHash = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
if (addon.source !== plan.source || addon.sdk !== plan.sdk || addon.sha256 !== plan.addon.sha256 || binaryHash !== addon.sha256) throw new Error('Wrong staged addon');
const files = target.kind === 'general' ? target.files : [target.file];
if (!files.length) throw new Error('No selected files');
const argv = ['--coverage', '--runTestsByPath', ...files, '--maxWorkers=2', '--workerIdleMemoryLimit=768MB', '--coverageReporters=json', '--coverageReporters=text-summary', '--json', '--outputFile=coverage/jest-results.json'];
if (target.kind === 'partition') argv.push('--testNamePattern', target.pattern);
fs.writeFileSync(path.join(proof, 'coverage-root.json'), `${JSON.stringify({ root: fs.realpathSync(process.cwd()) })}\n`);
fs.writeFileSync(path.join(proof, 'shard-command.json'), `${JSON.stringify({ id, argv })}\n`);
const log = fs.openSync(path.join(proof, 'coverage.log'), 'w');
try {
  const result = spawnSync(path.resolve('node_modules/.bin/jest'), argv, { cwd: process.cwd(), stdio: ['ignore', log, log], timeout: 80 * 60 * 1000, env: { ...process.env, JEST_COVERAGE_SHARD: '1' } });
  if (result.error || result.status !== 0) throw new Error(`Jest shard failed: ${result.error?.message ?? result.status}`);
} finally { fs.closeSync(log); }
const result = JSON.parse(fs.readFileSync('coverage/jest-results.json', 'utf8'));
if (!result.success || result.numPassedTests < 1 || result.numFailedTests || result.numFailedTestSuites || result.numRuntimeErrorTestSuites) throw new Error('Jest shard failed or selected no passing tests');
if (!fs.statSync('coverage/coverage-final.json').size) throw new Error('Missing coverage map');
