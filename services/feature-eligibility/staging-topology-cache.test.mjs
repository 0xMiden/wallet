import assert from 'node:assert/strict';
import test from 'node:test';

import { CallerEligibilityGuard, EligibilityGuard, TopologyControl } from './staging-topology-worker.mjs';
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

function namespace(DurableObject, env, requestedNames = []) {
  const instances = new Map();
  return {
    idFromName: name => {
      requestedNames.push(name);
      return name;
    },
    get: name => {
      let instance = instances.get(name);
      if (!instance) {
        instance = new DurableObject({ storage: new MemoryStorage(), id: { name } }, env);
        instances.set(name, instance);
      }
      return {
        fetch: (input, init) => instance.fetch(new Request(input, init))
      };
    }
  };
}

function controlHarness() {
  const callerNames = [];
  const env = {
    TOPOLOGY_RUN_UNTIL: String(Date.now() + 60_000),
    TOPOLOGY_RUN_MAX: '2'
  };
  env.CALLER_GUARD = namespace(CallerEligibilityGuard, env, callerNames);
  env.ELIGIBILITY_GUARD = namespace(EligibilityGuard, env);
  return { control: new TopologyControl({ storage: new MemoryStorage() }, env), env, callerNames };
}

test('a second accepted cache_reuse run records one miss', async () => {
  const { control, env, callerNames } = controlHarness();
  const budget = env.ELIGIBILITY_GUARD.get(env.ELIGIBILITY_GUARD.idFromName('global-v1'));
  const reservations = async () =>
    (await (await budget.fetch('https://topology.internal/proof-counters')).json()).reservations;
  const request = () => new Request('https://topology.internal/scenario/cache_reuse', { method: 'POST' });
  const first = await control.fetch(request());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { scenario: 'cache_reuse', status: 'passed' });
  assert.equal(await reservations(), 1);
  assert.equal(new Set(callerNames).size, 1);

  const second = await control.fetch(request());
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, 'passed');
  assert.equal(await reservations(), 2);
  assert.equal(new Set(callerNames).size, 2);
});

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
