import assert from 'node:assert/strict';
import test from 'node:test';

import { runCacheScenario } from './staging-topology.mjs';
import { CallerEligibilityGuard, EligibilityGuard, TopologyControl } from './staging-topology-worker.mjs';

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

test('a second admitted cache reuse is another cold miss', async () => {
  const control = admittedController();
  const first = await control.fetch(new Request('https://topology.internal/scenario/cache_reuse', { method: 'POST' }));
  const second = await control.fetch(new Request('https://topology.internal/scenario/cache_reuse', { method: 'POST' }));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'passed');
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, 'passed');
});
