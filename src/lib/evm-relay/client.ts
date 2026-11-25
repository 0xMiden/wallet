/**
 * HTTP client of the deposit relay (`services/evm-relay`, API contract in its README).
 *
 * Every call has a timeout and a bounded body read, and checks the response shape before it returns it. The service
 * is untrusted input: a shape that does not match is an error, never a partial value. The guards in `guards.ts`
 * decide whether the wallet may act on a parsed answer. This module keeps no state.
 */
import type { Address, Hex } from 'viem';

import { initBridgeConfig } from 'lib/remote-config/runtime';
import { ResponseTooLargeError, readCappedText, withRequestTimeout, type JsonResponse } from 'lib/remote-json';

import { getRelayBaseUrl } from './base-url';
import { RelayUnavailableError, type RelayUnavailableReason } from './errors';
import { lowerAddress, lowerHash, parseRelayAccount, parseRelayError, parseRelayJob } from './parse';
import type { RelayAccount, RelayAuthorization, RelayJob, RelaySubmission } from './types';

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

/** `GET /v1/account`: the state of a relay address on one chain. */
export async function fetchRelayAccount(
  chainId: number,
  address: Address,
  options: RelayClientOptions = {}
): Promise<RelayAccount> {
  assertChainId(chainId);
  const lower = lowerAddress(address);
  if (lower === null) throw new TypeError('relay: the address is not valid');
  const query = new URLSearchParams({ chainId: String(chainId), address: lower });
  return answer(await send(`/v1/account?${query.toString()}`, 'GET', undefined, options), parseRelayAccount);
}

/** The JSON body of `POST /v1/relay`. */
export interface RelaySubmissionBody {
  chainId: number;
  kind: RelaySubmission['kind'];
  evmAddress: Address;
  params: { token: Address; amount: string; midenAccountHex: string; fee: string };
  batchNonce: string;
  salt: Hex;
  deadline: number;
  signature: Hex;
  authorization?: RelayAuthorization;
}

/**
 * The body of `POST /v1/relay`: amounts and the batch nonce as decimal strings, the deadline as a JSON number. `fee`
 * is the fee amount, `"0"` when the relayer sponsors the deposit. The server reads the fee recipient from its own
 * config. Throws when the deadline is not a safe integer.
 */
export function relaySubmissionBody(request: RelaySubmission): RelaySubmissionBody {
  const deadline = Number(request.deadline);
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new TypeError('relay: the deadline is not valid');
  const { token, amount, midenAccountHex, fee } = request.params;
  const body: RelaySubmissionBody = {
    chainId: request.chainId,
    kind: request.kind,
    evmAddress: request.evmAddress,
    params: { token, amount: amount.toString(), midenAccountHex, fee: (fee?.amount ?? 0n).toString() },
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

/** `GET /v1/relay/{id}`: the state of a job. An unknown id is a `not_found` `RelayApiError`. */
export async function fetchRelayJob(id: Hex, options: RelayClientOptions = {}): Promise<RelayJob> {
  const lower = lowerHash(id);
  if (lower === null) throw new TypeError('relay: the relay id is not valid');
  return answer(await send(`/v1/relay/${lower}`, 'GET', undefined, options), parseRelayJob);
}
