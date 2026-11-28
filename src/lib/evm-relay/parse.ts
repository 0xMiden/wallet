import type { Address, Hex } from 'viem';

import { isRecord } from 'lib/update/guards';

import {
  RELAY_ERROR_CODES,
  RelayApiError,
  RelayFeeTooLowError,
  RelayUnavailableError,
  type RelayErrorCode
} from './errors';
import type { RelayAccount, RelayGasMode, RelayJob, RelayJobState, RelayQuote, RelayTokenBalance } from './types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
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
    case 'expired':
      return value;
    default:
      throw malformed('state');
  }
}

function readBalance(value: unknown): RelayTokenBalance {
  const entry = record(value, 'a balance');
  return {
    token: readAddress(entry.token, 'balance token'),
    balance: readUint(entry.balance, UINT256_LIMIT, 'balance')
  };
}

/** A positive safe integer: a chain id. */
function readChainId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw malformed('chainId');
  return value;
}

/** The fee tokens of an account: addresses, each one time (two entries of one token are ambiguous). */
function readFeeTokens(value: unknown): Address[] {
  const tokens = readList(value, entry => readAddress(entry, 'a fee token'), 'feeTokens');
  if (new Set(tokens).size !== tokens.length) throw malformed('feeTokens');
  return tokens;
}

function readList<T>(value: unknown, read: (entry: unknown) => T, what: string): T[] {
  if (!Array.isArray(value)) throw malformed(what);
  return value.map(read);
}

function readAllowedTargets(value: unknown): Address[] | null {
  if (value === null) return null;
  return readList(value, entry => readAddress(entry, 'an allowed target'), 'allowedTargets');
}

function sameTokens(entries: { token: Address }[], tokens: readonly Address[]): boolean {
  return entries.length === tokens.length && entries.every((entry, index) => entry.token === tokens[index]);
}

/**
 * The body of `GET /v1/account`. `tokens` are the distinct lower-case tokens of the read, in its order: the balances
 * must name exactly these tokens in this order. Throws `RelayUnavailableError` when the body does not match. Unknown
 * fields are ignored.
 */
export function parseRelayAccount(body: unknown, tokens: readonly Address[] = []): RelayAccount {
  const value = record(body, 'the account');
  const chainId = readChainId(value.chainId);
  if (typeof value.needsAuthorization !== 'boolean') throw malformed('needsAuthorization');
  const feeTokens = readFeeTokens(value.feeTokens);
  const balances = readList(value.balances, readBalance, 'balances');
  if (!sameTokens(balances, tokens)) throw malformed('balances');
  return {
    chainId,
    address: readAddress(value.address, 'address'),
    mode: readMode(value.mode),
    executor: readAddress(value.executor, 'executor'),
    feeRecipient: value.feeRecipient === null ? null : readAddress(value.feeRecipient, 'feeRecipient'),
    needsAuthorization: value.needsAuthorization,
    authorizationNonce: readSafeCount(value.authorizationNonce, 'authorizationNonce'),
    salt: readHash(value.salt, 'salt'),
    sequence: readUint(value.sequence, UINT64_LIMIT, 'sequence'),
    feeTokens,
    allowedTargets: readAllowedTargets(value.allowedTargets),
    balances
  };
}

/**
 * The body of `POST /v1/quote`. Throws `RelayUnavailableError` when it does not match: a field with a wrong type, a
 * fee or gas that is not a decimal string in range, or a `validUntil` that is not a safe integer of 0 or more. Unknown
 * fields are ignored. The guard `assertRelayQuoteMatches` decides whether the wallet may use the quote.
 */
export function parseRelayQuote(body: unknown): RelayQuote {
  const value = record(body, 'the quote');
  const { signature } = value;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) throw malformed('signature');
  const gas = readUint(value.gas, UINT64_LIMIT, 'gas');
  if (gas === 0n) throw malformed('gas');
  return {
    chainId: readChainId(value.chainId),
    token: readAddress(value.token, 'token'),
    recipient: readAddress(value.recipient, 'recipient'),
    fee: readUint(value.fee, UINT256_LIMIT, 'fee'),
    gas,
    sequence: readUint(value.sequence, UINT64_LIMIT, 'sequence'),
    validUntil: readSafeCount(value.validUntil, 'validUntil'),
    signature: `0x${signature.slice(2).toLowerCase()}`
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

/** The required fee of a `fee_too_low` body: a decimal string in range, else null. */
function readRequiredFee(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const amount = BigInt(value);
  return amount < UINT256_LIMIT ? amount : null;
}

/**
 * The error of a response that is not 200. A body without a string `error` field throws `RelayUnavailableError`.
 * A malformed `id` on `busy` is left out. A `fee_too_low` body with a valid `required` and `token` gives a
 * `RelayFeeTooLowError`; without them it gives a `RelayApiError` with the same code, as the relay still refused the
 * job.
 */
export function parseRelayError(status: number, body: unknown, retryAfterHeader: string | null): RelayApiError {
  const value = record(body, 'the error body');
  if (typeof value.error !== 'string') throw malformed('the error body');
  const code = readErrorCode(value.error);
  const text = typeof value.message === 'string' ? value.message.slice(0, MAX_MESSAGE_LENGTH) : 'request failed';
  const message = `relay (${status} ${value.error.slice(0, 64)}): ${text}`;
  if (code === 'fee_too_low') {
    const required = readRequiredFee(value.required);
    const token = lowerAddress(value.token);
    if (required !== null && token !== null) return new RelayFeeTooLowError(status, message, required, token);
  }
  const id = lowerHash(value.id) ?? undefined;
  return new RelayApiError(code, status, message, readRetryAfter(value.retryAfter, retryAfterHeader), id);
}
