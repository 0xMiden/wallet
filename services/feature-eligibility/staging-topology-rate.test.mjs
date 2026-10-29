import assert from 'node:assert/strict';
import test from 'node:test';

import * as topology from './staging-topology.mjs';

const runRateScenario = topology.runRateScenario ?? (() => 'missing');

function fixture({ wrongStatus = false, objectTouched = false } = {}) {
  let touched = 0;
  const service = {
    async fetch(_request, refusal) {
      if (objectTouched) touched++;
      return Response.json({ error: 'rate_limited' }, {
        status: wrongStatus ? 503 : 429,
        headers: { 'Retry-After': refusal === 'caller' ? '60' : '10' }
      });
    }
  };
  return { service, counters: async () => ({ objects: touched }) };
}

test('rate scenario checks both refusals before object access', async () => {
  assert.equal(await runRateScenario(fixture()), 'passed');
});

test('rate scenario rejects wrong refusal status', async () => {
  assert.equal(await runRateScenario(fixture({ wrongStatus: true })), 'failed');
});

test('rate scenario rejects object access before refusal', async () => {
  assert.equal(await runRateScenario(fixture({ objectTouched: true })), 'failed');
});
