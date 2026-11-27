/**
 * HTTP client of the deposit relay (`services/evm-relay`, API contract in its README).
 *
 * Every call has a timeout and a bounded body read, and checks the response shape before it returns it. The service
 * is untrusted input: a shape that does not match is an error, never a partial value. The guards in `guards.ts`
 * decide whether the wallet may act on a parsed answer. This module keeps no state.
 */
import { zeroAddress, type Address, type Hex } from 'viem';

import { initBridgeConfig } from 'lib/remote-config/runtime';
import { ResponseTooLargeError, readCappedText, withRequestTimeout, type JsonResponse } from 'lib/remote-json';

import { getRelayBaseUrl } from './base-url';
import type { BatchCall } from './batch';
import { RelayUnavailableError, type RelayUnavailableReason } from './errors';
import { lowerAddress, lowerHash, parseRelayAccount, parseRelayError, parseRelayJob, parseRelayQuote } from './parse';
import type { RelayAccount, RelayAuthorization, RelayJob, RelayQuote, RelaySubmission } from './types';

/** One request, its body read included, ends after this long. */
export const RELAY_TIMEOUT_MS = 10_000;
/** The longest response body this client reads. */
export const MAX_RELAY_RESPONSE_BYTES = 64 * 1024;

/** The part of a fetch response this client reads. */
export type RelayResponse = JsonResponse & { status: number; headers: { get(name: string): string | null } };

export interface RelayRequestInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  cache: 'no-store';
  credentials: 'omit';
  signal: AbortSignal;
}

export type RelayFetch = (url: string, init: RelayRequestInit) => Promise<RelayResponse>;

export interface RelayClientOptions {
  /** Tests pass a stub. The default is the global `fetch`. */
  fetch?: RelayFetch;
}

const defaultFetch: RelayFetch = (url, init) => fetch(url, init);

interface RawResponse {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

function readFailureReason(error: unknown, signal: AbortSignal): RelayUnavailableReason {
  if (signal.aborted) return 'timeout';
  if (error instanceof ResponseTooLargeError) return 'bad_response';
  return 'network';
}

async function send(path: string, method: 'GET' | 'POST', body: string | undefined, options: RelayClientOptions) {
  try {
    // A background path can run before startup hydrated the snapshot. This never waits for the network.
    await initBridgeConfig();
  } catch (error) {
    console.warn('[evm-relay] the bridge config could not hydrate', error);
  }
  const base = getRelayBaseUrl();
  if (base === null) throw new RelayUnavailableError('not_configured', 'relay: the service is not configured');
  const fetchFn = options.fetch ?? defaultFetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return withRequestTimeout(RELAY_TIMEOUT_MS, async (signal): Promise<RawResponse> => {
    let text: string | null;
    let response: RelayResponse;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body,
        cache: 'no-store',
        credentials: 'omit',
        signal
      });
      if (Number(response.headers.get('content-length') ?? '0') > MAX_RELAY_RESPONSE_BYTES) {
        throw new ResponseTooLargeError();
      }
      text = await readCappedText(response, MAX_RELAY_RESPONSE_BYTES);
    } catch (error) {
      const reason = readFailureReason(error, signal);
      throw new RelayUnavailableError(reason, `relay ${path}: the request failed (${reason})`, error);
    }
    try {
      const parsed: unknown = text === null ? await response.json() : JSON.parse(text);
      return { status: response.status, body: parsed, retryAfter: response.headers.get('Retry-After') };
    } catch (error) {
      throw new RelayUnavailableError('bad_response', `relay ${path}: the body is not JSON`, error);
    }
  });
}

function answer<T>(response: RawResponse, parse: (body: unknown) => T): T {
  if (response.status !== 200) throw parseRelayError(response.status, response.body, response.retryAfter);
  return parse(response.body);
}

// The checks of the caller's input throw a TypeError: a bad argument is a defect, never a service failure.
function assertChainId(chainId: number) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError('relay: the chain id is not valid');
}

