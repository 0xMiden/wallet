/**
 * HTTP client of the wallet-api backup service (contract of 2026-10-28).
 *
 * Every call is bounded by a timeout and checks the response shape before it
 * returns it. The server is untrusted input: a shape that does not match is an
 * error, never a partial value. This module keeps no state; the session module
 * owns the token.
 */
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { getBackupBaseUrl } from 'lib/remote-config/values';
import { withRequestTimeout } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import type { EncryptedEntry } from './crypto';

/** The features the server allows, in this order. */
export const BACKUP_FEATURES = ['accounts', 'contacts', 'history'] as const;
export type BackupFeature = (typeof BACKUP_FEATURES)[number];

/** One request, its body read included, ends after this long. */
export const WALLET_API_TIMEOUT_MS = 15_000;
/** A batch PUT carries at most this many entries. */
export const MAX_BATCH_ENTRIES = 100;
/** The server refuses a request body over 512 KiB. The client stays under this, to keep room for the JSON frame. */
export const MAX_REQUEST_BODY_BYTES = 480 * 1024;

export type WalletApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'nonce_invalid'
  | 'signature_invalid'
  | 'salt_not_set'
  | 'salt_already_set'
  | 'unknown_feature'
  | 'payload_too_large'
  | 'entry_limit'
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'service_unavailable';

const ERROR_CODES: readonly WalletApiErrorCode[] = [
  'bad_request',
  'unauthorized',
  'nonce_invalid',
  'signature_invalid',
  'salt_not_set',
  'salt_already_set',
  'unknown_feature',
  'payload_too_large',
  'entry_limit',
  'not_found',
  'forbidden',
  'rate_limited',
  'service_unavailable'
];

/** A response the client did not expect: a status, the server's error code when it gave one, and its message. */
export class WalletApiError extends Error {
  readonly status: number;
  readonly code: WalletApiErrorCode | null;

  constructor(status: number, code: WalletApiErrorCode | null, message: string) {
    super(message);
    this.name = 'WalletApiError';
    this.status = status;
    this.code = code;
  }
}

/** True for a refused token: the session logs in again. */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof WalletApiError && (error.status === 401 || error.code === 'unauthorized');
}

export interface NonceResponse {
  nonce: string;
  expiresAt: number;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  profileId: string;
  /** 16 bytes hex, or null while the profile has no salt. */
  salt: string | null;
}

export interface StorageIndex {
  etag: string;
  features: Partial<Record<BackupFeature, { etag: string }>>;
}

export interface StoredEntry {
  hashedKey: string;
  revision: number;
  updatedAt: number;
  entry: EncryptedEntry;
}

export interface FeatureRead {
  /** The etag of the complete feature, also for a `since` read and on every page. */
  etag: string;
  entries: StoredEntry[];
  /** The hashed key the next page starts after, or null on the last page. */
  next: string | null;
}

export interface EntryAck {
  hashedKey: string;
  revision: number;
  updatedAt: number;
}

/** A conditional read: `null` is a 304, the caller's copy is current. */
export type Conditional<T> = T | null;

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * The `MIDEN_WALLET_API_URL` build define without a trailing slash, when it is
 * an `http` URL on a loopback host: a local Worker for development. Any other
 * value is ignored.
 */
function loopbackOverride(): string | null {
  const raw = process.env.MIDEN_WALLET_API_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) ? trimmed : null;
}

/**
 * The base URL of wallet-api, without a trailing slash. A loopback
 * `MIDEN_WALLET_API_URL` build define goes first, so a local Worker works on
 * every network. Else the accepted wallet-config document of the network
 * supplies it (`backup.baseUrl` while `features.encryptedBackup` is on). Null
 * disables the backup. This reads the realm's snapshot as it is: a path that
 * runs without a user action uses {@link checkWalletApiEnabled} first.
 */
export function getWalletApiBaseUrl(): string | null {
  return loopbackOverride() ?? getBackupBaseUrl();
}

/** The backup needs a base URL. Every public entry point checks this. */
export function isWalletApiEnabled(): boolean {
  return getWalletApiBaseUrl() !== null;
}

/**
 * {@link isWalletApiEnabled} after the realm hydrated its bridge config. A
 * backend handler can run before startup hydrated the snapshot, and the
 * document supplies the base URL. `initBridgeConfig` is idempotent and does not
 * wait for the network. A failed hydration is logged and the check reads the
 * snapshot as it is. Never throws.
 */
