/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { ORIGIN, RELAY_ID, bodyOf, createHarness, oneChainConfig, send } from './harness';
import { ApiError } from '../src/errors';
import { MAX_BODY_BYTES, readJson } from '../src/http';

const CONFIG_ERROR = { error: 'service_unavailable', message: 'The service is not configured.' };
const NOT_FOUND = { error: 'not_found', message: 'The route does not exist.' };

describe('CORS', () => {
  it('answers a preflight of an allowed origin with the allowed methods and headers', async () => {
    const response = await send(createHarness(), '/v1/relay', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type'
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('content-type');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it.each([
    ['the method PUT', { 'Access-Control-Request-Method': 'PUT' }],
    ['no method', {}],
    [
      'a header the API does not use',
      { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' }
    ]
  ])('refuses a preflight that asks for %s', async (_name, headers) => {
    const response = await send(createHarness(), '/v1/account', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, ...headers }
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'origin_not_allowed',
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
      await expect(bodyOf(response)).resolves.toEqual({
        error: 'origin_not_allowed',
        message: 'The origin is not allowed.'
      });
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

  it('adds the CORS headers to an error of an allowed origin', async () => {
    const response = await send(createHarness(), '/v1/account', { headers: { Origin: ORIGIN } });
    expect(response.status).toBe(400);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it.each([
    ['a wildcard', '["*"]'],
    ['an object', '{"origin":"x"}'],
    ['an empty string entry', '[""]'],
    ['text that is not JSON', 'chrome-extension://wallet-test']
  ])('answers 503 when ALLOWED_ORIGINS holds %s', async (_name, allowedOrigins) => {
    const response = await send(createHarness({ allowedOrigins }), '/healthz');
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual(CONFIG_ERROR);
  });
});

describe('health route', () => {
  it('answers 200 with the revision when the config parses and both bindings are present', async () => {
    const response = await send(createHarness(), '/healthz');
    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, revision: 'test-revision' });
  });

  it('reports the revision unknown when DEPLOYMENT_REVISION is absent', async () => {
    await expect(bodyOf(await send(createHarness({ revision: null }), '/healthz'))).resolves.toEqual({
      ok: true,
      revision: 'unknown'
    });
  });

  it.each([
    ['the read rate limit', { readLimit: false }],
    ['the relay rate limit', { relayLimit: false }],
    ['GAS_MODE', { gasMode: null }],
    ['a valid GAS_MODE', { gasMode: 'free' }],
    ['RELAY_CONFIG', { relayConfig: null }],
    ['a valid RELAY_CONFIG', { relayConfig: '{"chains":{"1":{"rpcUrl":"https://secret.example/key"}}}' }],
    ['a Calibur pin in RELAY_CONFIG', { relayConfig: '{"chains":{}}' }],
    ['the Sender binding', { senderBinding: false }],
    ['RELAYER_PRIVATE_KEY', { relayerKey: null }],
    ['a well-formed RELAYER_PRIVATE_KEY', { relayerKey: '0xsecret' }],
    ['a RELAYER_PRIVATE_KEY of 64 hex characters', { relayerKey: `0x${'1'.repeat(63)}` }],
    ['a RELAYER_PRIVATE_KEY that is a valid scalar', { relayerKey: `0x${'0'.repeat(64)}` }],
    ['a valid RPC URL', { relayConfig: oneChainConfig(), rpcUrls: { '8453': 'ftp://secret.example' } }],
    ['a valid RPC URL of a chain without an entry', { rpcUrls: { '10': 'not a url secret' } }],
    ['a chain id in each RPC_URL_ secret', { rpcUrls: { '8453': 'https://secret.example', '': 'https://secret.x' } }],
    [
      'a fee for each served chain in deduct mode',
      { gasMode: 'deduct', relayConfig: oneChainConfig(), chains: [8453, 1] }
    ]
  ])('answers 503 with ok false and no config value without %s', async (_name, options) => {
    const response = await send(createHarness(options), '/healthz');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, revision: 'test-revision' });
    expect(text).not.toContain('secret');
  });

  it('answers 200 when each served chain has a valid RPC URL', async () => {
    const harness = createHarness({ relayConfig: oneChainConfig(), rpcUrls: { '8453': 'https://secret.example/key' } });
    const text = await (await send(harness, '/healthz')).text();
    expect(JSON.parse(text)).toEqual({ ok: true, revision: 'test-revision' });
    expect(text).not.toContain('secret');
  });

  it.each([
    ['a served chain without a chains entry', { rpcUrls: { '10': 'https://secret.example/key' } }],
    ['a chains entry of a chain without an RPC URL', { relayConfig: oneChainConfig() }]
  ])('answers 200 for %s', async (_name, options) => {
    const response = await send(createHarness(options), '/healthz');
    expect(response.status).toBe(200);
  });

  it('marks every JSON response private and no-store', async () => {
    const response = await send(createHarness(), '/healthz');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('routing', () => {
  it.each([
    '/',
    '/v1',
    '/v1/',
    '/v1/account/',
    '/v1/relay/',
    `/v1/relay/${RELAY_ID}/x`,
    `/v1/relay/${RELAY_ID.slice(0, -1)}`,
    `/v1/relay/${RELAY_ID}0`,
    `/v1/relay/${RELAY_ID.slice(2)}`,
    `/v1/relay/0X${RELAY_ID.slice(2)}`,
    `/v1/relay/0x${'g'.repeat(64)}`
  ])('answers 404 not_found for %s', async path => {
    const harness = createHarness();
    const response = await send(harness, path);
    expect(response.status).toBe(404);
    await expect(bodyOf(response)).resolves.toEqual(NOT_FOUND);
    expect(harness.readLimit.keys).toEqual([]);
  });

  it.each([
    ['/healthz', 'POST', 'GET'],
    ['/v1/account', 'POST', 'GET'],
    ['/v1/relay', 'GET', 'POST'],
    ['/v1/relay', 'PUT', 'POST'],
    [`/v1/relay/${RELAY_ID}`, 'DELETE', 'GET']
  ])('answers 405 for %s with %s and names the allowed method', async (path, method, allow) => {
    const harness = createHarness();
    const response = await send(harness, path, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(allow);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'method_not_allowed',
      message: `The route allows only: ${allow}.`
    });
    expect([...harness.readLimit.keys, ...harness.relayLimit.keys]).toEqual([]);
  });
});

describe('readJson', () => {
  function post(body: string, headers: Record<string, string> = {}): Request {
    return new Request('https://evm-relay.test/v1/relay', { method: 'POST', body, headers });
  }

  async function codeOf(request: Request): Promise<string> {
    try {
      await readJson(request);
    } catch (error) {
      if (error instanceof ApiError) return `${error.status} ${error.code}`;
      throw error;
    }
    return 'parsed';
  }

  it('reads a JSON object', async () => {
    await expect(readJson(post('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it('accepts a body of exactly the cap and refuses one byte more', async () => {
    const fill = (size: number): string => `{"a":"${'x'.repeat(size - 8)}"}`;
    expect(await codeOf(post(fill(MAX_BODY_BYTES)))).toBe('parsed');
    expect(await codeOf(post(fill(MAX_BODY_BYTES + 1)))).toBe('413 payload_too_large');
  });

  it('refuses a declared length over the cap before it reads the body', async () => {
    expect(await codeOf(post('{}', { 'Content-Length': String(MAX_BODY_BYTES + 1) }))).toBe('413 payload_too_large');
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an array', '[]'],
    ['a number', '1']
  ])('refuses %s with 400 invalid_request', async (_name, body) => {
    expect(await codeOf(post(body))).toBe('400 invalid_request');
  });

  it('refuses a request without a body', async () => {
    expect(await codeOf(new Request('https://evm-relay.test/v1/relay', { method: 'POST' }))).toBe(
      '400 invalid_request'
    );
  });
});
