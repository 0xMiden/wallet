// The two rate limits. Both count per caller IP, before the route reads the body or calls a chain.
import { ApiError, notConfigured } from './errors';
import type { RequestContext } from './types';

/** The seconds a refused caller waits. Both limits have a period of 60 seconds. */
const RETRY_AFTER_S = 60;

async function charge(limit: RateLimit | undefined, key: string): Promise<void> {
  if (!limit) throw notConfigured();
  const outcome = await limit.limit({ key });
  if (outcome.success !== true) {
    throw new ApiError(
      429,
      'rate_limited',
      'Too many requests. Try again later.',
      { retryAfter: RETRY_AFTER_S },
      { 'Retry-After': String(RETRY_AFTER_S) }
    );
  }
}

function callerOf(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Charge GET /v1/account and GET /v1/relay/{id} to `read:<caller IP>`. */
export function limitRead({ request, env }: RequestContext): Promise<void> {
  return charge(env.READ_RATE_LIMIT, `read:${callerOf(request)}`);
}

/**
 * Charge GET /v1/account also to `read-address:<address>` on the read binding. Many caller IPs that poll one address
 * then share one budget of chain reads.
 */
export function limitReadAddress({ env }: RequestContext, address: string): Promise<void> {
  return charge(env.READ_RATE_LIMIT, `read-address:${address}`);
}

/** Charge POST /v1/relay to `relay:<caller IP>`. */
export function limitRelay({ request, env }: RequestContext): Promise<void> {
  return charge(env.RELAY_RATE_LIMIT, `relay:${callerOf(request)}`);
}
