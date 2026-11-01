/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import {
  bodyOf,
  createHarness,
  hashedKey,
  loginMessage,
  privateKey,
  publicKeyOf,
  putBatch,
  putEntry,
  readyProfile,
  requestNonce,
  send,
  setSalt,
  signMessage,
  textField
} from './harness';

const RATE_LIMITED = { error: 'rate_limited', message: 'Too many requests. Try again later.' };

async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  await expect(bodyOf(response)).resolves.toEqual(RATE_LIMITED);
}

describe('auth rate limit', () => {
  it('counts the nonce and login routes on the key of the caller address', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const headers = { 'CF-Connecting-IP': '203.0.113.7' };
    const nonceResponse = await send(harness, '/v1/auth/nonce', { method: 'POST', body: { publicKey }, headers });
    const message = loginMessage(textField(await bodyOf(nonceResponse), 'nonce'), publicKey);
    const signature = await signMessage(secret, message);
    const login = await send(harness, '/v1/auth/login', {
      method: 'POST',
      body: { publicKey, message, signature },
      headers
    });
    expect(login.status).toBe(200);
    expect(harness.authLimit.keys).toEqual(['auth:203.0.113.7', 'auth:203.0.113.7']);
  });

  it('uses the key auth:unknown when the caller address is absent', async () => {
    const harness = createHarness();
    await requestNonce(harness, publicKeyOf(privateKey(1)));
    expect(harness.authLimit.keys).toEqual(['auth:unknown']);
  });

  it('refuses a nonce request over the limit and stores no nonce', async () => {
    const harness = createHarness();
    harness.authLimit.allow(0);
    const response = await send(harness, '/v1/auth/nonce', {
      method: 'POST',
      body: { publicKey: publicKeyOf(privateKey(1)) }
    });
    await expectRateLimited(response);
    expect(harness.db.nonces).toEqual([]);
  });

  it('refuses a login over the limit and keeps the nonce', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const message = loginMessage(await requestNonce(harness, publicKey), publicKey);
    harness.authLimit.allow(0);
    const response = await send(harness, '/v1/auth/login', {
      method: 'POST',
      body: { publicKey, message, signature: await signMessage(secret, message) }
    });
    await expectRateLimited(response);
    expect(harness.db.nonces).toHaveLength(1);
  });

  it('checks the limit before it reads the body', async () => {
    const harness = createHarness();
    harness.authLimit.allow(0);
    await expectRateLimited(await send(harness, '/v1/auth/nonce', { method: 'POST', body: 'not json' }));
    expect(harness.authLimit.keys).toEqual(['auth:unknown']);
  });
});

describe('storage rate limit', () => {
  it('counts every read route on the read key of the profile', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const before = harness.storageLimit.keys.length;
    await send(harness, '/v1/storage', { token: session.token });
    await send(harness, '/v1/storage/accounts', { token: session.token });
    await send(harness, `/v1/storage/accounts/${hashedKey(1)}`, { token: session.token });
    expect(harness.storageLimit.keys.slice(before)).toEqual(Array(3).fill(`read:${session.profileId}`));
  });

  it('counts every write route on the write key of the profile, a delete too', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    await putEntry(harness, session, 'accounts', hashedKey(1));
    await putBatch(harness, session, 'accounts', [hashedKey(2)]);
    await send(harness, '/v1/profile', { method: 'DELETE', token: session.token });
    // The salt set of readyProfile is the first write.
    expect(harness.storageLimit.keys).toEqual(Array(4).fill(`write:${session.profileId}`));
  });

  it('keeps separate budgets for reads and writes', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.storageLimit.allow(1);
    expect((await send(harness, '/v1/storage', { token: session.token })).status).toBe(200);
    await expectRateLimited(await send(harness, '/v1/storage', { token: session.token }));
    expect((await putEntry(harness, session, 'accounts', hashedKey(1))).status).toBe(200);
    await expectRateLimited(await putEntry(harness, session, 'accounts', hashedKey(2)));
  });

  it('keeps separate budgets for two profiles', async () => {
    const harness = createHarness();
    const first = await readyProfile(harness, 1);
    const second = await readyProfile(harness, 2);
    harness.storageLimit.allow(1);
    expect((await send(harness, '/v1/storage', { token: first.token })).status).toBe(200);
    await expectRateLimited(await send(harness, '/v1/storage', { token: first.token }));
    expect((await send(harness, '/v1/storage', { token: second.token })).status).toBe(200);
  });

  it('stops the charge of a batch at the first refused unit and writes nothing', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.storageLimit.allow(2);
    const before = harness.storageLimit.keys.length;
    const keys = Array.from({ length: 25 }, (_unused, index) => hashedKey(index + 1));
    await expectRateLimited(await putBatch(harness, session, 'accounts', keys));
    expect(harness.storageLimit.keys.length - before).toBe(3);
    expect(harness.db.entriesOf(session.profileId, 'accounts')).toEqual([]);
  });

  it('refuses a salt set and a delete over the limit and changes nothing', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.storageLimit.allow(0);
    await expectRateLimited(await setSalt(harness, session));
    await expectRateLimited(await send(harness, '/v1/profile', { method: 'DELETE', token: session.token }));
    expect(harness.db.profile(session.profileId)).toBeDefined();
  });

  it('checks the token before the limit, so a request without a token charges nothing', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/storage');
    expect(response.status).toBe(401);
    expect(harness.storageLimit.keys).toEqual([]);
  });

  it('answers 500 internal_error when the binding throws', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.storageLimit.failWith(new Error('binding failure'));
    const response = await send(harness, '/v1/storage', { token: session.token });
    expect(response.status).toBe(500);
    await expect(bodyOf(response)).resolves.toEqual({ error: 'internal_error', message: 'The request failed.' });
  });
});
