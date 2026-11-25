import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDeployment, validateEndpoint, validateOrigins } from './check-deployment.mjs';

const endpoint = 'https://evm-relay.example';
const origin = 'https://wallet.example';
const options = { endpoint, origins: [origin], revision: 'release-sha' };

const noStore = { 'Cache-Control': 'private, no-store' };
const health = (body = { ok: true, revision: 'release-sha' }, status = 200) =>
  Response.json(body, { status, headers: { ...noStore } });
/** The preflight the Worker sends (src/http.ts and src/index.ts). An override replaces or, with null, drops a header. */
const preflightOk = (overrides = {}) => {
  const headers = {
    ...noStore,
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    ...overrides
  };
  for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
  return new Response(null, { status: 204, headers });
};
const forbidden = () =>
  Response.json(
    { error: 'origin_not_allowed', message: 'The origin is not allowed.' },
    { status: 403, headers: { ...noStore, Vary: 'Origin' } }
  );
/** The answer of GET /v1/account with no query (src/routes/account.ts). */
const accountInvalid = (overrides = {}) => {
  const headers = { ...noStore, Vary: 'Origin', 'Access-Control-Allow-Origin': origin, ...overrides };
  for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
  return Response.json(
    { error: 'invalid_request', message: 'chainId must be a positive decimal integer.' },
    { status: 400, headers }
  );
};

/** A fake Worker. Each override replaces one answer. */
const fixture = (overrides = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    calls.push(`${init.method} ${target.pathname}${target.search}`);
    assert.equal(target.origin, endpoint);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    switch (`${init.method} ${target.pathname}`) {
      case 'OPTIONS /v1/relay':
        assert.equal(init.headers.Origin, origin);
        assert.equal(init.headers['Access-Control-Request-Method'], 'POST');
        assert.equal(init.headers['Access-Control-Request-Headers'], 'content-type');
        return overrides.preflight?.() ?? preflightOk();
      case 'GET /v1/account':
        assert.equal(target.search, '');
        assert.equal(init.headers.Origin, origin);
        return overrides.account?.() ?? accountInvalid();
      case 'GET /healthz':
        if (init.headers?.Origin !== undefined) {
          assert.notEqual(init.headers.Origin, origin);
          return overrides.foreign?.() ?? forbidden();
        }
        return overrides.health?.() ?? health();
      default:
        throw new Error(`Unexpected request ${init.method} ${target.pathname}`);
    }
  };
  return { calls, fetchImpl };
};

test('validateEndpoint accepts an https base URL with a path and refuses the rest', () => {
  assert.equal(validateEndpoint('https://evm-relay.example'), 'https://evm-relay.example');
  assert.equal(validateEndpoint('https://api.example/relay'), 'https://api.example/relay');
  for (const bad of [
    'http://evm-relay.example',
    'https://evm-relay.example/',
    'https://user:pw@evm-relay.example',
    'https://evm-relay.example?x=1',
    'https://evm-relay.example#x',
    'not a url'
  ]) {
    assert.throws(() => validateEndpoint(bad), /EVM relay base URL/i, bad);
  }
});

test('validateOrigins accepts exact origins and refuses an empty list, a wildcard and a non-string', () => {
  assert.deepEqual(validateOrigins([origin, 'capacitor://localhost']), [origin, 'capacitor://localhost']);
  for (const bad of [[], ['https://*.example'], ['*'], [''], [1], 'https://wallet.example', null]) {
    assert.throws(() => validateOrigins(bad), /exact wallet origins/, JSON.stringify(bad));
  }
});

