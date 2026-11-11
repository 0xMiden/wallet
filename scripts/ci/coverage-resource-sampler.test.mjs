import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SAMPLE_INTERVAL_MS, sampleResources, startResourceSampler } from './coverage-resource-sampler.mjs';

const SAMPLER_SCRIPT = fileURLToPath(new URL('./coverage-resource-sampler.mjs', import.meta.url));

function waitForSampleAndIdle(child, workspace) {
  let stdout = '';
  let stderr = '';

  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer;
    const deadline = setTimeout(() => {
      finish(new Error(`sampler did not reach an idle sample within 25s\n${stdout}\n${stderr}`));
    }, 25_000);

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!stdout.includes(`df -h ${workspace} exit=`)) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), 300);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      finish(new Error(`sampler exited before SIGTERM: code=${code} signal=${signal}\n${stdout}\n${stderr}`));
    });
  });
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sampler did not close within ${timeoutMs}ms`)), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopSamplerProcess({ args, cwd, env, workspace }) {
  const child = spawn(process.execPath, [SAMPLER_SCRIPT, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const output = await waitForSampleAndIdle(child, workspace);
    assert.equal(child.exitCode, null);
    const closed = waitForClose(child, 5_000);
    assert.equal(child.kill('SIGTERM'), true);
    const exit = await closed;
    assert.equal(exit.code, 0);
    return output;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

test('samples memory and workspace disk with a shard and UTC timestamp', () => {
  const commands = [];
  const logs = [];

  sampleResources({
    shard: '2',
    workspace: '/runner/work/wallet',
    now: () => new Date('2026-11-01T16:00:00.000Z'),
    run: (command, args) => {
      commands.push([command, ...args]);
      return {
        status: 0,
        stdout: command === 'free' ? 'Mem: 1000 300 700\n' : 'Filesystem Size Used Avail Use% Mounted on\n',
        stderr: ''
      };
    },
    output: { write: chunk => logs.push(chunk) }
  });

  assert.deepEqual(commands, [
    ['free', '-m'],
    ['df', '-h', '/runner/work/wallet']
  ]);
  assert.match(logs.join(''), /coverage-resource-sample shard=2 timestamp=2026-11-01T16:00:00\.000Z/);
  assert.match(logs.join(''), /Mem: 1000 300 700/);
  assert.match(logs.join(''), /Filesystem Size Used Avail/);
});

test('non-zero status and stderr are logged without throwing', () => {
  const logs = [];

  assert.doesNotThrow(() => {
    sampleResources({
      shard: '1',
      workspace: '/runner/work/wallet',
      now: () => new Date('2026-11-01T16:00:00.000Z'),
      run: () => ({ status: 127, stdout: '', stderr: 'not found' }),
      output: { write: chunk => logs.push(chunk) }
    });
  });

  assert.match(logs.join(''), /free -m exit=127/);
  assert.match(logs.join(''), /df -h \/runner\/work\/wallet exit=127/);
  assert.match(logs.join(''), /not found/);
});

test('a thrown free runner is logged and sampling continues to df', () => {
  const commands = [];
  const logs = [];
  let thrown;

  try {
    sampleResources({
      shard: '1',
      workspace: '/runner/work/wallet',
      now: () => new Date('2026-11-01T16:00:00.000Z'),
      run: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'free') throw new Error('free exploded');
        return { status: 0, stdout: 'disk-ok\n', stderr: '' };
      },
      output: { write: chunk => logs.push(chunk) }
    });
  } catch (error) {
    thrown = error;
  }

  assert.deepEqual(commands, [
    ['free', '-m'],
    ['df', '-h', '/runner/work/wallet']
  ]);
  assert.equal(thrown, undefined);
  const output = logs.join('');
  const failureIndex = output.indexOf('free -m failed: free exploded');
  const diskIndex = output.indexOf('disk-ok');
  assert.ok(failureIndex >= 0);
  assert.ok(diskIndex > failureIndex);
  assert.doesNotMatch(output, /free -m exit=/);
});

test('a returned command error is logged when stderr is empty', () => {
  const commands = [];
  const logs = [];

  assert.doesNotThrow(() => {
    sampleResources({
      shard: '1',
      workspace: '/runner/work/wallet',
      now: () => new Date('2026-11-01T16:00:00.000Z'),
      run: (command, args) => {
        commands.push([command, ...args]);
        if (command === 'free') {
          return { status: null, stdout: '', stderr: '', error: new Error('spawn EACCES') };
        }
        return { status: 0, stdout: 'disk-ok\n', stderr: '' };
      },
      output: { write: chunk => logs.push(chunk) }
    });
  });

  assert.deepEqual(commands, [
    ['free', '-m'],
    ['df', '-h', '/runner/work/wallet']
  ]);
  const output = logs.join('');
  const exitIndex = output.indexOf('free -m exit=unknown');
  const errorIndex = output.indexOf('free error: spawn EACCES');
  const diskIndex = output.indexOf('disk-ok');
  assert.ok(exitIndex >= 0);
  assert.ok(errorIndex >= 0);
  assert.ok(errorIndex > exitIndex);
  assert.ok(diskIndex > errorIndex);
});

test('the CLI prefers argv and GITHUB_WORKSPACE and exits 0 on SIGTERM', { timeout: 35_000 }, async () => {
  const tempDirs = [];

  try {
    const workspace = await mkdtemp(join(tmpdir(), 'coverage-sampler-workspace-'));
    tempDirs.push(workspace);
    const cwd = await mkdtemp(join(tmpdir(), 'coverage-sampler-cwd-'));
    tempDirs.push(cwd);
    const { stdout } = await stopSamplerProcess({
      args: ['4'],
      cwd,
      env: { PATH: process.env.PATH, SHARD: '9', GITHUB_WORKSPACE: workspace },
      workspace
    });

    assert.match(stdout, /coverage-resource-sample shard=4 timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    assert.ok(stdout.includes(`df -h ${workspace} exit=`));
    assert.match(stdout, /free -m (?:exit=|failed:)/);
  } finally {
    await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true })));
  }
});

test('the CLI defaults the shard to unknown and df to cwd', { timeout: 35_000 }, async () => {
  const tempDirs = [];

  try {
    const cwd = await mkdtemp(join(tmpdir(), 'coverage-sampler-cwd-'));
    tempDirs.push(cwd);
    const env = { PATH: process.env.PATH };
    const { stdout } = await stopSamplerProcess({ args: [], cwd, env, workspace: cwd });

    assert.match(stdout, /coverage-resource-sample shard=unknown timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    assert.ok(stdout.includes(`df -h ${cwd} exit=`));
  } finally {
    await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true })));
  }
});

test('the coverage step launches and stops the sampler before running coverage', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/pr.yml', import.meta.url)), 'utf8');
  const launch = 'node scripts/ci/coverage-resource-sampler.mjs "$SHARD" &';

  assert.equal(workflow.split(launch).length - 1, 1);
  const coverageStep = workflow.split('\n      - name: ').find(step => step.startsWith('Run Coverage shard\n'));
  assert.ok(coverageStep);
  const runBlock = coverageStep.match(/\n        run: \|\n((?:          [^\n]*(?:\n|$))+)/);
  assert.ok(runBlock);
  const run = runBlock[1]
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => line.slice(10))
    .join('\n');

  assert.equal(run, [
    'set -euo pipefail',
    'node scripts/ci/coverage-resource-sampler.mjs "$SHARD" &',
    'SAMPLER_PID=$!',
    'stop_sampler() {',
    '  kill "$SAMPLER_PID" 2>/dev/null || true',
    '  wait "$SAMPLER_PID" 2>/dev/null || true',
    '  return 0',
    '}',
    'trap stop_sampler EXIT',
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'yarn test:coverage --shard="$SHARD/$SHARDS" --coverageReporters=json --coverageReporters=text-summary --json --outputFile=coverage/jest-results.json'
  ].join('\n'));
});

test('starts with an immediate sample and a stoppable 30-second interval', () => {
  let samples = 0;
  let scheduled;
  let delay;
  let cleared;
  const handle = { id: 'sampler' };

  const stop = startResourceSampler({
    shard: '3',
    workspace: '/runner/work/wallet',
    sample: () => samples++,
    setIntervalFn: (callback, intervalMs) => {
      scheduled = callback;
      delay = intervalMs;
      return handle;
    },
    clearIntervalFn: intervalHandle => {
      cleared = intervalHandle;
    }
  });

  assert.equal(DEFAULT_SAMPLE_INTERVAL_MS, 30_000);
  assert.equal(samples, 1);
  assert.equal(delay, 30_000);
  scheduled();
  assert.equal(samples, 2);
  stop();
  assert.equal(cleared, handle);
});
