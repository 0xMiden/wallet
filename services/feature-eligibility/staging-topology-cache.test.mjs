import assert from 'node:assert/strict';
import test from 'node:test';

import { runCacheScenario } from './staging-topology.mjs';

function harness({ cacheWorks = true, writesOnHit = false, status = 200 } = {}) {
  let lookups = 0;
  let writes = 0;
  let reservations = 0;
  let cached = false;
  const calls = [];
  const service = {
    async fetch(request) {
      calls.push(request);
      if (!cached || !cacheWorks) {
        lookups++;
        writes++;
        reservations++;
        cached = true;
      } else if (writesOnHit) writes++;
      return Response.json({ network: 'testnet', version: 13, allowed: { wallet: true, earn: true, swap: true } }, { status });
    }
  };
  return { service, calls, counters: async () => ({ lookups, writes, reservations }) };
}

test('cache scenario proves one miss followed by an unchanged hit', async () => {
  const fixture = harness();
  assert.equal(await runCacheScenario(fixture), 'passed');
  assert.equal(fixture.calls.length, 2);
  for (const request of fixture.calls) {
    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url).search, '?network=testnet');
    assert.equal(request.cf.colo, 'TST');
    assert.equal(request.headers.get('CF-Connecting-IP'), '192.0.2.1');
  }
});

test('cache scenario fails if the second request performs a lookup or writes', async () => {
  for (const options of [{ cacheWorks: false }, { writesOnHit: true }]) {
    const fixture = harness(options);
    assert.equal(await runCacheScenario(fixture), 'failed');
    assert.equal(fixture.calls.length, 2);
  }
});

test('cache scenario fails when a service request does not succeed', async () => {
  const fixture = harness({ status: 503 });
  assert.equal(await runCacheScenario(fixture), 'failed');
  assert.ok(fixture.calls.length > 0);
});