/** The most tokens that one `GET /v1/account` can ask balances for. */
export const MAX_RELAY_BALANCE_TOKENS = 16;

/** What `GET /v1/account` reads. `tokens` asks for balances; the zero address is the native coin. */
export interface RelayAccountQuery {
  chainId: number;
  address: Address;
  tokens?: readonly Address[];
}

/** The distinct tokens of a query in lower case, in their first order. Throws a `TypeError` for a bad token. */
function queryTokens(tokens: readonly Address[]): Address[] {
  const distinct: Address[] = [];
  for (const token of tokens) {
    const lower = lowerAddress(token);
    if (lower === null) throw new TypeError('relay: a token address is not valid');
    if (!distinct.includes(lower)) distinct.push(lower);
  }
  if (distinct.length > MAX_RELAY_BALANCE_TOKENS) throw new TypeError('relay: the read asks for too many tokens');
  return distinct;
}

/**
 * `GET /v1/account`: the state of a relay address on one chain. With `tokens`, the answer has the balance of each
 * distinct token, in the order of the query; the client refuses an answer with other balances.
 */
export async function fetchRelayAccount(
  query: RelayAccountQuery,
  options: RelayClientOptions = {}
): Promise<RelayAccount> {
  assertChainId(query.chainId);
  const lower = lowerAddress(query.address);
  if (lower === null) throw new TypeError('relay: the address is not valid');
  const tokens = queryTokens(query.tokens ?? []);
  const params = new URLSearchParams({ chainId: String(query.chainId), address: lower });
  if (tokens.length > 0) params.set('tokens', tokens.join(','));
  return answer(await send(`/v1/account?${params.toString()}`, 'GET', undefined, options), body =>
    parseRelayAccount(body, tokens)
  );
}

/** One call of the JSON body of `POST /v1/relay`. */
export interface RelayCallBody {
  to: Address;
  value: string;
  data: Hex;
}

/** The JSON body of `POST /v1/relay`. */
export interface RelaySubmissionBody {
  chainId: number;
  evmAddress: Address;
  calls: RelayCallBody[];
  batchNonce: string;
  salt: Hex;
  deadline: number;
  signature: Hex;
  authorization?: RelayAuthorization;
}

/** A call as the relay contract sends it: the value as a decimal string. */
export function relayCallBody(call: BatchCall): RelayCallBody {
  return { to: call.to, value: call.value.toString(), data: call.data };
}

/**
 * The body of `POST /v1/relay`: the calls exactly as signed, values and the batch nonce as decimal strings, the
 * deadline as a JSON number. Throws when the deadline is not a safe integer.
 */
export function relaySubmissionBody(request: RelaySubmission): RelaySubmissionBody {
  const deadline = Number(request.deadline);
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new TypeError('relay: the deadline is not valid');
  const body: RelaySubmissionBody = {
    chainId: request.chainId,
    evmAddress: request.evmAddress,
    calls: request.calls.map(relayCallBody),
    batchNonce: request.batchNonce.toString(),
    salt: request.salt,
    deadline,
    signature: request.signature
  };
  if (request.authorization !== undefined) body.authorization = { ...request.authorization };
  return body;
}

/**
 * `POST /v1/relay`: submits a signed batch. The service answers the same request with the same job, so a caller can
 * send it again after a timeout. The caller checks the job with `assertRelayJobMatches`.
 */
export async function submitRelay(request: RelaySubmission, options: RelayClientOptions = {}): Promise<RelayJob> {
  assertChainId(request.chainId);
  const body = JSON.stringify(relaySubmissionBody(request));
  return answer(await send('/v1/relay', 'POST', body, options), parseRelayJob);
}

/**
 * The most calls of one quote: the batch limit of the relay (8) less the fee call, which the relay adds itself when it
 * simulates the batch.
 */
export const MAX_RELAY_QUOTE_CALLS = 7;

const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT256_LIMIT = 1n << 256n;

