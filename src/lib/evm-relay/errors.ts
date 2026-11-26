import type { Hex } from 'viem';

/** The error codes of the relay contract and the two codes of a broken deployment. */
export type RelayKnownErrorCode =
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
  | 'not_implemented'
  | 'service_unavailable'
  | 'internal_error';

/** Every known code once. The parser maps a code that is not in this list to `unknown_error`. */
export const RELAY_ERROR_CODES: readonly RelayKnownErrorCode[] = [
  'invalid_request',
  'unsupported_chain',
  'target_not_allowed',
  'fee_too_low',
  'bad_signature',
  'stale_request',
  'simulation_failed',
  'busy',
  'relayer_unfunded',
  'rpc_unavailable',
  'rate_limited',
  'origin_not_allowed',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'not_implemented',
  'service_unavailable',
  'internal_error'
];

/** `unknown_error` replaces a code that this build does not know. */
export type RelayErrorCode = RelayKnownErrorCode | 'unknown_error';

/** An error body of the relay service. */
export class RelayApiError extends Error {
  readonly code: RelayErrorCode;
  readonly status: number;
  /** Seconds to wait before a retry, when the service asks for a wait. */
  readonly retryAfter?: number;
  /** The id of the open relay, on `busy`. */
  readonly id?: Hex;

  constructor(code: RelayErrorCode, status: number, message: string, retryAfter?: number, id?: Hex) {
    super(message);
    this.name = 'RelayApiError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.id = id;
  }
}

/** Why the service gave no usable answer. */
export type RelayUnavailableReason = 'not_configured' | 'network' | 'timeout' | 'bad_response';

/** No base URL, a network failure, a timeout, or a response that does not parse. */
export class RelayUnavailableError extends Error {
  readonly reason: RelayUnavailableReason;

  constructor(reason: RelayUnavailableReason, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'RelayUnavailableError';
    this.reason = reason;
  }
}

/** A service answer that the wallet must not trust: it does not agree with the request or the wallet config. */
export class RelayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayMismatchError';
  }
}

/** Why the wallet refused to sign a batch before it asked the vault. */
export type RelayRefusalReason =
  /** The relayer deducts a fee, and the caller gave no `feeToken`. */
  | 'no-fee-token'
  /** The relayer names no fee for the fee token. */
  | 'no-fee'
  /** The fee is 0, the config has no `maxFee` entry for the token, or the fee is above that entry. */
  | 'fee-not-accepted'
  /** A call goes to a target that the relayer does not allow. */
  | 'target-not-allowed'
  /** The batch has more calls than the relay takes. */
  | 'too-many-calls';

/** The wallet refused to sign a batch: the relayer's terms do not fit the wallet config or the calls. */
export class RelayRefusedError extends Error {
  readonly reason: RelayRefusalReason;

  constructor(reason: RelayRefusalReason) {
    super(`relay: the batch is refused (${reason})`);
    this.name = 'RelayRefusedError';
    this.reason = reason;
  }
}

/** The relayer mined the batch and it reverted. */
export class RelayRevertedError extends Error {
  readonly id: Hex;
  readonly txHash: Hex;

  constructor(id: Hex, txHash: Hex) {
    super(`relay: the batch ${id} reverted in ${txHash}`);
    this.name = 'RelayRevertedError';
    this.id = id;
    this.txHash = txHash;
  }
}

/** The relay job has no final state after the wait. It can still land: follow it by `id`. */
export class RelayStillPendingError extends Error {
  readonly id: Hex;
  /** The last hash that the relayer reported. A fee replacement can change it. */
  readonly txHash: Hex;

  constructor(id: Hex, txHash: Hex) {
    super(`relay: the batch ${id} is still pending (last hash ${txHash})`);
    this.name = 'RelayStillPendingError';
    this.id = id;
    this.txHash = txHash;
  }
}

/**
 * The EIP-1193 error codes of the relay provider: 4200 for a method it does not support, 4100 for a sender that is
 * not the relay address, -32602 for parameters it cannot read. An RPC read keeps the code of the node's error.
 */
export const RELAY_PROVIDER_UNSUPPORTED_METHOD = 4200;
export const RELAY_PROVIDER_UNAUTHORIZED = 4100;
export const RELAY_PROVIDER_INVALID_PARAMS = -32602;

/** An EIP-1193 provider error: viem reads `code` (and `data`) to map it to its own RPC error types. */
export class RelayProviderRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RelayProviderRpcError';
    this.code = code;
    this.data = data;
  }
}

/** `sign-again`: read the account and sign again. `wait`: try again later. `stop`: do not try again. */
export type RelayErrorAction = 'sign-again' | 'wait' | 'stop';

/** What the caller does after a failed relay call. */
export function relayErrorAction(error: unknown): RelayErrorAction {
  if (error instanceof RelayUnavailableError || error instanceof RelayStillPendingError) return 'wait';
  if (!(error instanceof RelayApiError)) return 'stop';
  switch (error.code) {
    case 'stale_request':
    case 'simulation_failed':
      return 'sign-again';
    case 'rate_limited':
    case 'busy':
    case 'relayer_unfunded':
    case 'rpc_unavailable':
    case 'service_unavailable':
    case 'internal_error':
      return 'wait';
    case 'unknown_error':
      // A code from a newer service: its status tells a passing failure from a refusal.
      return error.status === 429 || error.status >= 500 ? 'wait' : 'stop';
    default:
      return 'stop';
  }
}
