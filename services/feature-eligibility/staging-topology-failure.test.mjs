import assert from 'node:assert/strict';
import test from 'node:test';
import * as topology from './staging-topology.mjs';

const runFailureScenario = topology.runFailureScenario ?? (() => 'missing');

function fixture({ retryOverload = false, skipRetry = false } = {}) {
  let attempts = 0;
  return {
    counters: async () => ({ attempts }),
    service: {
      async fetch(_request, mode) {
        attempts += mode === 'overload' ? (retryOverload ? 2 : 1) : skipRetry ? 1 : 2;
        return mode === 'overload'
          ? Response.json({ error: 'overloaded' }, { status: 503, headers: { 'Retry-After': '30' } })
          : Response.json({ ready: true });
      }
    }
  };
}

test('failure scenario distinguishes overload from a retryable failure', async () => {
  assert.equal(await runFailureScenario(fixture()), 'passed');
});

test('failure scenario rejects retrying overload', async () => {
  assert.equal(await runFailureScenario(fixture({ retryOverload: true })), 'failed');
});

test('failure scenario rejects skipping the bounded retry', async () => {
  assert.equal(await runFailureScenario(fixture({ skipRetry: true })), 'failed');
});
