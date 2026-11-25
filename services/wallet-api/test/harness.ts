// Shared helpers of the wallet-api unit tests: the service with fake bindings, the requests and the login flow.
import { secp256k1 } from '@noble/curves/secp256k1';

import { FakeD1, FakeRateLimit } from './fake-d1';
import { isRecord } from '../src/constants';
import { createService } from '../src/index';
import type { Service } from '../src/index';
import type { Env } from '../src/types';

export const SIGNING_KEY = 'test-signing-key-with-at-least-32-characters';
export const ORIGIN = 'chrome-extension://wallet-test';
export const BASE_URL = 'https://wallet-api.test';
/** A Unix ms time with no special meaning. Each harness starts at it. */
export const START_MS = 1_800_000_000_000;
/** kdfParams of scrypt with log2(N) = 17. */
export const KDF_PARAMS = 17 << 4;

export class Clock {
  constructor(public now: number = START_MS) {}

  advance(ms: number): void {
    this.now += ms;
  }
}

/** Which bindings the env holds. Every one is present when the option is absent. */
export interface EnvOptions {
  db?: boolean;
  authLimit?: boolean;
  storageLimit?: boolean;
  signingKey?: string | null;
  allowedOrigins?: string;
  revision?: string | null;
}

export interface Harness {
  service: Service;
  env: Env;
  db: FakeD1;
  authLimit: FakeRateLimit;
  storageLimit: FakeRateLimit;
  /** The Worker clock. */
  clock: Clock;
  /** The database clock of the julianday expression. */
  dbClock: Clock;
}

export function createHarness(options: EnvOptions = {}): Harness {
  const clock = new Clock();
  const dbClock = new Clock();
  const db = new FakeD1(() => dbClock.now);
  const authLimit = new FakeRateLimit();
  const storageLimit = new FakeRateLimit();
  const env: Env = { ALLOWED_ORIGINS: options.allowedOrigins ?? JSON.stringify([ORIGIN]) };
  if (options.db !== false) env.DB = db;
  if (options.authLimit !== false) env.AUTH_RATE_LIMIT = authLimit;
  if (options.storageLimit !== false) env.STORAGE_RATE_LIMIT = storageLimit;
  const signingKey = options.signingKey === undefined ? SIGNING_KEY : options.signingKey;
  if (signingKey !== null) env.JWT_SIGNING_KEY = signingKey;
  const revision = options.revision === undefined ? 'test-revision' : options.revision;
  if (revision !== null) env.DEPLOYMENT_REVISION = revision;
  const service = createService({ now: () => clock.now });
  return { service, env, db, authLimit, storageLimit, clock, dbClock };
}

export interface RequestOptions {
  method?: string;
  /** A string is sent as it is. An object is sent as JSON. */
  body?: string | object;
  token?: string;
  headers?: Record<string, string>;
}

export function apiRequest(path: string, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  const { body } = options;
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${BASE_URL}${path}`, init);
}

export function send(harness: Harness, path: string, options: RequestOptions = {}): Promise<Response> {
  return harness.service.fetch(apiRequest(path, options), harness.env);
}

// ---------------------------------------------------------------- JSON bodies

/** Read the response body as a JSON object. Fail the test when it is another value. */
export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('The response body is not a JSON object');
  return value;
}

export function textField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string') throw new Error(`The field ${name} is not a string`);
  return value;
}

export function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== 'number') throw new Error(`The field ${name} is not a number`);
  return value;
}

export function recordsField(body: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = body[name];
  if (!Array.isArray(value)) throw new Error(`The field ${name} is not an array`);
  return value.map((item: unknown) => {
    if (!isRecord(item)) throw new Error(`An item of ${name} is not an object`);
    return item;
  });
}

// ---------------------------------------------------------------- bytes and keys

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export async function sha256HexOf(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** A hashed key: the number in 64 hex characters, so the keys sort like the numbers. */
export function hashedKey(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/** Bytes of a blob. Each byte holds `fill`. */
export function blobBytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** An entry on the wire with a valid envelope and kdfParams. */
export function wireEntry(length = 28, fill = 7): { envelope: number; kdfParams: number; blob: string } {
  return { envelope: 1, kdfParams: KDF_PARAMS, blob: toBase64(blobBytes(length, fill)) };
}

/** A fixed private key. Each seed gives another key. */
export function privateKey(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

export function publicKeyOf(secret: Uint8Array): string {
  return toHex(secp256k1.getPublicKey(secret, true));
}

export function loginMessage(nonce: string, publicKey: string): string {
  return `miden-sync:login:${nonce}:${publicKey}`;
}

/** A 64-byte compact signature over the SHA-256 of the message. */
export async function signMessage(secret: Uint8Array, message: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)));
  return secp256k1.sign(digest, secret).toCompactHex();
}

// ---------------------------------------------------------------- login

export async function requestNonce(harness: Harness, publicKey: string): Promise<string> {
  const response = await send(harness, '/v1/auth/nonce', { method: 'POST', body: { publicKey } });
  if (response.status !== 200) throw new Error(`The nonce request failed with ${response.status}`);
  return textField(await bodyOf(response), 'nonce');
}

export interface Session {
  token: string;
  profileId: string;
  publicKey: string;
  salt: string | null;
}

/** Get a nonce, sign the login message and log in. */
export async function logIn(harness: Harness, secret: Uint8Array): Promise<Session> {
  const publicKey = publicKeyOf(secret);
  const nonce = await requestNonce(harness, publicKey);
  const message = loginMessage(nonce, publicKey);
  const signature = await signMessage(secret, message);
  const response = await send(harness, '/v1/auth/login', { method: 'POST', body: { publicKey, message, signature } });
  if (response.status !== 200) throw new Error(`The login failed with ${response.status}`);
  const body = await bodyOf(response);
  const salt = body.salt;
  return {
    token: textField(body, 'accessToken'),
    profileId: textField(body, 'profileId'),
    publicKey,
    salt: typeof salt === 'string' ? salt : null
  };
}

export const SALT_HEX = '0123456789abcdef0123456789abcdef';

export async function setSalt(harness: Harness, session: Session, salt = SALT_HEX): Promise<Response> {
  return send(harness, '/v1/profile/salt', { method: 'PUT', token: session.token, body: { salt } });
}

/** Log in and set the salt, so the profile accepts entries. */
export async function readyProfile(harness: Harness, seed = 1): Promise<Session> {
  const session = await logIn(harness, privateKey(seed));
  const response = await setSalt(harness, session);
  if (response.status !== 200) throw new Error(`The salt set failed with ${response.status}`);
  return { ...session, salt: SALT_HEX };
}

export function putEntry(
  harness: Harness,
  session: Session,
  feature: string,
  key: string,
  entry: object = wireEntry()
): Promise<Response> {
  return send(harness, `/v1/storage/${feature}/${key}`, { method: 'PUT', token: session.token, body: entry });
}

export function putBatch(
  harness: Harness,
  session: Session,
  feature: string,
  keys: readonly string[]
): Promise<Response> {
  const entries = keys.map(key => ({ hashedKey: key, entry: wireEntry() }));
  return send(harness, `/v1/storage/${feature}`, { method: 'PUT', token: session.token, body: { entries } });
}
