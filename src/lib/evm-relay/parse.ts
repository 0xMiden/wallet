import type { Address, Hex } from 'viem';

import { isRecord } from 'lib/update/guards';

import { RELAY_ERROR_CODES, RelayApiError, RelayUnavailableError, type RelayErrorCode } from './errors';
import type {
  RelayAccount,
  RelayGasMode,
  RelayJob,
  RelayJobState,
  RelayService,
  RelayTokenBalance,
  RelayTokenFee
} from './types';

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

function readFee(value: unknown): RelayTokenFee {
  const entry = record(value, 'a fee');
  return { token: readAddress(entry.token, 'fee token'), fee: readUint(entry.fee, UINT256_LIMIT, 'fee') };
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
  const chainId = value.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw malformed('chainId');
  if (typeof value.needsAuthorization !== 'boolean') throw malformed('needsAuthorization');
  const fees = readList(value.fees, readFee, 'fees');
  // Two fees of one token make the fee ambiguous.
  if (new Set(fees.map(entry => entry.token)).size !== fees.length) throw malformed('fees');
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
    fees,
    allowedTargets: readAllowedTargets(value.allowedTargets),
    balances
  };
}

/** A chain id list: positive safe integers, strictly ascending (so each id is there one time). */
function readChainIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw malformed('chains');
  const chains: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0) throw malformed('a chain id');
    const last = chains[chains.length - 1];
    if (last !== undefined && entry <= last) throw malformed('chains');
    chains.push(entry);
  }
  return chains;
}

/**
 * The body of `GET /v1/chains`. Throws `RelayUnavailableError` when the body does not match: a field with a wrong
 * type, an unknown mode, or a chain list that is not strictly ascending. Unknown fields are ignored.
 */
export function parseRelayService(body: unknown): RelayService {
  const value = record(body, 'the service');
  return {
    mode: readMode(value.mode),
    executor: readAddress(value.executor, 'executor'),
    chains: readChainIds(value.chains)
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
