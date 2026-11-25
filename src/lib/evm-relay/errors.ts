import type { Hex } from 'viem';

/** The error codes of the relay contract, the two codes of a broken deployment, and `unknown_error`. */
export const RELAY_ERROR_CODES = [
  'invalid_request',
  'unsupported_chain',
  'unsupported_kind',
  'token_not_allowed',
  'below_minimum',
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
] as const;

/** `unknown_error` replaces a code that this build does not know. */
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number] | 'unknown_error';

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

/** `sign-again`: read the account and sign again. `wait`: try again later. `stop`: do not try again. */
export type RelayErrorAction = 'sign-again' | 'wait' | 'stop';

/** What the caller does after a failed relay call. */
export function relayErrorAction(error: unknown): RelayErrorAction {
  if (error instanceof RelayUnavailableError) return 'wait';
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
