import { ConfigError, parseConfig } from '../config';
import { json } from '../http';
import type { Env, HealthResponse, RequestContext } from '../types';

/** True when the variables parse and both rate limit bindings are present. */
function isReady(env: Env): boolean {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
  return Boolean(env.READ_RATE_LIMIT) && Boolean(env.RELAY_RATE_LIMIT);
}

/** Report readiness and the revision. Never put a config value or a secret in the body. */
export function healthz({ env }: RequestContext): Response {
  const ready = isReady(env);
  const body: HealthResponse = { ok: ready, revision: env.DEPLOYMENT_REVISION ?? 'unknown' };
  return json(body, ready ? 200 : 503);
}