export async function checkWalletApiEnabled(): Promise<boolean> {
  try {
    await initBridgeConfig();
  } catch (error) {
    console.warn('[backup] the bridge config could not hydrate', error);
  }
  return isWalletApiEnabled();
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

function isSaltHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_32.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readEncryptedEntry(value: unknown): EncryptedEntry | null {
  if (!isRecord(value)) return null;
  const { envelope, kdfParams, blob } = value;
  if (!isNonNegativeInteger(envelope) || !isNonNegativeInteger(kdfParams) || typeof blob !== 'string') return null;
  return { envelope, kdfParams, blob };
}

function readEntryAck(value: unknown): EntryAck | null {
  if (!isRecord(value)) return null;
  const { hashedKey, revision, updatedAt } = value;
  if (!isHex64(hashedKey) || !isNonNegativeInteger(revision) || revision < 1 || !isNonNegativeInteger(updatedAt)) {
    return null;
  }
  return { hashedKey, revision, updatedAt };
}

function readStoredEntry(value: unknown): StoredEntry | null {
  const ack = readEntryAck(value);
  if (ack === null || !isRecord(value)) return null;
  const entry = readEncryptedEntry(value.entry);
  return entry === null ? null : { ...ack, entry };
}

function readErrorCode(value: unknown): WalletApiErrorCode | null {
  return ERROR_CODES.find(code => code === value) ?? null;
}

function malformed(path: string): WalletApiError {
  return new WalletApiError(200, null, `wallet-api ${path}: the response does not match the contract`);
}

interface RawResponse {
  status: number;
  /** The parsed JSON body, or null for an empty body. */
  body: unknown;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  token?: string;
  body?: string;
  ifNoneMatch?: string | null;
}

async function send(options: RequestOptions): Promise<RawResponse> {
  const base = getWalletApiBaseUrl();
  if (base === null) throw new WalletApiError(0, null, 'wallet-api is not configured');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.ifNoneMatch) headers['If-None-Match'] = `"${options.ifNoneMatch}"`;
  return withRequestTimeout(WALLET_API_TIMEOUT_MS, async signal => {
    const response = await fetch(`${base}${options.path}`, {
      method: options.method,
      headers,
      body: options.body,
      cache: 'no-store',
      credentials: 'omit',
      signal
    });
    const text = response.status === 204 || response.status === 304 ? '' : await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        throw new WalletApiError(response.status, null, `wallet-api ${options.path}: the body is not JSON`);
      }
    }
    return { status: response.status, body };
  });
}

function failure(path: string, response: RawResponse): WalletApiError {
  const code = isRecord(response.body) ? readErrorCode(response.body.error) : null;
  const message =
    isRecord(response.body) && typeof response.body.message === 'string' ? response.body.message : 'request failed';
  return new WalletApiError(response.status, code, `wallet-api ${path} (${response.status}): ${message}`);
}

/** `POST /v1/auth/nonce`. */
export async function requestNonce(publicKey: string): Promise<NonceResponse> {
  const path = '/v1/auth/nonce';
  const response = await send({ method: 'POST', path, body: JSON.stringify({ publicKey }) });
  if (response.status !== 200) throw failure(path, response);
  if (!isRecord(response.body)) throw malformed(path);
  const { nonce, expiresAt } = response.body;
  if (!isHex64(nonce) || !isNonNegativeInteger(expiresAt)) throw malformed(path);
  return { nonce, expiresAt };
}

/** `POST /v1/auth/login`. */
export async function login(publicKey: string, message: string, signature: string): Promise<LoginResponse> {
  const path = '/v1/auth/login';
  const response = await send({ method: 'POST', path, body: JSON.stringify({ publicKey, message, signature }) });
  if (response.status !== 200) throw failure(path, response);
  if (!isRecord(response.body)) throw malformed(path);
  const { accessToken, expiresIn, profileId, salt } = response.body;
  if (!isNonEmptyString(accessToken) || !isNonNegativeInteger(expiresIn) || !isNonEmptyString(profileId)) {
    throw malformed(path);
  }
  if (salt !== null && !isSaltHex(salt)) throw malformed(path);
  return { accessToken, expiresIn, profileId, salt };
}

/**
 * `PUT /v1/profile/salt`. Returns the salt the server stores: the proposed one
 * on 200, the one another device set first on 409. The caller uses only the
 * returned value.
 */
export async function putProfileSalt(token: string, salt: string): Promise<string> {
  const path = '/v1/profile/salt';
  const response = await send({ method: 'PUT', path, token, body: JSON.stringify({ salt }) });
  switch (response.status) {
    case 200:
    case 409: {
      if (!isRecord(response.body)) throw failure(path, response);
      const stored = response.body.salt;
      if (response.status === 409 && readErrorCode(response.body.error) !== 'salt_already_set') {
        throw failure(path, response);
      }
      if (!isSaltHex(stored)) throw malformed(path);
      return stored;
    }
    default:
      throw failure(path, response);
  }
}

