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

test('control results expose only the fixed scenario and outcome', async () => {
  const { env } = harness();
  env.TOPOLOGY_CONTROL.get = () => ({
    fetch: async () => Response.json({ ...response, secret: 'private-marker' })
  });
  const result = await worker.fetch(request('/scenario/cache_reuse', { method: 'POST' }), env);
  assert.deepEqual(await result.json(), response);
});

test('missing, malformed, and failed control results fail closed', async () => {
  for (const control of [
    undefined,
    { idFromName: () => 'run', get: () => ({ fetch: async () => Response.json({ ...response, status: 'unknown' }) }) },
    { idFromName: () => 'run', get: () => ({ fetch: async () => new Response('private-marker', { status: 503 }) }) }
  ]) {
    const { env } = harness();
    env.TOPOLOGY_CONTROL = control;
    const result = await worker.fetch(request('/scenario/cache_reuse', { method: 'POST' }), env);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'unavailable' });
  }
});

test('an unset bearer never permits access', async () => {
  const { env, calls } = harness();
  env.TOPOLOGY_BEARER = '';
  const result = await worker.fetch(request('/scenario/cache_reuse', { method: 'POST' }), env);
  assert.equal(result.status, 403);
  assert.deepEqual(calls, []);
});

test('an empty HTTP body stream is accepted but a forged nonempty body is rejected', async () => {
  const first = harness();
  const empty = new Request('https://staging.example/scenario/cache_reuse', {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Length': '0' }, body: ''
  });
  assert.equal((await worker.fetch(empty, first.env)).status, 200);
  const second = harness();
  const forged = new Request('https://staging.example/scenario/cache_reuse', {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Length': '0' }, body: 'unexpected'
  });
  assert.equal((await worker.fetch(forged, second.env)).status, 400);
  assert.deepEqual(second.calls, []);
});
