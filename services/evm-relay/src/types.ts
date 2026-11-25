// Types of the bindings, the request context and the wire shapes. The config types are in config.ts.

/** The error codes of the API contract (README), and the two codes of a broken deployment. */
export type ErrorCode =
  | 'invalid_request'
  | 'unsupported_chain'
  | 'unsupported_kind'
  | 'token_not_allowed'
  | 'below_minimum'
  | 'fee_too_low'
  | 'bad_signature'
  | 'stale_request'
  | 'simulation_failed'
  | 'busy'
  | 'relayer_unfunded'
  | 'rpc_unavailable'
  | 'rate_limited'
  | 'origin_not_allowed'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'not_implemented'
  | 'service_unavailable'
  | 'internal_error';

/**
 * The Worker bindings. Wrangler can deploy a Worker without a binding or a variable,
 * so each one is optional and the code checks it. /healthz reports a missing one.
 * Later PRs add the secrets RELAYER_PRIVATE_KEY and RPC_URL_<chainId>.
 */
export interface Env {
  /** Per caller IP, on GET /v1/account and GET /v1/relay/{id}. */
  READ_RATE_LIMIT?: RateLimit;
  /** Per caller IP, on POST /v1/relay. */
  RELAY_RATE_LIMIT?: RateLimit;
  ALLOWED_ORIGINS?: string;
  DEPLOYMENT_REVISION?: string;
  GAS_MODE?: string;
  RELAY_CONFIG?: string;
}

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
}

export type Handler = (context: RequestContext) => Response | Promise<Response>;

export interface ErrorBody {
  error: ErrorCode;
  message: string;
  /** Seconds to wait before a retry. */
  retryAfter?: number;
  /** The id of the open relay, on `busy`. */
  id?: string;
}

export interface HealthResponse {
  ok: boolean;
  revision: string;
}