/** `GET /v1/storage`, conditional on the full-profile etag. */
export async function getStorageIndex(token: string, ifNoneMatch: string | null): Promise<Conditional<StorageIndex>> {
  const path = '/v1/storage';
  const response = await send({ method: 'GET', path, token, ifNoneMatch });
  if (response.status === 304) return null;
  if (response.status !== 200) throw failure(path, response);
  if (!isRecord(response.body) || !isNonEmptyString(response.body.etag) || !isRecord(response.body.features)) {
    throw malformed(path);
  }
  const features: Partial<Record<BackupFeature, { etag: string }>> = {};
  for (const feature of BACKUP_FEATURES) {
    const value = response.body.features[feature];
    if (value === undefined) continue;
    if (!isRecord(value) || !isNonEmptyString(value.etag)) throw malformed(path);
    features[feature] = { etag: value.etag };
  }
  return { etag: response.body.etag, features };
}

/**
 * `GET /v1/storage/{feature}[?since=][&after=]`: one page of at most the
 * server's page size, conditional on the complete feature etag. `after` is the
 * `next` of the page before; the caller reads pages until `next` is null.
 */
export async function getFeature(
  token: string,
  feature: BackupFeature,
  ifNoneMatch: string | null,
  since: number | null,
  after: string | null = null
): Promise<Conditional<FeatureRead>> {
  const query = new URLSearchParams();
  if (since !== null) query.set('since', String(since));
  if (after !== null) query.set('after', after);
  const search = query.toString();
  const path = `/v1/storage/${feature}${search === '' ? '' : `?${search}`}`;
  const response = await send({ method: 'GET', path, token, ifNoneMatch });
  if (response.status === 304) return null;
  if (response.status !== 200) throw failure(path, response);
  if (!isRecord(response.body) || !isNonEmptyString(response.body.etag) || !Array.isArray(response.body.entries)) {
    throw malformed(path);
  }
  const { next } = response.body;
  if (next !== null && !isHex64(next)) throw malformed(path);
  const entries: StoredEntry[] = [];
  for (const raw of response.body.entries) {
    const entry = readStoredEntry(raw);
    if (entry === null) throw malformed(path);
    entries.push(entry);
  }
  return { etag: response.body.etag, entries, next };
}

/** `GET /v1/storage/{feature}/{hashedKey}`. Null when the entry does not exist. */
export async function getEntry(token: string, feature: BackupFeature, hashedKey: string): Promise<StoredEntry | null> {
  const path = `/v1/storage/${feature}/${hashedKey}`;
  const response = await send({ method: 'GET', path, token });
  if (response.status === 404) return null;
  if (response.status !== 200) throw failure(path, response);
  const entry = readStoredEntry(response.body);
  if (entry === null) throw malformed(path);
  return entry;
}

/** `PUT /v1/storage/{feature}/{hashedKey}`. */
export async function putEntry(
  token: string,
  feature: BackupFeature,
  hashedKey: string,
  entry: EncryptedEntry
): Promise<EntryAck> {
  const path = `/v1/storage/${feature}/${hashedKey}`;
  const response = await send({ method: 'PUT', path, token, body: JSON.stringify(entry) });
  if (response.status !== 200) throw failure(path, response);
  const ack = readEntryAck(response.body);
  if (ack === null || ack.hashedKey !== hashedKey) throw malformed(path);
  return ack;
}

/** `PUT /v1/storage/{feature}` with 1 to 100 entries, all or nothing. */
export async function putEntries(
  token: string,
  feature: BackupFeature,
  entries: readonly { hashedKey: string; entry: EncryptedEntry }[]
): Promise<EntryAck[]> {
  const path = `/v1/storage/${feature}`;
  if (entries.length === 0 || entries.length > MAX_BATCH_ENTRIES) {
    throw new WalletApiError(0, 'bad_request', `wallet-api ${path}: a batch takes 1 to ${MAX_BATCH_ENTRIES} entries`);
  }
  const response = await send({ method: 'PUT', path, token, body: JSON.stringify({ entries }) });
  if (response.status !== 200) throw failure(path, response);
  if (!isRecord(response.body) || !Array.isArray(response.body.entries)) throw malformed(path);
  const acks: EntryAck[] = [];
  for (const raw of response.body.entries) {
    const ack = readEntryAck(raw);
    if (ack === null) throw malformed(path);
    acks.push(ack);
  }
  return acks;
}

/** `DELETE /v1/profile`: the profile and every entry. */
export async function deleteProfile(token: string): Promise<void> {
  const path = '/v1/profile';
  const response = await send({ method: 'DELETE', path, token });
  if (response.status !== 204 && response.status !== 200) throw failure(path, response);
}
