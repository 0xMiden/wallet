/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { ORIGIN, bodyOf, createHarness, hashedKey, readyProfile, send } from './harness';

const CONFIG_ERROR = { error: 'service_unavailable', message: 'The service is not configured.' };

describe('CORS', () => {
  it('answers a preflight of an allowed origin with the allowed methods and headers', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/storage/accounts', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'Authorization, Content-Type, If-None-Match'
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('authorization, content-type, if-none-match');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('ETag');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it.each([
    ['the method PATCH', { 'Access-Control-Request-Method': 'PATCH' }],
    ['no method', {}],
    [
      'a header the API does not use',
      { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Debug' }
    ]
  ])('refuses a preflight that asks for %s', async (_name, headers) => {
    const harness = createHarness();
    const response = await send(harness, '/v1/storage', { method: 'OPTIONS', headers: { Origin: ORIGIN, ...headers } });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'forbidden',
      message: 'The preflight asks for a method or header that the API does not allow.'
    });
  });

  it('refuses a request and a preflight from an origin outside ALLOWED_ORIGINS', async () => {
    const harness = createHarness();
    for (const method of ['GET', 'OPTIONS']) {
      const response = await send(harness, '/healthz', {
        method,
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' }
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('Vary')).toBe('Origin');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      await expect(bodyOf(response)).resolves.toEqual({ error: 'forbidden', message: 'The origin is not allowed.' });
    }
  });

  it('refuses every origin when ALLOWED_ORIGINS is empty, and accepts a request without an origin', async () => {
    const harness = createHarness({ allowedOrigins: '[]' });
    expect((await send(harness, '/healthz', { headers: { Origin: ORIGIN } })).status).toBe(403);
    const response = await send(harness, '/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('adds the CORS headers to a response and to an error of an allowed origin', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const read = await send(harness, '/v1/storage', { token: session.token, headers: { Origin: ORIGIN } });
    expect(read.status).toBe(200);
    expect(read.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(read.headers.get('Access-Control-Expose-Headers')).toBe('ETag');
    expect(read.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/);
    const missing = await send(harness, `/v1/storage/accounts/${hashedKey(1)}`, {
      token: session.token,
      headers: { Origin: ORIGIN }
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it.each([
    ['a wildcard', '["*"]'],
    ['an object', '{"origin":"x"}'],
    ['an empty string entry', '[""]'],
    ['a number entry', '[1]'],
    ['text that is not JSON', 'chrome-extension://wallet-test']
  ])('answers 503 when ALLOWED_ORIGINS holds %s', async (_name, allowedOrigins) => {
    const harness = createHarness({ allowedOrigins });
    const response = await send(harness, '/healthz');
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual(CONFIG_ERROR);
  });
});

describe('health route', () => {
  it('answers 200 with the revision when every binding and the key are present', async () => {
    const harness = createHarness();
    const response = await send(harness, '/healthz');
    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, revision: 'test-revision' });
  });

  it('reports the revision unknown when DEPLOYMENT_REVISION is absent', async () => {
    const harness = createHarness({ revision: null });
    await expect(bodyOf(await send(harness, '/healthz'))).resolves.toEqual({ ok: true, revision: 'unknown' });
  });

  it.each([
    ['the database', { db: false }],
    ['the auth rate limit', { authLimit: false }],
    ['the storage rate limit', { storageLimit: false }],
    ['the signing key', { signingKey: null }],
    ['a signing key of 31 characters', { signingKey: 'k'.repeat(31) }]
  ])('answers 503 with ok false without %s', async (_name, options) => {
    const harness = createHarness(options);
    const response = await send(harness, '/healthz');
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual({ ok: false, revision: 'test-revision' });
  });
});

describe('missing configuration on the routes', () => {
  it('answers 503 on the nonce route without the database or the auth rate limit', async () => {
    for (const options of [{ db: false }, { authLimit: false }]) {
      const harness = createHarness(options);
      const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body: {} });
      expect(response.status).toBe(503);
      await expect(bodyOf(response)).resolves.toEqual(CONFIG_ERROR);
    }
  });

  it('answers 503 on the login route with a short signing key', async () => {
    const harness = createHarness({ signingKey: 'short' });
    const response = await send(harness, '/v1/auth/login', { method: 'POST', body: {} });
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual(CONFIG_ERROR);
  });

  it('answers 503 on a storage route without the storage rate limit', async () => {
    const ready = createHarness();
    const session = await readyProfile(ready);
    const harness = createHarness({ storageLimit: false });
    const response = await send(harness, '/v1/storage', { token: session.token });
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual(CONFIG_ERROR);
  });
});

describe('routing', () => {
  it.each(['/', '/v1', '/v1/storage/', '/v1/storage/accounts/a/b', '/v1/auth'])(
    'answers 404 not_found for %s',
    async path => {
      const harness = createHarness();
      const response = await send(harness, path);
      expect(response.status).toBe(404);
      await expect(bodyOf(response)).resolves.toEqual({ error: 'not_found', message: 'The route does not exist.' });
    }
  );

  it('answers 404 unknown_feature for a feature outside the allowlist', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/storage/settings');
    expect(response.status).toBe(404);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'unknown_feature',
      message: 'The feature must be one of: accounts, contacts, history.'
    });
  });

  it('answers 400 for a hashed key in the path that is not 64 lowercase hex characters', async () => {
    const harness = createHarness();
    const response = await send(harness, `/v1/storage/accounts/${hashedKey(1).toUpperCase()}A`);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'bad_request',
      message: 'hashedKey must be 64 lowercase hex characters.'
    });
  });

  it.each([
    ['/healthz', 'POST', 'GET'],
    ['/v1/auth/nonce', 'GET', 'POST'],
    ['/v1/auth/login', 'PUT', 'POST'],
    ['/v1/profile/salt', 'POST', 'PUT'],
    ['/v1/profile', 'GET', 'DELETE'],
    ['/v1/storage', 'PUT', 'GET'],
    ['/v1/storage/accounts', 'DELETE', 'GET, PUT'],
    [`/v1/storage/accounts/${hashedKey(1)}`, 'POST', 'GET, PUT']
  ])('answers 405 for %s with %s and names the allowed methods', async (path, method, allow) => {
    const harness = createHarness();
    const response = await send(harness, path, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(allow);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'bad_request',
      message: `The route allows only: ${allow}.`
    });
  });

  it('marks every JSON response private and no-store', async () => {
    const harness = createHarness();
    const response = await send(harness, '/healthz');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
