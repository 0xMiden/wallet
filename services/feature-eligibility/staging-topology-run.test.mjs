import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunController } from './staging-topology.mjs';

function storage() {
  const values = new Map();
  let pending = Promise.resolve();
  return {
    transaction(fn) {
      const work = pending.then(() => fn({
        get: async key => values.get(key),
        put: async (key, value) => values.set(key, value)
      }));
      pending = work.catch(() => {});
      return work;
    }
  };
}

function input() {
  return new Request('https://topology.internal/scenario/cache_reuse', { method: 'POST' });
}

test('the persisted run budget limits repeated requests across controller instances', async () => {
  const store = storage();
  let calls = 0;
  const options = { storage: store, now: () => 100, expiresAt: 1000, maxRuns: 2, runScenario: async () => { calls++; return 'passed'; } };
  const first = createRunController(options);
  const restarted = createRunController(options);
  assert.equal((await first(input())).status, 200);
  assert.equal((await restarted(input())).status, 200);
  assert.equal((await restarted(input())).status, 429);
  assert.equal(calls, 2);
});

test('expiry refuses the scenario without invoking it', async () => {
  let calls = 0;
  const handle = createRunController({ storage: storage(), now: () => 1000, expiresAt: 1000, maxRuns: 2, runScenario: async () => { calls++; return 'passed'; } });
  assert.equal((await handle(input())).status, 503);
  assert.equal(calls, 0);
});

test('an overlapping request is refused while a scenario is active', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = () => resolve(true); });
  const held = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const handle = createRunController({ storage: storage(), now: () => 100, expiresAt: 1000, maxRuns: 2, runScenario: async () => { calls++; entered(); await held; return 'passed'; } });
  const first = handle(input());
  assert.equal(await Promise.race([started, new Promise(resolve => setTimeout(() => resolve(false), 1000))]), true);
  assert.equal((await handle(input())).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test('a failing scenario still consumes budget and permits the next bounded attempt', async () => {
  let calls = 0;
  const handle = createRunController({ storage: storage(), now: () => 100, expiresAt: 1000, maxRuns: 2, runScenario: async () => { calls++; if (calls === 1) throw new Error('private'); return 'passed'; } });
  assert.equal((await handle(input())).status, 503);
  assert.equal((await handle(input())).status, 200);
  assert.equal((await handle(input())).status, 429);
  assert.equal(calls, 2);
});

test('invalid run configuration fails closed without a scenario call', async () => {
  for (const options of [
    { expiresAt: 900101, maxRuns: 2 },
    { expiresAt: 1000, maxRuns: 21 },
    { expiresAt: 1000, maxRuns: 0 },
    { expiresAt: 1000, maxRuns: 1.5 }
  ]) {
    let calls = 0;
    const handle = createRunController({ storage: storage(), now: () => 100, ...options, runScenario: async () => { calls++; return 'passed'; } });
    assert.equal((await handle(input())).status, 503);
    assert.equal(calls, 0);
  }
});

test('a restarted controller cannot increase the run budget or extend its lifetime', async () => {
  for (const changed of [{ expiresAt: 1000, maxRuns: 2 }, { expiresAt: 2000, maxRuns: 1 }]) {
    const store = storage();
    let calls = 0;
    const base = { storage: store, now: () => 100, expiresAt: 1000, maxRuns: 1, runScenario: async () => { calls++; return 'passed'; } };
    assert.equal((await createRunController(base)(input())).status, 200);
    assert.equal((await createRunController({ ...base, ...changed })(input())).status, 503);
    assert.equal(calls, 1);
  }
});
