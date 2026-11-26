import { ConfigError, parseConfig, type RelayConfig } from '../config';
import { json } from '../http';
import { relayerAddress, rpcUrlOf } from '../secrets';
import type { Env, HealthResponse, RequestContext } from '../types';

function configOf(env: Env): RelayConfig | null {
  try {
    return parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/**
 * True when the variables parse, both rate limit bindings and the Sender binding are present, the relayer key is
 * valid and the `RPC_URL_<chainId>` secret of each served chain is an HTTP(S) URL.
 */
function isReady(env: Env): boolean {
  const config = configOf(env);
  if (config === null) return false;
  const rpcReady = [...config.chains.keys()].every(chainId => rpcUrlOf(env, chainId) !== null);
  const bound = Boolean(env.READ_RATE_LIMIT) && Boolean(env.RELAY_RATE_LIMIT) && Boolean(env.RELAY_SENDER);
  return bound && relayerAddress(env) !== null && rpcReady;
}

/** Report readiness and the revision. Never put a config value or a secret in the body. */
export function healthz({ env }: RequestContext): Response {
  const ready = isReady(env);
  const body: HealthResponse = { ok: ready, revision: env.DEPLOYMENT_REVISION ?? 'unknown' };
  return json(body, ready ? 200 : 503);
}
