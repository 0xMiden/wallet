import { secp256k1 } from '@noble/curves/secp256k1';
import {
  BASE64,
  BLOB_CAP_BYTES,
  DECIMAL,
  ENVELOPE_VERSION,
  HEX64,
  KDF_SCRYPT,
  LOGIN_MESSAGE,
  MAX_BATCH_ENTRIES,
  MAX_PAGE_ENTRIES,
  MIN_BLOB_BYTES,
  PUBLIC_KEY,
  RESERVED_KDF_BITS_FROM,
  SALT,
  SIGNATURE,
  isRecord
} from './constants';
import { base64Length, decodeBase64 } from './encoding';
import { badRequest, tooLarge } from './errors';
import { expectKeys } from './http';
import type { BatchItem, DecodedEntry, Feature, LoginRequest, NonceRequest, ReadPage, SaltRequest } from './types';

export function parsePublicKey(value: unknown): string {
  if (typeof value !== 'string' || !PUBLIC_KEY.test(value)) {
    throw badRequest('publicKey must be a 33-byte compressed secp256k1 key in lowercase hex.');
  }
  try {
    secp256k1.ProjectivePoint.fromHex(value).assertValidity();
  } catch {
    throw badRequest('publicKey is not a point on secp256k1.');
  }
  return value;
}

export function parseHashedKey(value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) throw badRequest('hashedKey must be 64 lowercase hex characters.');
  return value;
}

export function parseNonceRequest(body: Record<string, unknown>): NonceRequest {
  expectKeys(body, ['publicKey'], 'request body');
  return { publicKey: parsePublicKey(body.publicKey) };
}

/** Validate the login body. Take the nonce hex from the message. */
export function parseLoginRequest(body: Record<string, unknown>): LoginRequest {
  expectKeys(body, ['publicKey', 'message', 'signature'], 'request body');
  const publicKey = parsePublicKey(body.publicKey);
  const { message, signature } = body;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    throw badRequest('signature must be a 64-byte compact signature in lowercase hex.');
  }
  const match = typeof message === 'string' ? LOGIN_MESSAGE.exec(message) : null;
  const nonce = match?.[1];
  if (typeof message !== 'string' || nonce === undefined || match?.[2] !== publicKey) {
    throw badRequest('message must be miden-sync:login:<nonce>:<publicKey>.');
  }
  return { publicKey, message, signature, nonce };
}

export function parseSaltRequest(body: Record<string, unknown>): SaltRequest {
  expectKeys(body, ['salt'], 'request body');
  if (typeof body.salt !== 'string' || !SALT.test(body.salt)) throw badRequest('salt must be 16 bytes in lowercase hex.');
  return { salt: body.salt };
}

/**
 * Validate the packed KDF parameters. Bits 21 to 31 are reserved and must be 0.
 * Only KDF id 0 (scrypt) is known. log2(N) must be 14 to 20.
 * The field widths keep r in 1 to 16 and p in 1 to 4.
 */
export function validKdfParams(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= RESERVED_KDF_BITS_FROM) {
    return false;
  }
  if ((value & 0xf) !== KDF_SCRYPT) return false;
  const logN = (value >>> 4) & 0x1f;
  return logN >= 14 && logN <= 20;
}

/** Validate one encrypted entry and decode its blob. */
export function parseEntry(value: unknown, feature: Feature): DecodedEntry {
  if (!isRecord(value)) throw badRequest('The entry must be a JSON object.');
  expectKeys(value, ['envelope', 'kdfParams', 'blob'], 'entry');
  const { envelope, kdfParams, blob } = value;
  if (envelope !== ENVELOPE_VERSION) throw badRequest('envelope must be 1.');
  if (!validKdfParams(kdfParams)) throw badRequest('kdfParams is not valid.');
  if (typeof blob !== 'string' || !BASE64.test(blob)) throw badRequest('blob must be padded base64.');
  const length = base64Length(blob);
  const cap = BLOB_CAP_BYTES[feature];
  if (length > cap) throw tooLarge(`The ${feature} blob is larger than ${cap} bytes.`);
  if (length < MIN_BLOB_BYTES) throw badRequest(`The blob must be at least ${MIN_BLOB_BYTES} bytes.`);
  return { envelope: ENVELOPE_VERSION, kdfParams, blob: decodeBase64(blob) };
}

const PAGE_PARAMETERS: readonly string[] = ['since', 'after', 'limit'];

/**
 * The page of a feature read: the inclusive `since` cursor, the hashed key the
 * page starts after, and the page size (1 to MAX_PAGE_ENTRIES, MAX_PAGE_ENTRIES
 * when absent). Each parameter at most once, no other parameter.
 */
export function parseReadPage(url: URL): ReadPage {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !PAGE_PARAMETERS.includes(key)) || new Set(keys).size !== keys.length) {
    throw badRequest(`The query parameters are ${PAGE_PARAMETERS.join(', ')}, each at most once.`);
  }
  const since = url.searchParams.get('since');
  if (since !== null && (!DECIMAL.test(since) || !Number.isSafeInteger(Number(since)))) {
    throw badRequest('since must be a Unix ms integer.');
  }
  const after = url.searchParams.get('after');
  if (after !== null && !HEX64.test(after)) throw badRequest('after must be 64 lowercase hex characters.');
  const limit = url.searchParams.get('limit');
  if (limit !== null && (!DECIMAL.test(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE_ENTRIES)) {
    throw badRequest(`limit must be 1 to ${MAX_PAGE_ENTRIES}.`);
  }
  return {
    since: since === null ? null : Number(since),
    after,
    limit: limit === null ? MAX_PAGE_ENTRIES : Number(limit)
  };
}

/** Validate the items of a batch PUT. */
export function parseBatch(body: Record<string, unknown>, feature: Feature): BatchItem[] {
  expectKeys(body, ['entries'], 'request body');
  const { entries } = body;
  if (!Array.isArray(entries) || entries.length === 0) throw badRequest('entries must be a non-empty array.');
  if (entries.length > MAX_BATCH_ENTRIES) throw tooLarge(`A batch holds at most ${MAX_BATCH_ENTRIES} entries.`);
  const seen = new Set<string>();
  return entries.map((item: unknown): BatchItem => {
    if (!isRecord(item)) throw badRequest('Each batch item must be a JSON object.');
    expectKeys(item, ['hashedKey', 'entry'], 'batch item');
    const hashedKey = parseHashedKey(item.hashedKey);
    if (seen.has(hashedKey)) throw badRequest('A batch must not repeat a hashedKey.');
    seen.add(hashedKey);
    return { hashedKey, entry: parseEntry(item.entry, feature) };
  });
}
