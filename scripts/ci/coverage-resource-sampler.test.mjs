import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SAMPLE_INTERVAL_MS,
  sampleResources,
  startResourceSampler,
} from './coverage-resource-sampler.mjs';

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
        stderr: '',
      };
    },
    output: { write: (chunk) => logs.push(chunk) },
  });

  assert.deepEqual(commands, [
    ['free', '-m'],
    ['df', '-h', '/runner/work/wallet'],
  ]);
  assert.match(logs.join(''), /coverage-resource-sample shard=2 timestamp=2026-11-01T16:00:00\.000Z/);
  assert.match(logs.join(''), /Mem: 1000 300 700/);
  assert.match(logs.join(''), /Filesystem Size Used Avail/);
});

test('resource command failures are logged without throwing', () => {
  const logs = [];

  assert.doesNotThrow(() => {
    sampleResources({
      shard: '1',
      workspace: '/runner/work/wallet',
      now: () => new Date('2026-11-01T16:00:00.000Z'),
      run: () => ({ status: 127, stdout: '', stderr: 'not found', error: new Error('not found') }),
      output: { write: (chunk) => logs.push(chunk) },
    });
  });

  assert.match(logs.join(''), /free -m/);
  assert.match(logs.join(''), /df -h/);
  assert.match(logs.join(''), /not found/);
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
    clearIntervalFn: (intervalHandle) => {
      cleared = intervalHandle;
    },
  });

  assert.equal(DEFAULT_SAMPLE_INTERVAL_MS, 30_000);
  assert.equal(samples, 1);
  assert.equal(delay, 30_000);
  scheduled();
  assert.equal(samples, 2);
  stop();
  assert.equal(cleared, handle);
});