/** What `POST /v1/quote` asks: the fee of a batch of `calls` paid in `feeToken` (the zero address is the native coin). */
export interface RelayQuoteQuery {
  chainId: number;
  evmAddress: Address;
  /** 1 to 7 calls, without the fee call. */
  calls: readonly BatchCall[];
  feeToken: Address;
  /** Whether the batch carries the EIP-7702 authorization. Without it, the relay reads the chain. */
  authorization?: boolean;
}

/** The JSON body of `POST /v1/quote`. */
export interface RelayQuoteBody {
  chainId: number;
  evmAddress: Address;
  calls: RelayCallBody[];
  feeToken: Address;
  authorization?: boolean;
}

/**
 * One call of a quote in lower case, as the vault takes it: a target that is not the zero address and not the relay
 * address itself, a uint256 value and whole bytes of calldata. Throws a `TypeError` for another call.
 */
function quoteCallBody(call: BatchCall, evmAddress: Address): RelayCallBody {
  const to = lowerAddress(call.to);
  if (to === null || to === zeroAddress || to === evmAddress) throw new TypeError('relay: a call target is not valid');
  if (call.value < 0n || call.value >= UINT256_LIMIT) throw new TypeError('relay: a call value is not valid');
  if (!EVEN_HEX.test(call.data)) throw new TypeError('relay: the calldata is not hex bytes');
  return { to, value: call.value.toString(), data: `0x${call.data.slice(2).toLowerCase()}` };
}

/**
 * The body of `POST /v1/quote`: addresses and calldata in lower case, call values as decimal strings. Throws a
 * `TypeError` for a bad chain id, address, fee token or call, and for no call or more than 7 calls.
 */
export function relayQuoteBody(query: RelayQuoteQuery): RelayQuoteBody {
  assertChainId(query.chainId);
  const evmAddress = lowerAddress(query.evmAddress);
  if (evmAddress === null) throw new TypeError('relay: the address is not valid');
  const feeToken = lowerAddress(query.feeToken);
  if (feeToken === null) throw new TypeError('relay: the fee token is not valid');
  if (query.calls.length === 0 || query.calls.length > MAX_RELAY_QUOTE_CALLS) {
    throw new TypeError('relay: a quote takes 1 to 7 calls');
  }
  const body: RelayQuoteBody = {
    chainId: query.chainId,
    evmAddress,
    calls: query.calls.map(call => quoteCallBody(call, evmAddress)),
    feeToken
  };
  if (query.authorization !== undefined) body.authorization = query.authorization;
  return body;
}

/**
 * `POST /v1/quote`: the fee that the relay asks now for a batch of the calls paid in the fee token. The relay
 * simulates the calls; it does not store or sign the quote. The caller checks the answer with
 * `assertRelayQuoteMatches` (or uses `quoteRelayFee`, which does). In `sponsor` mode the relay answers
 * `400 fee_not_needed`.
 */
export async function fetchRelayQuote(query: RelayQuoteQuery, options: RelayClientOptions = {}): Promise<RelayQuote> {
  const body = JSON.stringify(relayQuoteBody(query));
  return answer(await send('/v1/quote', 'POST', body, options), parseRelayQuote);
}

/** What `GET /v1/relay/{id}` reads. `chainId` is optional. */
export interface RelayJobQuery {
  id: Hex;
  chainId?: number;
}

/** `GET /v1/relay/{id}`: the state of a job. An unknown id is a `not_found` `RelayApiError`. */
export async function fetchRelayJob(query: RelayJobQuery, options: RelayClientOptions = {}): Promise<RelayJob> {
  const lower = lowerHash(query.id);
  if (lower === null) throw new TypeError('relay: the relay id is not valid');
  let path = `/v1/relay/${lower}`;
  if (query.chainId !== undefined) {
    assertChainId(query.chainId);
    path = `${path}?${new URLSearchParams({ chainId: String(query.chainId) }).toString()}`;
  }
  return answer(await send(path, 'GET', undefined, options), parseRelayJob);
}
