// Types of the bindings, the request context and the wire shapes. The config types are in config.ts.
import type { ChainReader } from './chain';
import type { GasMode, Hex } from './config';
import type { SenderDirectory } from './sender';
import type { RelaySenderObject } from './sender-object';
import type { RelayKind } from '../../../src/lib/evm-relay/batch';

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
 * The secret `RPC_URL_<chainId>` of each chain has a dynamic name, so it is not a field here: `rpcUrlOf` reads it.
 */
export interface Env {
  /** Per caller IP, on GET /v1/account and GET /v1/relay/{id}. */
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

/** One configured token of the chain. The amounts are decimal strings in base units. */
export interface AccountBalance {
  token: Hex;
  balance: string;
  minAmount: string;
  fee: string;
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
  kinds: Partial<Record<RelayKind, { sequence: string }>>;
  balances: AccountBalance[];
}
