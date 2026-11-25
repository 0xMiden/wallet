/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import {
  KDF_PARAMS,
  SALT_HEX,
  blobBytes,
  bodyOf,
  createHarness,
  hashedKey,
  logIn,
  loginMessage,
  privateKey,
  publicKeyOf,
  putEntry,
  readyProfile,
  requestNonce,
  send,
  setSalt,
  signMessage,
  toBase64,
  wireEntry
} from './harness';
import { MAX_BODY_BYTES } from '../src/constants';
import { validKdfParams } from '../src/validate';

const OTHER_SALT = 'fedcba9876543210fedcba9876543210';

function badRequest(message: string): { error: string; message: string } {
  return { error: 'bad_request', message };
}

describe('salt set-once', () => {
  it('sets the salt once and returns it, and a later login returns it too', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    const response = await setSalt(harness, session);
    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ salt: SALT_HEX });
    expect(harness.db.profile(session.profileId)?.salt).toBe(SALT_HEX);
    expect((await logIn(harness, privateKey(1))).salt).toBe(SALT_HEX);
  });

  it('refuses a second set with 409 and the stored salt, and keeps the first salt', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    await setSalt(harness, session);
    const second = await setSalt(harness, session, OTHER_SALT);
    expect(second.status).toBe(409);
    await expect(bodyOf(second)).resolves.toEqual({
      error: 'salt_already_set',
      message: 'The profile salt is already set.',
      salt: SALT_HEX
    });
    expect(harness.db.profile(session.profileId)?.salt).toBe(SALT_HEX);
  });

  it('refuses a set of the same salt again with 409', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    await setSalt(harness, session);
    expect((await setSalt(harness, session)).status).toBe(409);
  });

  it.each([
    ['upper case hex', { salt: SALT_HEX.toUpperCase() }],
    ['15 bytes', { salt: SALT_HEX.slice(2) }],
    ['a number', { salt: 1 }]
  ])('refuses a salt of %s', async (_name, body) => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    const response = await send(harness, '/v1/profile/salt', { method: 'PUT', token: session.token, body });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest('salt must be 16 bytes in lowercase hex.'));
  });

  it('refuses a salt body with another field', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    const response = await send(harness, '/v1/profile/salt', {
      method: 'PUT',
      token: session.token,
      body: { salt: SALT_HEX, extra: true }
    });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(
      badRequest('The request body must have exactly these fields: salt.')
    );
  });
});

