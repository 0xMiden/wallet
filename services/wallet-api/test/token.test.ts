/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { SIGNING_KEY, START_MS, privateKey, publicKeyOf, sha256HexOf, toBase64 } from './harness';
import { UUID } from '../src/constants';
import { profileIdFor, signToken, verifyToken } from '../src/token';
import type { TokenClaims } from '../src/types';

const PROFILE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GENERATION = '00112233445566778899aabbccddeeff';
const IAT = Math.floor(START_MS / 1000);

function claims(): TokenClaims {
  return { sub: PROFILE_ID, pk: publicKeyOf(privateKey(1)), gen: GENERATION, iat: IAT, exp: IAT + 3600 };
}

function base64Url(text: string): string {
  return toBase64(new TextEncoder().encode(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign any header and payload with HS256, without the claim checks of signToken. */
async function signRaw(secret: string, header: object, payload: object): Promise<string> {
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
  let binary = '';
  signature.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return `${input}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const HS256 = { alg: 'HS256', typ: 'JWT' };
const INVALID = { status: 401, code: 'unauthorized', message: 'The access token is not valid.' };

describe('token sign and verify', () => {
  it('returns the principal of a token that signToken made', async () => {
    const token = await signToken(SIGNING_KEY, claims());
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).resolves.toEqual({
      profileId: PROFILE_ID,
      publicKey: publicKeyOf(privateKey(1)),
      generation: GENERATION
    });
  });

  it('accepts a raw HS256 token with the same claims', async () => {
    const token = await signRaw(SIGNING_KEY, HS256, claims());
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).resolves.toMatchObject({ generation: GENERATION });
  });

  it('refuses a token with a signature of another key', async () => {
    const token = await signToken('another-signing-key-with-32-characters-at-least', claims());
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });

  it('refuses a token whose payload changed after the signature', async () => {
    const [header, , signature] = (await signToken(SIGNING_KEY, claims())).split('.');
    const forged = `${header}.${base64Url(JSON.stringify({ ...claims(), gen: 'ffeeddccbbaa99887766554433221100' }))}`;
    await expect(verifyToken(SIGNING_KEY, `${forged}.${signature}`, START_MS)).rejects.toMatchObject(INVALID);
  });

  it('refuses a token whose signature bytes changed', async () => {
    const [header, payload] = (await signToken(SIGNING_KEY, claims())).split('.');
    const zeros = base64Url(String.fromCharCode(...new Uint8Array(32)));
    await expect(verifyToken(SIGNING_KEY, `${header}.${payload}.${zeros}`, START_MS)).rejects.toMatchObject(INVALID);
  });

  it.each([
    ['two parts', 'a.b'],
    ['four parts', 'a.b.c.d'],
    ['a part that is not base64url', 'a.b.c$'],
    ['a payload that is not JSON', `${base64Url(JSON.stringify(HS256))}.${base64Url('not json')}.c`]
  ])('refuses a token with %s', async (_name, token) => {
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });

  it('refuses a correctly signed payload that is a JSON array', async () => {
    const token = await signRaw(SIGNING_KEY, HS256, [claims()]);
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });

  it.each([{ alg: 'none' }, { alg: 'HS512', typ: 'JWT' }, { typ: 'JWT' }])(
    'refuses the header %j even with a valid HMAC',
    async header => {
      const token = await signRaw(SIGNING_KEY, header, claims());
      await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
    }
  );

  it('refuses a token at its expiry and accepts it 1 ms before', async () => {
    const token = await signToken(SIGNING_KEY, claims());
    const expiry = (IAT + 3600) * 1000;
    await expect(verifyToken(SIGNING_KEY, token, expiry - 1)).resolves.toMatchObject({ profileId: PROFILE_ID });
    await expect(verifyToken(SIGNING_KEY, token, expiry)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'The access token has expired.'
    });
  });

  it.each([
    ['upper case hex', '00112233445566778899AABBCCDDEEFF'],
    ['15 bytes', '00112233445566778899aabbccddee'],
    ['17 bytes', '00112233445566778899aabbccddeeff00'],
    ['an empty string', '']
  ])('refuses a gen claim of %s', async (_name, gen) => {
    const token = await signToken(SIGNING_KEY, { ...claims(), gen });
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });

  it('refuses a gen claim that is a number', async () => {
    const token = await signRaw(SIGNING_KEY, HS256, { ...claims(), gen: 1 });
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });

  it.each(['sub', 'pk', 'gen', 'iat', 'exp'])('refuses a token without the %s claim', async name => {
    const payload = Object.fromEntries(Object.entries(claims()).filter(([key]) => key !== name));
    const token = await signRaw(SIGNING_KEY, HS256, payload);
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });

  it.each([
    ['a sub that is not a version 4 UUID', { sub: '0f8fad5b-d9cb-169f-a165-70867728950e' }],
    ['a pk in upper case', { pk: publicKeyOf(privateKey(1)).toUpperCase() }],
    ['an iat that is not an integer', { iat: IAT + 0.5 }],
    ['an exp that is a string', { exp: String(IAT + 3600) }]
  ])('refuses %s', async (_name, change) => {
    const token = await signRaw(SIGNING_KEY, HS256, { ...claims(), ...change });
    await expect(verifyToken(SIGNING_KEY, token, START_MS)).rejects.toMatchObject(INVALID);
  });
});

describe('profile id', () => {
  it('is the tagged SHA-256 of the public key, formatted as a version 4 UUID', async () => {
    const publicKey = publicKeyOf(privateKey(1));
    const hex = (await sha256HexOf(`miden-sync:profile-id:${publicKey}`)).slice(0, 32);
    const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
    const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
    const id = await profileIdFor(publicKey);
    expect(id).toBe(expected);
    expect(id).toMatch(UUID);
  });

  it('is stable for one key and different for another key', async () => {
    const first = await profileIdFor(publicKeyOf(privateKey(1)));
    await expect(profileIdFor(publicKeyOf(privateKey(1)))).resolves.toBe(first);
    await expect(profileIdFor(publicKeyOf(privateKey(2)))).resolves.not.toBe(first);
  });
});
