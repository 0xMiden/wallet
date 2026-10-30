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

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(keys) {
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

function namespace(DurableObject, env) {
  const instances = new Map();
  return {
    idFromName: name => name,
    get: name => {
      let instance = instances.get(name);
      if (!instance) {
        instance = new DurableObject({ storage: new MemoryStorage(), id: { name } }, env);
        instances.set(name, instance);
      }
      return { fetch: (input, init) => instance.fetch(new Request(input, init)) };
    }
  };
}

function controlHarness() {
  const env = {
    TOPOLOGY_RUN_UNTIL: String(Date.now() + 60_000),
    TOPOLOGY_RUN_MAX: '2'
  };
  env.CALLER_GUARD = namespace(CallerEligibilityGuard, env);
  env.ELIGIBILITY_GUARD = namespace(EligibilityGuard, env);
  return { control: new TopologyControl({ storage: new MemoryStorage() }, env), env };
}

test('a second accepted colo_isolation run records one miss per colo', async () => {
  const { control, env } = controlHarness();
  const budget = env.ELIGIBILITY_GUARD.get(env.ELIGIBILITY_GUARD.idFromName('global-v1'));
  const reservations = async () =>
    (await (await budget.fetch('https://topology.internal/proof-counters')).json()).reservations;
  const request = () => new Request('https://topology.internal/scenario/colo_isolation', { method: 'POST' });

  const first = await control.fetch(request());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { scenario: 'colo_isolation', status: 'passed' });
  assert.equal(await reservations(), 2);

  const second = await control.fetch(request());
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { scenario: 'colo_isolation', status: 'passed' });
  assert.equal(await reservations(), 4);
});
