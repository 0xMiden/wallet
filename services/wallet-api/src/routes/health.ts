import { json } from '../http';
import { validSigningKey } from '../token';
import type { HealthResponse, RequestContext } from '../types';

/** Report readiness: the database, the two rate limits and the signing key are present. */
export function healthz({ env }: RequestContext): Response {
  const ready =
    Boolean(env.DB) &&
    Boolean(env.AUTH_RATE_LIMIT) &&
    Boolean(env.STORAGE_RATE_LIMIT) &&
    validSigningKey(env.JWT_SIGNING_KEY);
  const body: HealthResponse = { ok: ready, revision: env.DEPLOYMENT_REVISION ?? 'unknown' };
  return json(body, ready ? 200 : 503);
}
