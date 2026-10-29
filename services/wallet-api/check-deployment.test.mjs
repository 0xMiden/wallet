import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDeployment, validateEndpoint } from './check-deployment.mjs';

const endpoint = 'https://wallet-api.example';
const origin = 'https://wallet.example';
const options = { endpoint, origins: [origin], revision: 'release-sha' };

const noStore = { 'Cache-Control': 'private, no-store' };
const health = (body = { ok: true, revision: 'release-sha' }, status = 200) =>
  Response.json(body, { status, headers: { ...noStore, Vary: 'Origin' } });
const preflightOk = () =>
  new Response(null, {
    status: 204,
    headers: { ...noStore, Vary: 'Origin', 'Access-Control-Allow-Origin': origin }
  });
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
