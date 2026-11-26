import type { Hex } from 'viem';

import type { RelayJobRef } from './types';

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
  /** The relayer deducts a fee, and the caller gave no reviewed fee. */
  | 'no-reviewed-fee'
  /** The relayer sponsors the gas, and the caller gave a reviewed fee: the review and the service disagree. */
  | 'unexpected-fee'
  /** The relayer names no fee for the fee token. */
  | 'no-fee'
  /** The relayer's current fee is above the reviewed fee. A new review is necessary. */
  | 'fee-changed'
  /** The fee is 0, the config has no `maxFee` entry for the token, or the fee is above that entry. */
  | 'fee-not-accepted'
  /** A call goes to a target that the relayer does not allow. */
  | 'target-not-allowed'
  /** The batch has more calls than the relay takes. */
  | 'too-many-calls';

/** The wallet refused to sign a batch: the relayer's terms do not fit the wallet config, the review or the calls. */
export class RelayRefusedError extends Error {
  readonly reason: RelayRefusalReason;

  constructor(reason: RelayRefusalReason) {
    super(`relay: the batch is refused (${reason})`);
    this.name = 'RelayRefusedError';
    this.reason = reason;
  }
}

/** The relayer mined the batch and it reverted. The attempt is over. */
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

/**
 * The relayer did not execute the batch before its deadline and cancelled its transaction. The batch never executes.
 * The attempt is over.
 */
export class RelayExpiredError extends Error {
  readonly id: Hex;
  /** The hash of the relayer's cancel transaction. */
  readonly txHash: Hex;

  constructor(id: Hex, txHash: Hex) {
    super(`relay: the batch ${id} expired (cancel transaction ${txHash})`);
    this.name = 'RelayExpiredError';
    this.id = id;
    this.txHash = txHash;
  }
}

/** The relay job has no final state after the wait. It can still land: follow it with `resume(job)`. */
export class RelayStillPendingError extends Error {
  readonly job: RelayJobRef;
  readonly id: Hex;
  /** The last hash that the relayer reported. A fee replacement can change it. */
  readonly txHash: Hex;

  constructor(job: RelayJobRef, txHash: Hex) {
    super(`relay: the batch ${job.id} is still pending (last hash ${txHash})`);
    this.name = 'RelayStillPendingError';
    this.job = job;
    this.id = job.id;
    this.txHash = txHash;
  }
}

/**
 * The wallet does not know if the relay stored the job: the POST answer was lost or did not prove a refusal, and the
 * read of the job did not find it. The batch can still execute until its deadline. Do not sign a new batch for the
 * same review: follow the job later with `resume(job)`.
 */
export class RelayUnknownOutcomeError extends Error {
  readonly job: RelayJobRef;
  readonly id: Hex;

  constructor(job: RelayJobRef, cause?: unknown) {
    super(`relay: the outcome of the batch ${job.id} is not known`, { cause });
    this.name = 'RelayUnknownOutcomeError';
    this.job = job;
    this.id = job.id;
  }
}

/**
 * The relay does not know the job, and its deadline is so far in the past that the batch can no longer execute. The
 * attempt is over, and a new review is safe.
 */
export class RelayNotSubmittedError extends Error {
  readonly job: RelayJobRef;
  readonly id: Hex;

  constructor(job: RelayJobRef) {
    super(`relay: the batch ${job.id} was not submitted and can no longer execute`);
    this.name = 'RelayNotSubmittedError';
    this.job = job;
    this.id = job.id;
  }
}

/** What a failed `POST /v1/relay` proves about the job: `refused` (not stored) or `unknown` (maybe stored). */
export type RelaySubmitFailure = 'refused' | 'unknown';

/**
 * Classifies a failed `POST /v1/relay`. Only an error body whose code the route answers before the Sender stores the
 * job is `refused` (see the README of this folder). A lost answer, a broken deployment, a code this build does not
 * know, an answer that does not parse or does not match the request, and any other error are `unknown`. A missing
 * base URL is `refused`: no request was sent.
 */
export function relaySubmitFailure(error: unknown): RelaySubmitFailure {
  if (error instanceof RelayUnavailableError) return error.reason === 'not_configured' ? 'refused' : 'unknown';
  if (!(error instanceof RelayApiError)) return 'unknown';
  switch (error.code) {
    case 'invalid_request':
    case 'unsupported_chain':
    case 'target_not_allowed':
    case 'fee_too_low':
    case 'bad_signature':
    case 'stale_request':
    case 'simulation_failed':
    case 'busy':
    case 'relayer_unfunded':
    case 'rate_limited':
    case 'origin_not_allowed':
    case 'not_found':
    case 'method_not_allowed':
    case 'payload_too_large':
    case 'not_implemented':
      return 'refused';
    case 'rpc_unavailable':
    case 'service_unavailable':
    case 'internal_error':
    case 'unknown_error':
      return 'unknown';
  }
}

/**
 * What the caller does after a failed relay call:
 * - `wait`: try again later. With a `RelayJobRef` (`RelayUnknownOutcomeError`, `RelayStillPendingError`), call
 *   `resume(job)`; never sign a new batch for the same review. Else a passing failure: submit again later.
 * - `review-again`: this attempt is over and no batch of it can execute. A new review can start.
 * - `stop`: do not try again.
 */
export type RelayErrorAction = 'review-again' | 'wait' | 'stop';

/** What the caller does after a failed relay call. See `RelayErrorAction`. */
export function relayErrorAction(error: unknown): RelayErrorAction {
  if (
    error instanceof RelayUnavailableError ||
    error instanceof RelayStillPendingError ||
    error instanceof RelayUnknownOutcomeError
  ) {
    return 'wait';
  }
  if (
    error instanceof RelayNotSubmittedError ||
    error instanceof RelayExpiredError ||
    error instanceof RelayRevertedError
  ) {
    return 'review-again';
  }
  if (!(error instanceof RelayApiError)) return 'stop';
  switch (error.code) {
    case 'stale_request':
    case 'simulation_failed':
      return 'review-again';
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
