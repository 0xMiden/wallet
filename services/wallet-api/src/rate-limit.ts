// The two rate limits. Auth routes count per caller address, before any work.
// Authenticated routes count per profile, after the token check, on a read key or a write key.
import { RATE_LIMIT_RETRY_S, WRITE_RATE_LIMIT_UNIT_ENTRIES } from './constants';
import { ApiError, notConfigured } from './errors';
import type { Principal, RequestContext } from './types';

function rateLimited(): ApiError {
  return new ApiError(429, 'rate_limited', 'Too many requests. Try again later.', {}, { 'Retry-After': RATE_LIMIT_RETRY_S });
}

/** Apply the auth rate limit to the caller address. */
export async function limitAuth({ request, env }: RequestContext): Promise<void> {
  if (!env.AUTH_RATE_LIMIT) throw notConfigured();
  const caller = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const outcome = await env.AUTH_RATE_LIMIT.limit({ key: `auth:${caller}` });
  if (outcome.success !== true) throw rateLimited();
}

/** Which storage budget a request draws on. A delete is a write. */
export type StorageAccess = 'read' | 'write';

/**
 * Charge `cost` units of the storage rate limit to the profile's read or write
 * key. The binding counts one request per call, so the cost is charged as that
 * many calls; the first refused call ends the charge. Anyone can make a sync key
 * and get a token, so the token alone bounds nothing: this budget does.
 */
export async function limitStorage(
  { env }: RequestContext,
  { profileId }: Principal,
  access: StorageAccess,
  cost = 1
): Promise<void> {
  if (!env.STORAGE_RATE_LIMIT) throw notConfigured();
  for (let unit = 0; unit < cost; unit += 1) {
    const outcome = await env.STORAGE_RATE_LIMIT.limit({ key: `${access}:${profileId}` });
    if (outcome.success !== true) throw rateLimited();
  }
}

/** The cost of a batch write: one unit per started group of entries. */
export function batchWriteCost(entryCount: number): number {
  return Math.max(1, Math.ceil(entryCount / WRITE_RATE_LIMIT_UNIT_ENTRIES));
}
