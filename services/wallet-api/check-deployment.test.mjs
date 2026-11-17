import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDeployment, validateEndpoint } from './check-deployment.mjs';

const endpoint = 'https://wallet-api.example';
const origin = 'https://wallet.example';
const options = { endpoint, origins: [origin], revision: 'release-sha' };

const noStore = { 'Cache-Control': 'private, no-store' };
const health = (body = { ok: true, revision: 'release-sha' }, status = 200) =>
  Response.json(body, { status, headers: { ...noStore, Vary: 'Origin' } });
/** The preflight the Worker sends (src/http.ts). An override replaces or, with null, drops a header. */
const preflightOk = (overrides = {}) => {
  const headers = {
    ...noStore,
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
    'Access-Control-Allow-Headers': 'authorization, content-type, if-none-match',
    'Access-Control-Max-Age': '600',
    ...overrides
  };
  for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
  return new Response(null, { status: 204, headers });
};
const forbidden = () =>
  Response.json(
    { error: 'forbidden', message: 'The origin is not allowed.' },
    { status: 403, headers: { Vary: 'Origin' } }
  );

/** A fake Worker. Each override replaces one answer. */
const fixture = (overrides = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    calls.push(`${init.method} ${target.pathname}`);
    assert.equal(target.origin, endpoint);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    switch (init.method) {
      case 'OPTIONS':
        assert.equal(target.pathname, '/v1/storage');
        assert.equal(init.headers.Origin, origin);
        assert.equal(init.headers['Access-Control-Request-Method'], 'GET');
        assert.equal(init.headers['Access-Control-Request-Headers'], 'authorization, if-none-match');
        return overrides.preflight?.() ?? preflightOk();
      case 'GET':
        assert.equal(target.pathname, '/healthz');
        if (init.headers?.Origin !== undefined) {
          assert.notEqual(init.headers.Origin, origin);
          return overrides.foreign?.() ?? forbidden();
        }
        return overrides.health?.() ?? health();
      default:
        throw new Error(`Unexpected method ${init.method}`);
    }
  };
  return { calls, fetchImpl };
};

test('validateEndpoint accepts an https base URL with a path and refuses the rest', () => {
  assert.equal(validateEndpoint('https://wallet-api.example'), 'https://wallet-api.example');
  assert.equal(validateEndpoint('https://api.example/backup'), 'https://api.example/backup');
  for (const bad of [
    'http://wallet-api.example',
    'https://wallet-api.example/',
    'https://user:pw@wallet-api.example',
    'https://wallet-api.example?x=1',
    'https://wallet-api.example#x',
    'not a url'
  ]) {
    assert.throws(() => validateEndpoint(bad), /wallet-api base URL/i, bad);
  }
});

test('passes a ready service that reports the revision, allows the wallet origin and refuses a foreign one', async () => {
  const { calls, fetchImpl } = fixture();
  const result = await checkDeployment({ ...options, fetchImpl });
  assert.deepEqual(result, { endpoint: 'https://wallet-api.example' });
  assert.deepEqual(calls, ['GET /healthz', 'OPTIONS /v1/storage', 'GET /healthz']);
});

test('refuses empty or wildcard origins before any request', async () => {
  const { calls, fetchImpl } = fixture();
  await assert.rejects(checkDeployment({ ...options, origins: [], fetchImpl }), /exact wallet origins/);
  await assert.rejects(
    checkDeployment({ ...options, origins: ['https://*.example'], fetchImpl }),
    /exact wallet origins/
  );
  assert.deepEqual(calls, []);
});

test('fails when the service is not ready', async () => {
  const { fetchImpl } = fixture({ health: () => health({ ok: false, revision: 'release-sha' }, 503) });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /not ready/);
});

test('fails when the service reports another revision', async () => {
  const { fetchImpl } = fixture({ health: () => health({ ok: true, revision: 'older-sha' }) });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /release revision/);
});

test('fails when the health response is cacheable', async () => {
  const { fetchImpl } = fixture({
    health: () => Response.json({ ok: true, revision: 'release-sha' }, { status: 200 })
  });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /not ready/);
});

test('fails when the health response is not JSON', async () => {
  const { fetchImpl } = fixture({ health: () => new Response('<html>', { status: 200 }) });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /JSON response/);
});

test('retries the health check up to the limit, then stops', async () => {
  let attempts = 0;
  const { fetchImpl } = fixture({
    health: () => {
      attempts += 1;
      return attempts < 3 ? health({ ok: false, revision: 'release-sha' }, 503) : health();
    }
  });
  const result = await checkDeployment({ ...options, fetchImpl, healthAttempts: 3 });
  assert.equal(result.endpoint, 'https://wallet-api.example');
  assert.equal(attempts, 3);
  await assert.rejects(checkDeployment({ ...options, fetchImpl, healthAttempts: 0 }), /retry limit/);
});

test('fails when the preflight refuses the wallet origin', async () => {
  const { fetchImpl } = fixture({ preflight: () => forbidden() });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /configured wallet origin/);
});

test('fails when the preflight answers for another origin', async () => {
  const { fetchImpl } = fixture({
    preflight: () =>
      new Response(null, {
        status: 204,
        headers: { Vary: 'Origin', 'Access-Control-Allow-Origin': 'https://other.example' }
      })
  });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /configured wallet origin/);
});

test('fails when a foreign origin is accepted', async () => {
  const { fetchImpl } = fixture({ foreign: () => health() });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /not configured/);
});

for (const [name, headers] of [
  ['omits Access-Control-Allow-Headers', { 'Access-Control-Allow-Headers': null }],
  ['does not allow if-none-match', { 'Access-Control-Allow-Headers': 'authorization, content-type' }],
  ['does not allow authorization', { 'Access-Control-Allow-Headers': 'content-type, if-none-match' }],
  ['allows only a lookalike header', { 'Access-Control-Allow-Headers': 'x-authorization, if-none-match' }],
  ['omits Access-Control-Allow-Methods', { 'Access-Control-Allow-Methods': null }],
  ['does not allow GET', { 'Access-Control-Allow-Methods': 'POST, PUT' }],
  ['allows only a lookalike method', { 'Access-Control-Allow-Methods': 'GETS, POST, PUT, DELETE' }],
  ['does not allow PUT', { 'Access-Control-Allow-Methods': 'GET, POST, DELETE' }],
  ['does not allow content-type', { 'Access-Control-Allow-Headers': 'authorization, if-none-match' }]
]) {
  test(`fails when the preflight ${name}`, async () => {
    const { fetchImpl } = fixture({ preflight: () => preflightOk(headers) });
    await assert.rejects(checkDeployment({ ...options, fetchImpl }), /configured wallet origin/);
  });
}

test('passes a preflight whose lists are reordered, spaced and in mixed case', async () => {
  const { fetchImpl } = fixture({
    preflight: () =>
      preflightOk({
        'Access-Control-Allow-Methods': 'DELETE,PUT , GET,POST',
        'Access-Control-Allow-Headers': ' If-None-Match ,Content-Type,  Authorization'
      })
  });
  assert.deepEqual(await checkDeployment({ ...options, fetchImpl }), { endpoint: 'https://wallet-api.example' });
});