describe('request body validation', () => {
  it('refuses a body that is not JSON', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body: '{"publicKey":' });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest('The request body is not valid JSON.'));
  });

  it.each(['[]', '"text"', 'null', '1'])('refuses the JSON body %s that is not an object', async body => {
    const harness = createHarness();
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest('The request body must be a JSON object.'));
  });

  it('refuses a request with no body', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST' });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest('The request body is missing.'));
  });

  it('refuses a body over 512 KiB while it reads the stream', async () => {
    const harness = createHarness();
    const body = JSON.stringify({ publicKey: 'a'.repeat(MAX_BODY_BYTES) });
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body });
    expect(response.status).toBe(413);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'payload_too_large',
      message: 'The request body is too large.'
    });
  });

  it('refuses a declared Content-Length over 512 KiB before it reads the body', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/auth/nonce', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) }
    });
    expect(response.status).toBe(413);
    await expect(bodyOf(response)).resolves.toMatchObject({ error: 'payload_too_large' });
  });

  it.each([
    ['upper case hex', publicKeyOf(privateKey(1)).toUpperCase()],
    ['the prefix 04', `04${publicKeyOf(privateKey(1)).slice(2)}`],
    ['32 bytes', publicKeyOf(privateKey(1)).slice(2)],
    ['a number', 7]
  ])('refuses a public key of %s', async (_name, publicKey) => {
    const harness = createHarness();
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body: { publicKey } });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(
      badRequest('publicKey must be a 33-byte compressed secp256k1 key in lowercase hex.')
    );
  });

  it('refuses a public key that is not a point on secp256k1', async () => {
    const harness = createHarness();
    // No point on secp256k1 has the x coordinate 5.
    const publicKey = `02${'5'.padStart(64, '0')}`;
    const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body: { publicKey } });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest('publicKey is not a point on secp256k1.'));
  });

  it('refuses a nonce body with another field', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/auth/nonce', {
      method: 'POST',
      body: { publicKey: publicKeyOf(privateKey(1)), device: 'x' }
    });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(
      badRequest('The request body must have exactly these fields: publicKey.')
    );
  });

  it('refuses login bodies with a bad field, and leaves the nonce unspent', async () => {
    const harness = createHarness();
    const secret = privateKey(1);
    const publicKey = publicKeyOf(secret);
    const nonce = await requestNonce(harness, publicKey);
    const message = loginMessage(nonce, publicKey);
    const signature = await signMessage(secret, message);
    const cases: [object, { error: string; message: string }][] = [
      [
        { publicKey, message },
        badRequest('The request body must have exactly these fields: publicKey, message, signature.')
      ],
      [
        { publicKey, message, signature: signature.toUpperCase() },
        badRequest('signature must be a 64-byte compact signature in lowercase hex.')
      ],
      [
        { publicKey, message, signature: signature.slice(2) },
        badRequest('signature must be a 64-byte compact signature in lowercase hex.')
      ],
      [
        { publicKey, message: loginMessage(nonce, publicKeyOf(privateKey(2))), signature },
        badRequest('message must be miden-sync:login:<nonce>:<publicKey>.')
      ],
      [
        { publicKey, message: `miden-sync:login:${nonce}`, signature },
        badRequest('message must be miden-sync:login:<nonce>:<publicKey>.')
      ],
      [{ publicKey, message: 5, signature }, badRequest('message must be miden-sync:login:<nonce>:<publicKey>.')]
    ];
    for (const [body, expected] of cases) {
      const response = await send(harness, '/v1/auth/login', { method: 'POST', body });
      expect(response.status).toBe(400);
      await expect(bodyOf(response)).resolves.toEqual(expected);
    }
    expect(harness.db.nonces).toHaveLength(1);
  });
});

describe('entry validation', () => {
  it.each([
    ['an envelope of 2', { ...wireEntry(), envelope: 2 }, 'envelope must be 1.'],
    ['a kdfParams of KDF id 1', { ...wireEntry(), kdfParams: KDF_PARAMS | 1 }, 'kdfParams is not valid.'],
    ['a kdfParams of log2(N) 13', { ...wireEntry(), kdfParams: 13 << 4 }, 'kdfParams is not valid.'],
    ['a kdfParams with a reserved bit', { ...wireEntry(), kdfParams: KDF_PARAMS + 2 ** 21 }, 'kdfParams is not valid.'],
    ['a blob that is not padded base64', { ...wireEntry(), blob: 'AAAA-AAA' }, 'blob must be padded base64.'],
    [
      'a blob without padding',
      { ...wireEntry(), blob: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      'blob must be padded base64.'
    ],
    ['a blob of 27 bytes', wireEntry(27), 'The blob must be at least 28 bytes.'],
    [
      'an extra field',
      { ...wireEntry(), note: 'x' },
      'The entry must have exactly these fields: envelope, kdfParams, blob.'
    ]
  ])('refuses %s', async (_name, entry, message) => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const response = await putEntry(harness, session, 'accounts', hashedKey(1), entry);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest(message));
  });

  it('refuses a batch item that is not an object', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const response = await send(harness, '/v1/storage/accounts', {
      method: 'PUT',
      token: session.token,
      body: { entries: [{ hashedKey: hashedKey(1), entry: [] }] }
    });
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest('The entry must be a JSON object.'));
  });

  it.each([
    ['accounts', 4096],
    ['contacts', 4096],
    ['history', 25_600]
  ])('accepts a %s blob of its cap and refuses one byte more with 413', async (feature, cap) => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    expect((await putEntry(harness, session, feature, hashedKey(1), wireEntry(cap))).status).toBe(200);
    const response = await putEntry(harness, session, feature, hashedKey(2), wireEntry(cap + 1));
    expect(response.status).toBe(413);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'payload_too_large',
      message: `The ${feature} blob is larger than ${cap} bytes.`
    });
  });

  it('accepts scrypt kdfParams with log2(N) 14 to 20 and refuses other values', () => {
    expect(validKdfParams(14 << 4)).toBe(true);
    expect(validKdfParams(20 << 4)).toBe(true);
    expect(validKdfParams((20 << 4) | (15 << 9) | (3 << 13))).toBe(true);
    expect(validKdfParams(21 << 4)).toBe(false);
    expect(validKdfParams(-1)).toBe(false);
    expect(validKdfParams(1.5)).toBe(false);
    expect(validKdfParams('272')).toBe(false);
  });

  it('stores the decoded blob bytes', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const blob = blobBytes(29, 200);
    await putEntry(harness, session, 'accounts', hashedKey(1), {
      envelope: 1,
      kdfParams: KDF_PARAMS,
      blob: toBase64(blob)
    });
    expect(harness.db.entriesOf(session.profileId, 'accounts')[0]?.blob).toEqual(blob);
  });
});