test('passes a ready service that reports the revision, allows the wallet origin, refuses a foreign one and routes', async () => {
  const { calls, fetchImpl } = fixture();
  const result = await checkDeployment({ ...options, fetchImpl });
  assert.deepEqual(result, { endpoint: 'https://evm-relay.example' });
  assert.deepEqual(calls, ['GET /healthz', 'OPTIONS /v1/relay', 'GET /healthz', 'GET /v1/account']);
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

test('refuses an http endpoint before any request', async () => {
  const { calls, fetchImpl } = fixture();
  await assert.rejects(checkDeployment({ ...options, endpoint: 'http://evm-relay.example', fetchImpl }), /HTTPS/);
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
  assert.equal(result.endpoint, 'https://evm-relay.example');
  assert.equal(attempts, 3);
  await assert.rejects(checkDeployment({ ...options, fetchImpl, healthAttempts: 0 }), /retry limit/);
});

test('fails when the preflight refuses the wallet origin', async () => {
  const { fetchImpl } = fixture({ preflight: () => forbidden() });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /configured wallet origin/);
});

test('fails when the preflight answers for another origin', async () => {
  const { fetchImpl } = fixture({
    preflight: () => preflightOk({ 'Access-Control-Allow-Origin': 'https://other.example' })
  });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /configured wallet origin/);
});

for (const [name, headers] of [
  ['omits Vary', { Vary: null }],
  ['omits Access-Control-Allow-Headers', { 'Access-Control-Allow-Headers': null }],
  ['does not allow content-type', { 'Access-Control-Allow-Headers': 'authorization' }],
  ['allows only a lookalike header', { 'Access-Control-Allow-Headers': 'x-content-type' }],
  ['omits Access-Control-Allow-Methods', { 'Access-Control-Allow-Methods': null }],
  ['does not allow POST', { 'Access-Control-Allow-Methods': 'GET' }],
  ['does not allow GET', { 'Access-Control-Allow-Methods': 'POST' }],
  ['allows only a lookalike method', { 'Access-Control-Allow-Methods': 'GETS, POST' }]
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
        'Access-Control-Allow-Methods': 'POST ,GET',
        'Access-Control-Allow-Headers': ' Content-Type '
      })
  });
  assert.deepEqual(await checkDeployment({ ...options, fetchImpl }), { endpoint: 'https://evm-relay.example' });
});

test('fails when a foreign origin is accepted', async () => {
  const { fetchImpl } = fixture({ foreign: () => health() });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /not configured/);
});

test('fails when a foreign origin gets 403 with an allow-origin header', async () => {
  const { fetchImpl } = fixture({
    foreign: () =>
      Response.json(
        { error: 'origin_not_allowed', message: 'The origin is not allowed.' },
        { status: 403, headers: { 'Access-Control-Allow-Origin': 'https://evm-relay-probe.invalid' } }
      )
  });
  await assert.rejects(checkDeployment({ ...options, fetchImpl }), /not configured/);
});

for (const [name, answer] of [
  [
    'answers 503 because the config does not parse',
    () =>
      Response.json(
        { error: 'service_unavailable', message: 'The service is not configured.' },
        { status: 503, headers: { ...noStore, 'Access-Control-Allow-Origin': origin } }
      )
  ],
  [
    'answers 404 because the route is missing',
    () =>
      Response.json(
        { error: 'not_found', message: 'The route does not exist.' },
        { status: 404, headers: { ...noStore, 'Access-Control-Allow-Origin': origin } }
      )
  ],
  [
    'answers 400 with another error code',
    () =>
      Response.json(
        { error: 'unsupported_chain', message: 'The chain is not supported.' },
        { status: 400, headers: { ...noStore, 'Access-Control-Allow-Origin': origin } }
      )
  ],
  ['answers 400 with a body that is not JSON', () => new Response('bad', { status: 400, headers: { ...noStore } })],
  ['omits the allow-origin header', () => accountInvalid({ 'Access-Control-Allow-Origin': null })],
  ['is cacheable', () => accountInvalid({ 'Cache-Control': null })]
]) {
  test(`fails when the account read ${name}`, async () => {
    const { fetchImpl } = fixture({ account: answer });
    await assert.rejects(checkDeployment({ ...options, fetchImpl }), /account read/);
  });
}
