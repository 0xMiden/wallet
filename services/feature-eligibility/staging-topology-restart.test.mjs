import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology.mjs';

const runRestartScenario = topology.runRestartScenario ?? (() => 'missing');

function fixture({ losesLease = false, acceptsOldDay = false, failsReset = false } = {}) {
  const values = {
    reserve: { granted: 4, count: 4 },
    restart: { count: losesLease ? 0 : 4 },
    replay: { granted: 4, count: losesLease ? 8 : 4 },
    advance: { advanced: true },
    oldDay: { reserved: acceptsOldDay },
    newDay: { granted: 4, count: failsReset ? 8 : 4 }
  };
  const steps = [];
  return {
    probe: {
      step: async name => {
        steps.push(name);
        return values[name];
      }
    },
    steps
  };
}

test('restart scenario preserves a lease and resets the next day', async () => {
  const candidate = fixture();
  assert.equal(await runRestartScenario(candidate), 'passed');
  assert.deepEqual(candidate.steps, ['reserve', 'restart', 'replay', 'advance', 'oldDay', 'newDay']);
});

test('restart scenario detects lost lease state', async () => {
  assert.equal(await runRestartScenario(fixture({ losesLease: true })), 'failed');
});

test('restart scenario rejects old-day reservations', async () => {
  assert.equal(await runRestartScenario(fixture({ acceptsOldDay: true })), 'failed');
});

test('restart scenario detects a failed day reset', async () => {
  assert.equal(await runRestartScenario(fixture({ failsReset: true })), 'failed');
});
