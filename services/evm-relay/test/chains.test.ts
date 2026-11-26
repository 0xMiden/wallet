/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  FEE_RECIPIENT,
  ORIGIN,
  TARGET,
  TEST_EXECUTOR,
  TEST_RPC_URL,
  USDC,
  bodyOf,
  chainEntry,
  createHarness,
  relayConfigOf,
  send,
  type Harness
} from './harness';

const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const ADDRESS = `0x${'12'.repeat(20)}`;
const CONFIG_ERROR = { error: 'service_unavailable', message: 'The service is not configured.' };
/** Entries for the chains 8453 and 1, with fees and a target list. Both are valid in both gas modes. */
const CONFIG = relayConfigOf({ '8453': chainEntry(), '1': chainEntry({ allowedTargets: [TARGET] }) });

function chainsOf(harness: Harness, headers: Record<string, string> = CALLER): Promise<Response> {
  return send(harness, '/v1/chains', { headers });
}

let logs: unknown[][];

beforeEach(() => {
  logs = [];
  const record = (...args: unknown[]): void => {
    logs.push(args);
  };
  jest.spyOn(console, 'log').mockImplementation(record);
  jest.spyOn(console, 'warn').mockImplementation(record);
  jest.spyOn(console, 'error').mockImplementation(record);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /v1/chains', () => {
  it('answers the served chains in ascending order, the mode and the executor, and reads no chain', async () => {
    const harness = createHarness({ relayConfig: CONFIG, chains: [8453, 1, 10] });
    const response = await chainsOf(harness);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=60');
    await expect(bodyOf(response)).resolves.toEqual({
      mode: 'sponsor',
      executor: TEST_EXECUTOR,
      chains: [1, 10, 8453]
    });
    expect(harness.reader.calls).toEqual([]);
    expect(harness.reader.relayCalls).toEqual([]);
    expect(harness.senders.broadcasts).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('answers an empty list when no chain has an RPC URL', async () => {
    const response = await chainsOf(createHarness({ relayConfig: CONFIG }));
    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ mode: 'sponsor', executor: TEST_EXECUTOR, chains: [] });
  });

  it('does not list a chain that has a chains entry and no RPC URL', async () => {
    const body = await bodyOf(await chainsOf(createHarness({ relayConfig: CONFIG, chains: [8453] })));
    expect(body.chains).toEqual([8453]);
  });

  it.each(['sponsor', 'deduct'])('answers the gas mode %s', async gasMode => {
    const body = await bodyOf(await chainsOf(createHarness({ gasMode, relayConfig: CONFIG, chains: [8453, 1] })));
    expect(body).toEqual({ mode: gasMode, executor: TEST_EXECUTOR, chains: [1, 8453] });
  });

  it('has exactly the three fields, and no RPC URL, fee or target in the body', async () => {
    const harness = createHarness({ gasMode: 'deduct', relayConfig: CONFIG, chains: [8453, 1] });
    const text = await (await chainsOf(harness)).text();
    const body: unknown = JSON.parse(text);
    expect(body).toEqual({ mode: 'deduct', executor: TEST_EXECUTOR, chains: [1, 8453] });
    for (const value of [TEST_RPC_URL, 'rpc.example', FEE_RECIPIENT, USDC, TARGET, '100000', 'Calibur']) {
      expect(text).not.toContain(value);
    }
  });

  it('lists exactly the chains that GET /v1/account serves, with the same executor', async () => {
    const harness = createHarness({ relayConfig: CONFIG, chains: [8453, 10] });
    const body = await bodyOf(await chainsOf(harness));
    expect(body.chains).toEqual([10, 8453]);
    for (const chainId of [10, 8453]) {
      const account = await send(harness, `/v1/account?chainId=${chainId}&address=${ADDRESS}`);
      expect(account.status).toBe(200);
      expect((await bodyOf(account)).executor).toBe(body.executor);
    }
    const unserved = await send(harness, `/v1/account?chainId=1&address=${ADDRESS}`);
    expect(unserved.status).toBe(400);
    expect((await bodyOf(unserved)).error).toBe('unsupported_chain');
  });

  it('adds the CORS headers for an allowed origin', async () => {
    const response = await chainsOf(createHarness({ chains: [8453] }), { ...CALLER, Origin: ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('refuses an origin outside ALLOWED_ORIGINS before the rate limit', async () => {
    const harness = createHarness({ chains: [8453] });
    const response = await chainsOf(harness, { ...CALLER, Origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'origin_not_allowed',
      message: 'The origin is not allowed.'
    });
    expect(harness.readLimit.keys).toEqual([]);
  });

  it('charges the caller IP on the read binding only', async () => {
    const harness = createHarness({ chains: [8453] });
    await chainsOf(harness);
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7']);
    expect(harness.relayLimit.keys).toEqual([]);
  });

  it('answers 429 rate_limited for a caller over the read limit', async () => {
    const harness = createHarness({ chains: [8453] });
    harness.readLimit.allow(0);
    const response = await chainsOf(harness);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'rate_limited',
      message: 'Too many requests. Try again later.',
      retryAfter: 60
    });
  });

  it('answers 503 when the read rate limit binding is missing', async () => {
    const response = await chainsOf(createHarness({ chains: [8453], readLimit: false }));
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual(CONFIG_ERROR);
  });

  it.each([
    ['RELAY_CONFIG does not parse', createHarness({ relayConfig: '{}', chains: [8453] })],
    ['RELAY_CONFIG is missing', createHarness({ relayConfig: null, chains: [8453] })],
    ['GAS_MODE is not valid', createHarness({ gasMode: 'free', chains: [8453] })],
    [
      'GAS_MODE is deduct and a served chain has no fees',
      createHarness({ gasMode: 'deduct', relayConfig: relayConfigOf({ '8453': chainEntry() }), chains: [8453, 1] })
    ],
    ['an RPC_URL_ secret does not name a chain id', createHarness({ rpcUrls: { base: TEST_RPC_URL } })],
    ['RELAYER_PRIVATE_KEY is missing', createHarness({ chains: [8453], relayerKey: null })],
    ['RELAYER_PRIVATE_KEY is not a valid key', createHarness({ chains: [8453], relayerKey: `0x${'0'.repeat(64)}` })]
  ])('answers 503 service_unavailable when %s', async (_name, harness) => {
    const response = await chainsOf(harness);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(CONFIG_ERROR);
    expect(text).not.toContain('rpc.example');
  });

  it.each(['POST', 'PUT', 'DELETE'])('answers 405 for %s and names GET, with no charge', async method => {
    const harness = createHarness({ chains: [8453] });
    const response = await send(harness, '/v1/chains', { method, headers: CALLER });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'method_not_allowed',
      message: 'The route allows only: GET.'
    });
    expect(harness.readLimit.keys).toEqual([]);
  });

  it('answers 404 for a path under the route', async () => {
    const response = await send(createHarness({ chains: [8453] }), '/v1/chains/8453');
    expect(response.status).toBe(404);
  });
});
