import type { Address, Hex } from 'viem';

import { isRecord } from 'lib/update/guards';

import { RELAY_ERROR_CODES, RelayApiError, RelayUnavailableError, type RelayErrorCode } from './errors';
import type { RelayAccount, RelayGasMode, RelayJob, RelayJobState, RelayTokenBalance } from './types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
// A non-negative integer in decimal, with no sign and no leading zero.
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const UINT64_LIMIT = 1n << 64n;
const UINT256_LIMIT = 1n << 256n;
/** The longest wait this client takes from the service: one hour. */
export const MAX_RETRY_AFTER_SECONDS = 3600;
const MAX_MESSAGE_LENGTH = 500;

function malformed(what: string): RelayUnavailableError {
  return new RelayUnavailableError('bad_response', `relay: ${what} does not match the contract`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(what);
  return value;
}

/** A 20-byte address in lower case, or null. */
export function lowerAddress(value: unknown): Address | null {
  return typeof value === 'string' && ADDRESS.test(value) ? `0x${value.slice(2).toLowerCase()}` : null;
}

/** A 32-byte hash in lower case, or null. */
export function lowerHash(value: unknown): Hex | null {
  return typeof value === 'string' && HASH.test(value) ? `0x${value.slice(2).toLowerCase()}` : null;
}

function readAddress(value: unknown, what: string): Address {
  const address = lowerAddress(value);
  if (address === null) throw malformed(what);
  return address;
}

function readHash(value: unknown, what: string): Hex {
  const hash = lowerHash(value);
  if (hash === null) throw malformed(what);
  return hash;
}

function readUint(value: unknown, limit: bigint, what: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw malformed(what);
  const amount = BigInt(value);
  if (amount >= limit) throw malformed(what);
  return amount;
}

function readSafeCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed(what);
  return value;
}

function readMode(value: unknown): RelayGasMode {
  switch (value) {
    case 'sponsor':
    case 'deduct':
      return value;
    default:
      throw malformed('mode');
  }
}

function readState(value: unknown): RelayJobState {
  switch (value) {
    case 'pending':
    case 'succeeded':
    case 'reverted':
      return value;
    default:
      throw malformed('state');
  }
}

function readBalance(value: unknown): RelayTokenBalance {
  const entry = record(value, 'a balance');
  return {
    token: readAddress(entry.token, 'balance token'),
    balance: readUint(entry.balance, UINT256_LIMIT, 'balance'),
    minAmount: readUint(entry.minAmount, UINT256_LIMIT, 'minAmount'),
    fee: readUint(entry.fee, UINT256_LIMIT, 'fee')
  };
}

// Kinds that this build does not know are ignored: a newer service can serve more kinds.
function readKinds(value: unknown): RelayAccount['kinds'] {
  const kinds = record(value, 'kinds');
  if (kinds['agglayer-deposit'] === undefined) return {};
  const deposit = record(kinds['agglayer-deposit'], 'agglayer-deposit');
  return { 'agglayer-deposit': { sequence: readUint(deposit.sequence, UINT64_LIMIT, 'sequence') } };
}

/** The body of `GET /v1/account`. Throws `RelayUnavailableError` when it does not match. Unknown fields are ignored. */
export function parseRelayAccount(body: unknown): RelayAccount {
  const value = record(body, 'the account');
  const chainId = value.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw malformed('chainId');
  if (typeof value.needsAuthorization !== 'boolean') throw malformed('needsAuthorization');
  if (!Array.isArray(value.balances)) throw malformed('balances');
  const balances = value.balances.map(readBalance);
  // Two entries of one token make the fee and the minimum ambiguous.
  if (new Set(balances.map(balance => balance.token)).size !== balances.length) throw malformed('balances');
  return {
    chainId,
    address: readAddress(value.address, 'address'),
    mode: readMode(value.mode),
    executor: readAddress(value.executor, 'executor'),
    feeRecipient: value.feeRecipient === null ? null : readAddress(value.feeRecipient, 'feeRecipient'),
    needsAuthorization: value.needsAuthorization,
    authorizationNonce: readSafeCount(value.authorizationNonce, 'authorizationNonce'),
    salt: readHash(value.salt, 'salt'),
    kinds: readKinds(value.kinds),
    balances
  };
}

/** The body of `POST /v1/relay` and `GET /v1/relay/{id}`. Throws `RelayUnavailableError` when it does not match. */
export function parseRelayJob(body: unknown): RelayJob {
  const value = record(body, 'the relay job');
  return { id: readHash(value.id, 'id'), state: readState(value.state), txHash: readHash(value.txHash, 'txHash') };
}

function readErrorCode(value: unknown): RelayErrorCode {
  return RELAY_ERROR_CODES.find(code => code === value) ?? 'unknown_error';
}

/** Seconds from the body's `retryAfter`, else from a delta-seconds `Retry-After` header, at most one hour. */
function readRetryAfter(value: unknown, header: string | null): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(Math.ceil(value), MAX_RETRY_AFTER_SECONDS);
  }
  const trimmed = header?.trim() ?? '';
  return /^\d+$/.test(trimmed) ? Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS) : undefined;
}

/**
 * The error of a response that is not 200. A body without a string `error` field throws `RelayUnavailableError`.
 * A malformed `id` on `busy` is left out.
 */
export function parseRelayError(status: number, body: unknown, retryAfterHeader: string | null): RelayApiError {
  const value = record(body, 'the error body');
  if (typeof value.error !== 'string') throw malformed('the error body');
  const code = readErrorCode(value.error);
  const text = typeof value.message === 'string' ? value.message.slice(0, MAX_MESSAGE_LENGTH) : 'request failed';
  const id = lowerHash(value.id) ?? undefined;
  return new RelayApiError(
    code,
    status,
    `relay (${status} ${value.error.slice(0, 64)}): ${text}`,
    readRetryAfter(value.retryAfter, retryAfterHeader),
    id
  );
}
