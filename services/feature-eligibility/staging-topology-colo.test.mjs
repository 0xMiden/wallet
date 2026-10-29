import assert from 'node:assert/strict';
import test from 'node:test';

import { runColoScenario } from './staging-topology.mjs';

function harness({ sharedCache = false } = {}) {
  const counts = { IAD: 0, FRA: 0, reservations: 0 };
  const cached = new Set();
  return {
    counts,
    counters: async () => ({ ...counts }),
    service: {
      async fetch(request) {
        assert.equal(request.headers.get('CF-Connecting-IP'), '192.0.2.2');
        const colo = request.cf.colo;
        const key = sharedCache ? 'shared' : colo;
        if (!cached.has(key)) {
          cached.add(key);
          counts[colo]++;
          counts.reservations++;
        }
        return Response.json({ network: 'testnet', version: 13, allowed: { wallet: true, earn: true, swap: true } });
      }
    }
  };
}

test('colo scenario requires independent misses in two fixed colos', async () => {
  const fixture = harness();
  assert.equal(await runColoScenario(fixture), 'passed');
  assert.deepEqual(fixture.counts, { IAD: 1, FRA: 1, reservations: 2 });
});

test('colo scenario refuses a cache shared across colos', async () => {
  const fixture = harness({ sharedCache: true });
  assert.equal(await runColoScenario(fixture), 'failed');
  assert.equal(fixture.counts.IAD, 1);
  assert.equal(fixture.counts.FRA, 0);
});
