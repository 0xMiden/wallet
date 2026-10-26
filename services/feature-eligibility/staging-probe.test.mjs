import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';

import worker from './staging-probe.mjs';

const bearer = 'test-only-bearer';
const hashSecret = 'test-only-synthetic-key-secret';
const originalFetch = globalThis.fetch;
let outgoingCalls;

beforeEach(() => {
  outgoingCalls = 0;
  globalThis.fetch = () => {
    outgoingCalls += 1;
    throw new Error('Outgoing calls are forbidden');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  assert.equal(outgoingCalls, 0);
});

function harness({ caller = { success: true }, colo = { success: true }, overrides = {} } = {}) {
  const calls = [];
  const binding = (name, result) => ({
    async limit(input) {
      calls.push({ name, input });
      if (result instanceof Error) throw result;
      return result;
    }
  });
  return {
    calls,
    env: {
      PROBE_BEARER: bearer,
      PROBE_HASH_SECRET: hashSecret,
      PROBE_OWNER: 'private-owner-marker',
      PROBE_SOURCE: 'private-source-marker',
      PROBE_CONFIG_SHA: 'private-config-marker',
      CALLER_PROBE: binding('caller', caller),
      COLO_PROBE: binding('colo', colo),
      ...overrides
    }
  };
}

function request(path, init = {}) {
  return new Request(`https://probe.example${path}`, { headers: { Authorization: `Bearer ${bearer}` }, ...init });
}

async function expectResponse(response, status, body) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Type'), /^application\/json\b/);
  assert.deepEqual(await response.json(), body);
}

for (const route of ['caller', 'colo']) {
  test(`${route} refusal returns 429 and invokes only its selected binding once`, async () => {
    const { env, calls } = harness({ [route]: { success: false } });
    await expectResponse(await worker.fetch(request(`/probe/${route}`), env), 429, { result: 'limited' });
    assert.deepEqual(calls, [
      { name: route, input: { key: createHmac('sha256', hashSecret).update(`probe:${route}`).digest('hex') } }
    ]);
  });

  test(`${route} allowance comes from its binding on every request with a fixed synthetic key`, async () => {
    const { env, calls } = harness();
    for (let index = 0; index < 6; index += 1) {
      await expectResponse(await worker.fetch(request(`/probe/${route}`), env), 200, { result: 'stub_allowed' });
    }
    assert.equal(calls.length, 6);
    for (const call of calls) {
      assert.deepEqual(call, {
        name: route,
        input: { key: createHmac('sha256', hashSecret).update(`probe:${route}`).digest('hex') }
      });
    }
  });
}

test('synthetic keys differ by route and ephemeral secret without reading caller metadata', async () => {
  const { env, calls } = harness();
  for (const route of ['caller', 'colo']) {
    const input = request(`/probe/${route}`, {
      headers: { Authorization: `Bearer ${bearer}`, Origin: 'https://ignored.example' }
    });
    Object.defineProperty(input, 'cf', {
      get() {
        throw new Error('No edge metadata reads');
      }
    });
    const getHeader = input.headers.get.bind(input.headers);
    input.headers.get = name => {
      assert.equal(name.toLowerCase(), 'authorization');
      return getHeader(name);
    };
    await expectResponse(await worker.fetch(input, env), 200, { result: 'stub_allowed' });
  }
  await worker.fetch(request('/probe/caller'), { ...env, PROBE_HASH_SECRET: 'different-test-only-secret' });
  assert.notEqual(calls[0].input.key, calls[1].input.key);
  assert.notEqual(calls[0].input.key, calls[2].input.key);
});

for (const result of [
  null,
  undefined,
  {},
  { success: 'false' },
  { success: 0 },
  { success: 1 },
  new Error('private-binding-error')
]) {
  test(`malformed or failed binding result ${String(result)} returns closed 503`, async () => {
    const { env, calls } = harness();
    env.CALLER_PROBE.limit = async input => {
      calls.push({ name: 'caller', input });
      if (result instanceof Error) throw result;
      return result;
    };
    await expectResponse(await worker.fetch(request('/probe/caller'), env), 503, { error: 'binding_unknown' });
    assert.equal(calls.length, 1);
  });
}

