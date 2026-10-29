import { GENERATION, MIN_SIGNING_KEY_LENGTH, PUBLIC_KEY, UUID, isRecord } from './constants';
import { base64UrlDecode, base64UrlEncode, bytesToHex, encoder, sha256 } from './encoding';
import { notConfigured, unauthorized } from './errors';
import type { Env, Principal, RequestContext, TokenClaims } from './types';

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Import the HS256 key once per isolate. */
export function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ]);
  keyCache.set(secret, key);
  return key;
}

export function validSigningKey(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SIGNING_KEY_LENGTH;
}

export function signingKey(env: Env): string {
  const secret = env.JWT_SIGNING_KEY;
  if (!validSigningKey(secret)) throw notConfigured();
  return secret;
}

export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  if (!isRecord(value)) throw new Error('Invalid token part');
  return value;
}

/** Narrow decoded claims to TokenClaims, or return null. A token without a generation is refused. */
function parseClaims(claims: Record<string, unknown>): TokenClaims | null {
  const { sub, pk, gen, iat, exp } = claims;
  if (typeof sub !== 'string' || !UUID.test(sub) || typeof pk !== 'string' || !PUBLIC_KEY.test(pk)) return null;
  if (typeof gen !== 'string' || !GENERATION.test(gen)) return null;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) {
    return null;
  }
  return { sub, pk, gen, iat, exp };
}

/** Verify an HS256 token and return its principal. */
export async function verifyToken(secret: string, token: string, nowMs: number): Promise<Principal> {
  const [headerPart, claimsPart, signaturePart, ...rest] = token.split('.');
  if (headerPart === undefined || claimsPart === undefined || signaturePart === undefined || rest.length > 0) {
    throw unauthorized('The access token is not valid.');
  }
  let header: Record<string, unknown>;
  let decoded: Record<string, unknown>;
  let valid: boolean;
  try {
    header = decodeJsonPart(headerPart);
    decoded = decodeJsonPart(claimsPart);
    const signature = base64UrlDecode(signaturePart);
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(`${headerPart}.${claimsPart}`));
  } catch {
    throw unauthorized('The access token is not valid.');
  }
  if (!valid || header.alg !== 'HS256') throw unauthorized('The access token is not valid.');
  const claims = parseClaims(decoded);
  if (!claims) throw unauthorized('The access token is not valid.');
  if (claims.exp * 1000 <= nowMs) throw unauthorized('The access token has expired.');
  return { profileId: claims.sub, publicKey: claims.pk, generation: claims.gen };
}

/** Read the Bearer token of the request and return its principal. */
export async function authenticate(context: RequestContext): Promise<Principal> {
  const secret = signingKey(context.env);
  const header = context.request.headers.get('Authorization') ?? '';
  const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header)?.[1];
  if (token === undefined) throw unauthorized('The Authorization header must carry a Bearer token.');
  return verifyToken(secret, token, context.now());
}

/**
 * The profile id of a sync public key: SHA-256 of a tagged string, formatted as a version 4 UUID.
 * The id is stable, so a login after DELETE /v1/profile gets the same id, and the login finds the profile by primary key.
 * The profile generation, not the id, tells a profile made again from the one before it.
 */
export async function profileIdFor(publicKey: string): Promise<string> {
  const hex = bytesToHex((await sha256(encoder.encode(`miden-sync:profile-id:${publicKey}`))).slice(0, 16));
  // Set the version nibble to 4 and the variant bits to 10.
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
