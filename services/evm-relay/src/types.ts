// Types of the bindings, the request context and the wire shapes. The config types are in config.ts.
import type { ChainReader } from './chain';
import type { GasMode, Hex } from './config';
import type { SenderDirectory } from './sender';
import type { RelaySenderObject } from './sender-object';

/** The error codes of the API contract (README), and the two codes of a broken deployment. */
export type ErrorCode =
  | 'invalid_request'
  | 'unsupported_chain'
  | 'target_not_allowed'
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
  | 'service_unavailable'
  | 'internal_error';

/**
 * The Worker bindings. Wrangler can deploy a Worker without a binding or a variable,
 * so each one is optional and the code checks it. /healthz reports a missing one.
 * The secret `RPC_URL_<chainId>` of each chain has a dynamic name, so it is not a field here: `rpcUrlOf` reads it.
 * The chains that have this secret are the chains that the Worker serves (`servedChainIds` in config.ts).
 */
export interface Env {
  /** Per caller IP, on GET /v1/chains, GET /v1/account and GET /v1/relay/{id}. */
  READ_RATE_LIMIT?: RateLimit;
  /** Per caller IP and per address, on POST /v1/relay. */
  RELAY_RATE_LIMIT?: RateLimit;
  /** The Sender Durable Objects, one per chain. */
  RELAY_SENDER?: DurableObjectNamespace<RelaySenderObject>;
  ALLOWED_ORIGINS?: string;
  DEPLOYMENT_REVISION?: string;
  GAS_MODE?: string;
  RELAY_CONFIG?: string;
  /** Secret: the key of the relayer account, `0x` and 64 hex characters. */
  RELAYER_PRIVATE_KEY?: string;
}

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  reader: ChainReader;
  senders: SenderDirectory;
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

/** The balance of one token of the `tokens` query, a decimal string in base units. */
export interface AccountBalance {
  token: Hex;
  balance: string;
}

/** The fee of one token, a decimal string in base units. */
export interface AccountFee {
  token: Hex;
  fee: string;
}

/** The body of `GET /v1/chains`. It has no RPC URL and no config value. */
export interface ChainsResponse {
  mode: GasMode;
  /** The relayer address, the same value as the `executor` of `GET /v1/account`. */
  executor: Hex;
  /** The served chain ids in ascending order: each chain with an `RPC_URL_<chainId>` secret. */
  chains: number[];
}

/** The body of `GET /v1/account`. */
export interface AccountResponse {
  chainId: number;
  address: Hex;
  mode: GasMode;
  executor: Hex;
  feeRecipient: Hex | null;
  needsAuthorization: boolean;
  authorizationNonce: number;
  salt: Hex;
  /** `getSeq(RELAY_NONCE_KEY)` of the address, as a decimal string. */
  sequence: string;
  /** The configured fees in config order in `deduct` mode. Empty in `sponsor` mode. */
  fees: AccountFee[];
  /** The allowed call targets of the chain, or null when any target is allowed. */
  allowedTargets: Hex[] | null;
  /** One balance for each token of the `tokens` query, in query order. */
  balances: AccountBalance[];
}
