import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './staging-topology.mjs';

const bearer = 'test-only-secret';
const response = { scenario: 'cache_reuse', status: 'passed' };

function harness() {
  const calls = [];
  return {
    calls,
    env: {
      TOPOLOGY_BEARER: bearer,
      TOPOLOGY_CONTROL: {
        idFromName(name) {
          calls.push(['id', name]);
          return name;
        },
        get(id) {
          calls.push(['get', id]);
          return {
            async fetch(request) {
              calls.push(['fetch', request.method, new URL(request.url).pathname]);
              return Response.json(response);
            }
          };
        }
      }
    }
  };
}

function request(path, { method = 'GET', authorized = true, body } = {}) {
  return new Request(`https://staging.example${path}`, {
    method,
    headers: authorized ? { Authorization: `Bearer ${bearer}` } : {},
    ...(body === undefined ? {} : { body })
  });
}

test('a fixed authenticated cache scenario returns its closed result', async () => {
  const { env, calls } = harness();
  const result = await worker.fetch(request('/scenario/cache_reuse', { method: 'POST' }), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await result.json(), response);
  assert.equal(calls.filter(([kind]) => kind === 'fetch').length, 1);
});

test('unauthenticated requests never reach the control object', async () => {
  const { env, calls } = harness();
  const result = await worker.fetch(request('/scenario/cache_reuse', { method: 'POST', authorized: false }), env);
  assert.equal(result.status, 403);
  assert.deepEqual(calls, []);
});

test('unknown scenarios and caller-supplied inputs are refused before control access', async () => {
  for (const [path, options] of [
    ['/scenario/unknown', { method: 'POST' }],
    ['/scenario/cache_reuse?url=https://example.invalid', { method: 'POST' }],
    ['/scenario/cache_reuse', { method: 'GET' }],
    ['/scenario/cache_reuse', { method: 'POST', body: 'caller-supplied-data' }]
  ]) {
    const { env, calls } = harness();
    const result = await worker.fetch(request(path, options), env);
    assert.equal(result.status, 400);
    assert.deepEqual(calls, []);
  }
});
