/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { RELAY_ID, bodyOf, createHarness, send } from './harness';

const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };

async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  await expect(bodyOf(response)).resolves.toEqual({
    error: 'rate_limited',
    message: 'Too many requests. Try again later.',
    retryAfter: 60
  });
}

describe('read rate limit', () => {
  it('counts both GET /v1 routes on the read key of the caller IP', async () => {
    const harness = createHarness();
    await send(harness, '/v1/account', { headers: CALLER });
    await send(harness, `/v1/relay/${RELAY_ID}`, { headers: CALLER });
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7', 'read:203.0.113.7']);
    expect(harness.relayLimit.keys).toEqual([]);
  });

  it('uses the key read:unknown when the caller IP is absent', async () => {
    const harness = createHarness();
    await send(harness, '/v1/account');
    expect(harness.readLimit.keys).toEqual(['read:unknown']);
  });

  it('refuses a read over the limit and keeps the budgets of other callers', async () => {
    const harness = createHarness();
    harness.readLimit.allow(1);
    // The account route answers 400 after the charge, because the query is missing.
    expect((await send(harness, '/v1/account', { headers: CALLER })).status).toBe(400);
    await expectRateLimited(await send(harness, `/v1/relay/${RELAY_ID}`, { headers: CALLER }));
    expect((await send(harness, '/v1/account', { headers: { 'CF-Connecting-IP': '198.51.100.1' } })).status).toBe(400);
  });

  it('does not count /healthz', async () => {
    const harness = createHarness();
    harness.readLimit.allow(0);
    expect((await send(harness, '/healthz')).status).toBe(200);
    expect(harness.readLimit.keys).toEqual([]);
  });

  it('answers 503 on a read route without the binding', async () => {
    const response = await send(createHarness({ readLimit: false }), '/v1/account');
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'service_unavailable',
      message: 'The service is not configured.'
    });
  });
});

describe('relay rate limit', () => {
  it('counts POST /v1/relay on the relay key of the caller IP', async () => {
    const harness = createHarness();
    await send(harness, '/v1/relay', { method: 'POST', body: '{}', headers: CALLER });
    expect(harness.relayLimit.keys).toEqual(['relay:203.0.113.7']);
    expect(harness.readLimit.keys).toEqual([]);
  });

  it('refuses a relay over the limit, a malformed one too, and keeps the read budget', async () => {
    const harness = createHarness();
    harness.relayLimit.allow(0);
    await expectRateLimited(await send(harness, '/v1/relay', { method: 'POST', body: 'not json', headers: CALLER }));
    expect((await send(harness, '/v1/account', { headers: CALLER })).status).toBe(400);
  });

  it('answers 503 on the relay route without the binding', async () => {
    const response = await send(createHarness({ relayLimit: false }), '/v1/relay', { method: 'POST', body: '{}' });
    expect(response.status).toBe(503);
  });
});
