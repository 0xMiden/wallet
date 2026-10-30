import assert from 'node:assert/strict';
import test from 'node:test';

import * as topology from './staging-topology.mjs';

const runRateScenario = topology.runRateScenario ?? (() => 'missing');

function fixture({ wrongStatus = false, objectTouched = false } = {}) {
  let touched = 0;
  const service = {
    async fetch(_request, refusal) {
      if (objectTouched) touched++;
      return Response.json(
        { error: 'rate_limited' },
        {
          status: wrongStatus ? 503 : 429,
          headers: { 'Retry-After': refusal === 'caller' ? '60' : '10' }
        }
      );
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

const runNativeRateScenario = topology.runNativeRateScenario ?? (() => 'missing');

test('native rate scenario proves both real bindings refuse a bounded fifth call', async () => {
  const calls = [];
  const binding = name => ({
    limit: async ({ key }) => {
      calls.push({ name, key });
      return { success: calls.filter(call => call.name === name).length <= 4 };
    }
  });
  assert.equal(
    await runNativeRateScenario({ caller: binding('caller'), colo: binding('colo'), nonce: 'a'.repeat(32) }),
    'passed'
  );
  assert.equal(calls.length, 10);
  assert.equal(new Set(calls.map(call => call.key)).size, 2);
});

test('native rate scenario rejects missing bindings and unexpected provider behavior', async () => {
  assert.equal(await runNativeRateScenario({ caller: null, colo: null, nonce: 'a'.repeat(32) }), 'failed');
  const allows = { limit: async () => ({ success: true }) };
  assert.equal(await runNativeRateScenario({ caller: allows, colo: allows, nonce: 'a'.repeat(32) }), 'failed');
  assert.equal(await runNativeRateScenario({ caller: allows, colo: allows, nonce: 'invalid' }), 'failed');
});

test('wired rate scenario reports only the fixed failed stage', async () => {
  const failures = [];
  const result = await topology.runWiredRateScenario({
    service: { fetch: async () => new Response(null, { status: 503 }) },
    counters: async () => ({ objects: 0 }),
    onFailure: (stage, status) => failures.push([stage, status])
  });
  assert.equal(result, 'failed');
  assert.deepEqual(failures, [['caller_allow_1', 503]]);
});
