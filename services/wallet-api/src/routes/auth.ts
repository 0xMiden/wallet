import { secp256k1 } from '@noble/curves/secp256k1';
import { NONCE_TTL_MS, TOKEN_TTL_S } from '../constants';
import { database } from '../db';
import { bytesToHex, encoder, hexToBytes, sha256 } from '../encoding';
import { ApiError } from '../errors';
import { json, readJson } from '../http';
import { limitAuth } from '../rate-limit';
import { parseProfileRow } from '../rows';
import { SPEND_NONCE, UPSERT_PROFILE } from '../sql';
import { profileIdFor, signToken, signingKey } from '../token';
import type { LoginResponse, NonceResponse, RequestContext } from '../types';
import { parseLoginRequest, parseNonceRequest } from '../validate';

/** The most expired nonces one nonce request sweeps, so a backlog cannot delay a login. */
export const NONCE_SWEEP_LIMIT = 100;

/** Issue a nonce. The same batch deletes a bounded number of expired nonces, through the expiry index. */
export async function issueNonce(context: RequestContext): Promise<Response> {
  const db = database(context.env);
  await limitAuth(context);
  const { publicKey } = parseNonceRequest(await readJson(context.request));
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const now = context.now();
  const expiresAt = now + NONCE_TTL_MS;
  await db.batch([
    db
      .prepare(
        'DELETE FROM auth_nonces WHERE rowid IN (SELECT rowid FROM auth_nonces WHERE expires_at < ? ORDER BY expires_at LIMIT ?)'
      )
      .bind(now, NONCE_SWEEP_LIMIT),
    db
      .prepare('INSERT INTO auth_nonces (public_key, nonce, expires_at) VALUES (?, ?, ?)')
      .bind(hexToBytes(publicKey), nonce, expiresAt)
  ]);
  const body: NonceResponse = { nonce: bytesToHex(nonce), expiresAt };
  return json(body);
}

export function verifySignature(signatureHex: string, digest: Uint8Array, publicKeyBytes: Uint8Array): boolean {
  try {
    return secp256k1.verify(hexToBytes(signatureHex), digest, publicKeyBytes, {
      lowS: false,
      prehash: false,
      format: 'compact'
    });
  } catch {
    return false;
  }
}

/**
 * Log in. A new profile takes a random generation; a profile that exists keeps
 * its own. The token carries the profile's generation, so a token issued before
 * a profile delete cannot touch the profile a later login makes again.
 */
export async function login(context: RequestContext): Promise<Response> {
  const db = database(context.env);
  const secret = signingKey(context.env);
  await limitAuth(context);
  const { publicKey, message, signature, nonce } = parseLoginRequest(await readJson(context.request));
  const now = context.now();
  const publicKeyBytes = hexToBytes(publicKey);
  // Spend the nonce before the signature check. A bad signature also spends it.
  const spent = await db.prepare(SPEND_NONCE).bind(publicKeyBytes, hexToBytes(nonce), now).first();
  if (spent === null) {
    throw new ApiError(401, 'nonce_invalid', 'The nonce is unknown, used or expired. Ask for a new nonce.');
  }
  const digest = await sha256(encoder.encode(message));
  if (!verifySignature(signature, digest, publicKeyBytes)) {
    throw new ApiError(401, 'signature_invalid', 'The signature does not match the public key.');
  }
  const profileId = await profileIdFor(publicKey);
  const proposedGeneration = crypto.getRandomValues(new Uint8Array(16));
  const row = await db.prepare(UPSERT_PROFILE).bind(profileId, publicKeyBytes, now, proposedGeneration).first();
  if (row === null) throw new Error('Profile upsert returned no row');
  const profile = parseProfileRow(row);
  if (bytesToHex(profile.syncPublicKey) !== publicKey) throw new Error('Profile id collision');
  const iat = Math.floor(now / 1000);
  const accessToken = await signToken(secret, {
    sub: profileId,
    pk: publicKey,
    gen: bytesToHex(profile.generation),
    iat,
    exp: iat + TOKEN_TTL_S
  });
  const body: LoginResponse = {
    accessToken,
    expiresIn: TOKEN_TTL_S,
    profileId,
    salt: profile.salt === null ? null : bytesToHex(profile.salt)
  };
  return json(body);
}
