import { Buffer } from 'buffer';

import { createPlatformCredential, getPlatformCredential, signalUnknownPlatformCredential } from './webauthn';

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const rawId = new Uint8Array([1, 2, 3, 4]);
const prf = new Uint8Array(32).fill(19);
const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const id = 'AQIDBA';
const salt = encoded(new Uint8Array(32).fill(7));
let flags = 13;
let createPrf = true;
let getPrf = true;
let wrongRp = false;
let wrongId = false;
let wrongChallenge = false;
let credentialType = 'public-key';
let prfOutput: unknown = prf.buffer;
let authDataLength = 37;
let events: string[] = [];

jest.mock('webextension-polyfill', () => ({ __esModule: true,
  default: { runtime: { getURL: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' } }
}));

class Attestation {
  clientDataJSON = new ArrayBuffer(0);
  attestationObject = new ArrayBuffer(0);
  authData = new ArrayBuffer(0);
  getAuthenticatorData() { return this.authData; }
  getPublicKey() { return null; }
  getPublicKeyAlgorithm() { return -7; }
  getTransports() { return ['internal']; }
}
class Assertion {
  clientDataJSON = new ArrayBuffer(0);
  authenticatorData = new ArrayBuffer(0);
  signature = new ArrayBuffer(64);
  userHandle = null;
}
class CredentialResult {
  id = id;
  rawId = rawId.buffer;
  type = credentialType;
  authenticatorAttachment = 'platform';
  constructor(readonly response: Attestation | Assertion, readonly hasPrf: boolean) {}
  getClientExtensionResults() {
    return { prf: { enabled: this.hasPrf, ...(this.hasPrf ? { results: { first: prfOutput } } : {}) } };
  }
}

async function credential(challenge: BufferSource, create: boolean) {
  const data = new Uint8Array(authDataLength);
  data.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wrongRp ? 'wrong' : origin))));
  data[32] = flags;
  const response = create ? new Attestation() : new Assertion();
  const challengeBytes = ArrayBuffer.isView(challenge)
    ? new Uint8Array(challenge.buffer, challenge.byteOffset, challenge.byteLength) : new Uint8Array(challenge);
  response.clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: create ? 'webauthn.create' : 'webauthn.get', origin,
    challenge: wrongChallenge ? 'wrong' : encoded(challengeBytes), crossOrigin: false
  })).buffer;
  if (response instanceof Attestation) response.authData = data.buffer;
  else response.authenticatorData = data.buffer;
  const result = new CredentialResult(response, create ? createPrf : getPrf);
  if (wrongId) result.id = 'mismatch';
  return result;
}
const create = jest.fn(async (options?: CredentialCreationOptions): Promise<unknown> => {
  if (!options?.publicKey) throw new Error('Missing creation options');
  events.push('create');
  return credential(options.publicKey.challenge, true);
});
const get = jest.fn(async (options?: CredentialRequestOptions): Promise<unknown> => {
  if (!options?.publicKey) throw new Error('Missing request options');
  events.push('get');
  return credential(options.publicKey.challenge, false);
});
const signal = jest.fn(async () => undefined);
const globals = ['PublicKeyCredential', 'AuthenticatorAttestationResponse', 'AuthenticatorAssertionResponse'];
const descriptors = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
const originalCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');