describe('batch validation', () => {
  async function putBody(body: object): Promise<Response> {
    const harness = createHarness();
    const session = await readyProfile(harness);
    return send(harness, '/v1/storage/accounts', { method: 'PUT', token: session.token, body });
  }

  it.each([
    ['an empty array', { entries: [] }, 'entries must be a non-empty array.'],
    ['an object for entries', { entries: {} }, 'entries must be a non-empty array.'],
    ['another field', { entries: [], more: 1 }, 'The request body must have exactly these fields: entries.'],
    ['a scalar item', { entries: [1] }, 'Each batch item must be a JSON object.'],
    [
      'an item with another field',
      { entries: [{ hashedKey: hashedKey(1), entry: wireEntry(), extra: 1 }] },
      'The batch item must have exactly these fields: hashedKey, entry.'
    ],
    [
      'an item with a bad key',
      { entries: [{ hashedKey: 'A'.repeat(64), entry: wireEntry() }] },
      'hashedKey must be 64 lowercase hex characters.'
    ],
    [
      'a repeated key',
      {
        entries: [
          { hashedKey: hashedKey(1), entry: wireEntry() },
          { hashedKey: hashedKey(1), entry: wireEntry() }
        ]
      },
      'A batch must not repeat a hashedKey.'
    ]
  ])('refuses %s', async (_name, body, message) => {
    const response = await putBody(body);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual(badRequest(message));
  });

  it('refuses a batch of 101 entries with 413', async () => {
    const entries = Array.from({ length: 101 }, (_unused, index) => ({
      hashedKey: hashedKey(index),
      entry: wireEntry()
    }));
    const response = await putBody({ entries });
    expect(response.status).toBe(413);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'payload_too_large',
      message: 'A batch holds at most 100 entries.'
    });
  });
});

describe('authorization header', () => {
  it.each([
    ['no header', {}],
    ['a Basic header', { Authorization: 'Basic dXNlcjpwYXNz' }],
    ['a Bearer header with spaces in the token', { Authorization: 'Bearer a b' }]
  ])('refuses %s with 401', async (_name, headers) => {
    const harness = createHarness();
    const response = await send(harness, '/v1/storage', { headers });
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'unauthorized',
      message: 'The Authorization header must carry a Bearer token.'
    });
  });

  it('refuses a token that is not valid with 401', async () => {
    const harness = createHarness();
    const response = await send(harness, '/v1/storage', { token: 'a.b.c' });
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'unauthorized',
      message: 'The access token is not valid.'
    });
  });

  it('refuses a token after its expiry', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.clock.advance(3600 * 1000);
    const response = await send(harness, '/v1/storage', { token: session.token });
    expect(response.status).toBe(401);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'unauthorized',
      message: 'The access token has expired.'
    });
  });
});
