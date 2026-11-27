/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { NONCE_INSERT_SQL, NONCE_SWEEP_SQL } from './fake-d1';
import {
  SIGNING_KEY,
  START_MS,
  bodyOf,
  createHarness,
  logIn,
  loginMessage,
  privateKey,
  publicKeyOf,
  requestNonce,
  send,
  signMessage,
  textField
} from './harness';
import type { Harness } from './harness';
import { NONCE_TTL_MS, TOKEN_TTL_S } from '../src/constants';
import { NONCE_SWEEP_LIMIT } from '../src/routes/auth';
import { profileIdFor, verifyToken } from '../src/token';

async function postLogin(harness: Harness, publicKey: string, message: string, signature: string): Promise<Response> {
  return send(harness, '/v1/auth/login', { method: 'POST', body: { publicKey, message, signature } });
}

const NONCE_INVALID = {
  error: 'nonce_invalid',
  message: 'The nonce is unknown, used or expired. Ask for a new nonce.'
};
const SIGNATURE_INVALID = { error: 'signature_invalid', message: 'The signature does not match the public key.' };

describe('nonce issue', () => {
  it('returns a 32-byte nonce that expires after the nonce TTL and stores it for the key', async () => {
    const harness = createHarness();
    const publicKey = publicKeyOf(privateKey(1));
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body: { publicKey } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await bodyOf(response);
    expect(body).toEqual({ nonce: expect.stringMatching(/^[0-9a-f]{64}$/), expiresAt: START_MS + NONCE_TTL_MS });
    expect(harness.db.nonces).toEqual([
      { rowid: 1, publicKey, nonce: textField(body, 'nonce'), expiresAt: START_MS + NONCE_TTL_MS }
    ]);
  });

  it('sweeps expired nonces and inserts the new nonce in one batch', async () => {
    const harness = createHarness();
    await requestNonce(harness, publicKeyOf(privateKey(1)));
    expect(harness.db.batches).toEqual([[NONCE_SWEEP_SQL, NONCE_INSERT_SQL]]);
    const sweep = harness.db.executed.find(statement => statement.sql === NONCE_SWEEP_SQL);
    expect(sweep?.values).toEqual([START_MS, NONCE_SWEEP_LIMIT]);
  });

  it('sweeps at most 100 expired nonces per request, the oldest first, and keeps live nonces', async () => {
    const harness = createHarness();
    const owner = publicKeyOf(privateKey(9));
    expect(NONCE_SWEEP_LIMIT).toBe(100);
    for (let index = 0; index < 150; index += 1) {
      // Seed in reverse expiry order, so the sweep must sort by expires_at.
      harness.db.seedNonce(owner, index.toString(16).padStart(64, '0'), START_MS - 1 - index);
    }
    harness.db.seedNonce(owner, 'f'.repeat(64), START_MS + 1);
    await requestNonce(harness, publicKeyOf(privateKey(1)));
    const left = harness.db.nonces.filter(nonce => nonce.publicKey === owner);
    expect(left).toHaveLength(51);
    // The 100 oldest (the largest seed indexes) went first. The 50 youngest expired nonces stay.
    const expiredLeft = left.filter(nonce => nonce.expiresAt < START_MS).map(nonce => nonce.expiresAt);
    expect(Math.min(...expiredLeft)).toBe(START_MS - 50);
    expect(Math.max(...expiredLeft)).toBe(START_MS - 1);
    expect(left.some(nonce => nonce.nonce === 'f'.repeat(64))).toBe(true);
    await requestNonce(harness, publicKeyOf(privateKey(1)));
    expect(harness.db.nonces.filter(nonce => nonce.publicKey === owner)).toHaveLength(1);
  });

  it('keeps a nonce that expires at the request time', async () => {
    const harness = createHarness();
    const owner = publicKeyOf(privateKey(9));
    harness.db.seedNonce(owner, 'a'.repeat(64), START_MS);
    await requestNonce(harness, publicKeyOf(privateKey(1)));
    expect(harness.db.nonces.some(nonce => nonce.publicKey === owner)).toBe(true);
  });
});