beforeEach(() => {
  flags = 13; createPrf = true; getPrf = true; wrongRp = false; wrongId = false; wrongChallenge = false;
  credentialType = 'public-key'; events = []; prfOutput = prf.buffer; authDataLength = 37;
  create.mockClear(); get.mockClear(); signal.mockClear();
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: CredentialResult });
  Object.defineProperty(globalThis, 'AuthenticatorAttestationResponse', { configurable: true, value: Attestation });
  Object.defineProperty(globalThis, 'AuthenticatorAssertionResponse', { configurable: true, value: Assertion });
  Object.defineProperty(CredentialResult, 'signalUnknownCredential', { configurable: true, value: signal });
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
    create, get, store: jest.fn(), preventSilentAccess: jest.fn()
  } });
});
afterEach(() => {
  globals.forEach((name, i) => {
    const original = descriptors[i];
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
  if (originalCredentials) Object.defineProperty(navigator, 'credentials', originalCredentials);
  else Reflect.deleteProperty(navigator, 'credentials');
});

it('enrolls with required verification and tracks metadata before returning a secret', async () => {
  const tracked: unknown[] = [];
  await expect(createPlatformCredential(null, async (...args) => {
    events.push('track'); tracked.push(args);
  })).resolves.toEqual({ credentialId: id, prfSecret: encoded(prf) });
  expect(events).toEqual(['create', 'track']);
  expect(tracked).toEqual([[id, expect.any(String), true]]);
  const options = create.mock.calls[0][0]?.publicKey;
  expect(options).toMatchObject({
    rp: { name: 'Bread' }, user: { name: 'Bread', displayName: 'Bread' },
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }
  });
  expect(options?.rp.id).toBeUndefined();
  expect(options?.user.id.byteLength).toBe(64);
  expect(options?.challenge.byteLength).toBe(32);
});

it('tracks a created credential before the single fallback get and excludes the previous ID', async () => {
  createPrf = false;
  const result = await createPlatformCredential(id, async () => { events.push('track'); });
  expect(result).toEqual({ credentialId: id, prfSecret: encoded(prf) });
  expect(events).toEqual(['create', 'track', 'get']);
  expect(create.mock.calls[0][0]?.publicKey?.excludeCredentials?.[0].id).toEqual(rawId);
  expect(get.mock.calls[0][0]?.publicKey).toMatchObject({ userVerification: 'required', allowCredentials: [{ id: rawId }] });
});

it('refuses a credential without PRF even when the browser reports capability', async () => {
  createPrf = false; getPrf = false;
  await expect(createPlatformCredential(null, async () => { events.push('track'); })).rejects.toThrow();
  expect(events).toEqual(['create', 'track', 'get']);
});

it.each([1, 9, 12, 0])('refuses authentication without user presence and verification (flags %i)', async value => {
  flags = value;
  await expect(getPlatformCredential(id, salt)).rejects.toThrow();
});

it('uses the supplied ID and salt for a verified get without specifying a web RP ID', async () => {
  await expect(getPlatformCredential(id, salt)).resolves.toEqual({ credentialId: id, prfSecret: encoded(prf) });
  expect(get.mock.calls[0][0]?.publicKey).toMatchObject({
    userVerification: 'required', allowCredentials: [{ id: rawId }],
    extensions: { prf: { eval: { first: new Uint8Array(32).fill(7) } } }
  });
  expect(get.mock.calls[0][0]?.publicKey?.rpId).toBeUndefined();
});

it.each(['rp', 'id', 'challenge', 'type'])('refuses a mismatched %s', async mismatch => {
  wrongRp = mismatch === 'rp'; wrongId = mismatch === 'id'; wrongChallenge = mismatch === 'challenge';
  if (mismatch === 'type') credentialType = 'password';
  await expect(getPlatformCredential(id, salt)).rejects.toThrow();
});

it('tracks the returned ID even if later user-verification validation fails', async () => {
  flags = 1;
  await expect(createPlatformCredential(null, async () => { events.push('track'); })).rejects.toThrow();
  expect(events).toEqual(['create', 'track']);
});

it.each([new ArrayBuffer(31), new ArrayBuffer(33), 'not key material'])(
  'refuses malformed PRF output %#', async output => {
    prfOutput = output;
    await expect(getPlatformCredential(id, salt)).rejects.toThrow();
  }
);

it('refuses a short authenticator header or missing credential', async () => {
  authDataLength = 36;
  await expect(getPlatformCredential(id, salt)).rejects.toThrow();
  get.mockResolvedValueOnce(null);
  await expect(getPlatformCredential(id, salt)).rejects.toThrow();
});

it.each(['NotAllowedError', 'AbortError'])('propagates native %s for password fallback', async name => {
  get.mockRejectedValueOnce(new DOMException('cancelled', name));
  await expect(getPlatformCredential(id, salt)).rejects.toHaveProperty('name', name);
});

it('signals only the requested credential under the full extension RP ID', async () => {
  await signalUnknownPlatformCredential(id);
  expect(signal.mock.calls[0]).toEqual([{ rpId: origin, credentialId: id }]);
  Reflect.deleteProperty(CredentialResult, 'signalUnknownCredential');
  await expect(signalUnknownPlatformCredential(id)).rejects.toThrow();
});