test('a missing selected binding fails closed without using the other binding', async () => {
  const { env, calls } = harness({ overrides: { CALLER_PROBE: undefined } });
  await expectResponse(await worker.fetch(request('/probe/caller'), env), 503, { error: 'binding_unknown' });
  assert.deepEqual(calls, []);
});

test('a missing or invalid synthetic-key secret fails closed before invoking a binding', async () => {
  for (const secret of [undefined, '', 123]) {
    const { env, calls } = harness({ overrides: { PROBE_HASH_SECRET: secret } });
    await expectResponse(await worker.fetch(request('/probe/caller'), env), 503, { error: 'binding_unknown' });
    assert.deepEqual(calls, []);
  }
});

for (const authorization of [undefined, 'Bearer wrong-secret', 'Basic test-only-bearer', 'Bearer']) {
  test(`invalid authentication ${String(authorization)} refuses before keys or bindings`, async () => {
    const { env, calls } = harness();
    for (const name of ['PROBE_HASH_SECRET', 'CALLER_PROBE', 'COLO_PROBE']) {
      Object.defineProperty(env, name, {
        get() {
          throw new Error('Authentication must run first');
        }
      });
    }
    const headers = authorization === undefined ? {} : { Authorization: authorization };
    await expectResponse(await worker.fetch(request('/probe/caller', { headers }), env), 403, { error: 'forbidden' });
    assert.deepEqual(calls, []);
  });
}

test('an unset or empty configured bearer never authenticates', async () => {
  for (const configured of [undefined, '']) {
    const { env, calls } = harness({ overrides: { PROBE_BEARER: configured } });
    await expectResponse(
      await worker.fetch(request('/health', { headers: { Authorization: `Bearer ${configured}` } }), env),
      403,
      { error: 'forbidden' }
    );
    assert.deepEqual(calls, []);
  }
});

for (const [path, init] of [
  ['/unknown', {}],
  ['/probe/caller/', {}],
  ['/probe/caller?key=caller-shaped-input', {}],
  ['/health?secret=test-only-bearer', {}],
  ['/probe/caller', { method: 'POST', body: 'private-wallet-input' }],
  ['/probe/caller', { method: 'HEAD' }],
  ['/health', { method: 'OPTIONS' }]
]) {
  test(`invalid request ${init.method ?? 'GET'} ${path} returns 400 without binding work`, async () => {
    const { env, calls } = harness();
    await expectResponse(await worker.fetch(request(path, init), env), 400, { error: 'bad_request' });
    assert.deepEqual(calls, []);
  });
}

test('GET with a body is rejected without consuming its body or a binding', async () => {
  const { env, calls } = harness();
  const input = request('/probe/caller');
  Object.defineProperty(input, 'body', { value: new ReadableStream() });
  await expectResponse(await worker.fetch(input, env), 400, { error: 'bad_request' });
  assert.deepEqual(calls, []);
});

test('authenticated health checks return only health_ok without key or binding access', async () => {
  const { env, calls } = harness();
  for (const name of ['PROBE_HASH_SECRET', 'CALLER_PROBE', 'COLO_PROBE']) {
    Object.defineProperty(env, name, {
      get() {
        throw new Error('Health needs no key or binding');
      }
    });
  }
  await expectResponse(await worker.fetch(request('/health'), env), 200, { status: 'health_ok' });
  assert.deepEqual(calls, []);
});

test('closed responses never echo secrets, markers, caller fields or binding errors', async () => {
  const { env } = harness({ caller: new Error(`${bearer} ${hashSecret} private-wallet-input caller-shaped-input`) });
  const responses = [
    await worker.fetch(request('/health'), env),
    await worker.fetch(request('/probe/caller'), env),
    await worker.fetch(request('/probe/colo'), env),
    await worker.fetch(request('/probe/caller?key=caller-shaped-input'), env),
    await worker.fetch(request('/probe/caller', { headers: {} }), env)
  ];
  for (const response of responses) {
    const text = `${JSON.stringify([...response.headers])} ${await response.text()}`;
    for (const value of [
      bearer,
      hashSecret,
      'private-owner-marker',
      'private-source-marker',
      'private-config-marker',
      'private-wallet-input',
      'caller-shaped-input'
    ]) {
      assert.equal(text.includes(value), false);
    }
  }
});