describe('login flow', () => {
  it('issues a token for a signed nonce, with the profile id and a NULL salt', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const nonce = await requestNonce(harness, publicKey);
    const message = loginMessage(nonce, publicKey);
    const response = await postLogin(harness, publicKey, message, await signMessage(secret, message));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    const profileId = await profileIdFor(publicKey);
    expect(body).toEqual({ accessToken: expect.any(String), expiresIn: TOKEN_TTL_S, profileId, salt: null });
    const profile = harness.db.profile(profileId);
    expect(profile).toMatchObject({ syncPublicKey: publicKey, salt: null, createdAt: START_MS, lastSeenAt: START_MS });
    expect(profile?.generation).toMatch(/^[0-9a-f]{32}$/);
    await expect(verifyToken(SIGNING_KEY, textField(body, 'accessToken'), START_MS)).resolves.toEqual({
      profileId,
      publicKey,
      generation: profile?.generation
    });
    expect(harness.db.nonces).toEqual([]);
  });

  it('issues a token that expires TOKEN_TTL_S after the login second', async () => {
    const harness = createHarness();
    harness.clock.now = START_MS + 999;
    const session = await logIn(harness, privateKey(1));
    const expiry = (Math.floor((START_MS + 999) / 1000) + TOKEN_TTL_S) * 1000;
    await expect(verifyToken(SIGNING_KEY, session.token, expiry - 1)).resolves.toMatchObject({
      profileId: session.profileId
    });
    await expect(verifyToken(SIGNING_KEY, session.token, expiry)).rejects.toMatchObject({
      message: 'The access token has expired.'
    });
  });

  it('refuses a second login with the same nonce', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const message = loginMessage(await requestNonce(harness, publicKey), publicKey);
    const signature = await signMessage(secret, message);
    expect((await postLogin(harness, publicKey, message, signature)).status).toBe(200);
    const reused = await postLogin(harness, publicKey, message, signature);
    expect(reused.status).toBe(401);
    await expect(bodyOf(reused)).resolves.toEqual(NONCE_INVALID);
  });

  it('refuses a signature of another key and spends the nonce', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const message = loginMessage(await requestNonce(harness, publicKey), publicKey);
    const wrong = await postLogin(harness, publicKey, message, await signMessage(privateKey(2), message));
    expect(wrong.status).toBe(401);
    await expect(bodyOf(wrong)).resolves.toEqual(SIGNATURE_INVALID);
    // The bad signature spent the nonce, so the correct signature cannot use it.
    const retry = await postLogin(harness, publicKey, message, await signMessage(secret, message));
    expect(retry.status).toBe(401);
    await expect(bodyOf(retry)).resolves.toEqual(NONCE_INVALID);
    expect(harness.db.profile(await profileIdFor(publicKey))).toBeUndefined();
  });

  it('refuses a signature over another message', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const message = loginMessage(await requestNonce(harness, publicKey), publicKey);
    const response = await postLogin(harness, publicKey, message, await signMessage(secret, `${message}x`));
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual(SIGNATURE_INVALID);
  });

  it('refuses a signature that is not a valid compact signature', async () => {
    const harness = createHarness();
    const publicKey = publicKeyOf(privateKey(1));
    const message = loginMessage(await requestNonce(harness, publicKey), publicKey);
    const response = await postLogin(harness, publicKey, message, 'f'.repeat(128));
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual(SIGNATURE_INVALID);
  });

  it('refuses an expired nonce and accepts it 1 ms before expiry', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const expired = loginMessage(await requestNonce(harness, publicKey), publicKey);
    const live = loginMessage(await requestNonce(harness, publicKey), publicKey);
    harness.clock.advance(NONCE_TTL_MS - 1);
    expect((await postLogin(harness, publicKey, live, await signMessage(secret, live))).status).toBe(200);
    harness.clock.advance(1);
    const response = await postLogin(harness, publicKey, expired, await signMessage(secret, expired));
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual(NONCE_INVALID);
  });

  it('refuses an unknown nonce', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const message = loginMessage('ab'.repeat(32), publicKey);
    const response = await postLogin(harness, publicKey, message, await signMessage(secret, message));
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual(NONCE_INVALID);
  });

  it('refuses a nonce that was issued for another key', async () => {
    const harness = createHarness();
    const nonce = await requestNonce(harness, publicKeyOf(privateKey(1)));
    const secret = privateKey(2);
    const publicKey = publicKeyOf(secret);
    const message = loginMessage(nonce, publicKey);
    const response = await postLogin(harness, publicKey, message, await signMessage(secret, message));
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual(NONCE_INVALID);
    expect(harness.db.nonces).toHaveLength(1);
  });

  it('keeps the profile and its generation on a later login, and updates last_seen_at', async () => {
    const harness = createHarness();
    const first = await logIn(harness, privateKey(1));
    const before = harness.db.profile(first.profileId);
    harness.clock.advance(60_000);
    const second = await logIn(harness, privateKey(1));
    expect(second.profileId).toBe(first.profileId);
    expect(harness.db.profile(first.profileId)).toEqual({ ...before, lastSeenAt: START_MS + 60_000 });
    const firstPrincipal = await verifyToken(SIGNING_KEY, first.token, harness.clock.now);
    const secondPrincipal = await verifyToken(SIGNING_KEY, second.token, harness.clock.now);
    expect(secondPrincipal.generation).toBe(firstPrincipal.generation);
  });

  it('gives two keys two profiles', async () => {
    const harness = createHarness();
    const first = await logIn(harness, privateKey(1));
    const second = await logIn(harness, privateKey(2));
    expect(second.profileId).not.toBe(first.profileId);
  });
});
