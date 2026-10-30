import assert from 'node:assert/strict';
import test from 'node:test';

import { runColoScenario } from './staging-topology.mjs';
import { CallerEligibilityGuard, EligibilityGuard, TopologyControl } from './staging-topology-worker.mjs';

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

class MemoryStorage {
  values = new Map();
  queue = Promise.resolve();
  writes = 0;

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    this.writes += 1;
    this.values.set(key, structuredClone(value));
  }

  async delete(keys) {
    this.writes += 1;
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async list({ prefix = '', startAfter = '', limit = 128 } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
    );
  }

  async setAlarm(value) {
    this.writes += 1;
    this.alarm = value;
  }

  async getAlarm() {
    return this.alarm ?? null;
  }

  transaction(callback) {
    const result = this.queue.then(() => callback(this));
    this.queue = result.catch(() => {});
    return result;
  }
}

function namespace(Class, env) {
  const instances = new Map();
  return {
    idFromName: name => name,
    get(id) {
      let stub = instances.get(id);
      if (!stub) {
        const object = new Class({ storage: new MemoryStorage(), id: { name: id } }, env);
        stub = {
          fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init))
        };
        instances.set(id, stub);
      }
      return stub;
    }
  };
}

function admittedController() {
  const env = {
    TOPOLOGY_RUN_UNTIL: String(Date.now() + 10 * 60 * 1000),
    TOPOLOGY_RUN_MAX: '2'
  };
  env.CALLER_GUARD = namespace(CallerEligibilityGuard, env);
  env.ELIGIBILITY_GUARD = namespace(EligibilityGuard, env);
  return new TopologyControl({ storage: new MemoryStorage() }, env);
}

test('a second admitted colo isolation is another pair of cold misses', async () => {
  const control = admittedController();
  const first = await control.fetch(
    new Request('https://topology.internal/scenario/colo_isolation', { method: 'POST' })
  );
  const second = await control.fetch(
    new Request('https://topology.internal/scenario/colo_isolation', { method: 'POST' })
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'passed');
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, 'passed');
});
