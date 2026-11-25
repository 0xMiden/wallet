import type { Hex } from 'viem';

import { initBridgeConfig } from 'lib/remote-config/runtime';
import { getRelayConfig } from 'lib/remote-config/values';

import {
  MAX_RELAY_RESPONSE_BYTES,
  RELAY_TIMEOUT_MS,
  fetchRelayAccount,
  fetchRelayJob,
  relaySubmissionBody,
  submitRelay,
  type RelayFetch,
  type RelayRequestInit
} from './client';
import { RelayApiError, RelayUnavailableError } from './errors';
import {
  CHAIN,
  FEE_RECIPIENT,
  JOB_ID,
  RELAY_ADDRESS,
  SALT,
  TX_HASH,
  USDC,
  accountBody,
  jobBody,
  stubResponse
} from './testing';
import type { RelaySubmission } from './types';

jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: jest.fn() }));
jest.mock('lib/remote-config/values', () => ({ getRelayConfig: jest.fn() }));

const BASE = 'https://relay.example.workers.dev';
const SIGNATURE: Hex = `0x${'c3'.repeat(65)}`;

let calls: { url: string; init: RelayRequestInit }[] = [];

function fetchReturning(response: ReturnType<typeof stubResponse>): RelayFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return response;
  };
}

function call(index: number): { url: string; init: RelayRequestInit } {
  const sent = calls[index];
  if (sent === undefined) throw new Error(`no request ${index}`);
  return sent;
}

beforeEach(() => {
  calls = [];
  delete process.env.MIDEN_EVM_RELAY_URL;
  jest.mocked(initBridgeConfig).mockReset();
  jest
    .mocked(getRelayConfig)
    .mockReset()
    .mockReturnValue({ baseUrl: BASE, chains: [CHAIN] });
});

function submission(overrides: Partial<RelaySubmission> = {}): RelaySubmission {
  return {
    chainId: 8453,
    kind: 'agglayer-deposit',
    evmAddress: RELAY_ADDRESS,
    params: { token: USDC, amount: 999_000n, midenAccountHex: `0x${'12'.repeat(15)}`, fee: null },
    batchNonce: (5n << 64n) | 3n,
    salt: SALT,
    deadline: 1_900_000_000n,
    signature: SIGNATURE,
    ...overrides
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error
  );
}

describe('fetchRelayAccount', () => {
  it('reads the account and lower-cases addresses and hashes', async () => {
    const fetchFn = fetchReturning(stubResponse(200, accountBody()));
    const account = await fetchRelayAccount(8453, RELAY_ADDRESS, { fetch: fetchFn });
    expect(account).toEqual({
      chainId: 8453,
      address: RELAY_ADDRESS,
      mode: 'sponsor',
      executor: CHAIN.executor,
      feeRecipient: null,
      needsAuthorization: true,
      authorizationNonce: 0,
      salt: SALT,
      kinds: { 'agglayer-deposit': { sequence: 3n } },
      balances: [{ token: USDC, balance: 1_000_000n, minAmount: 100_000n, fee: 0n }]
    });
    expect(initBridgeConfig).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(call(0).url).toBe(`${BASE}/v1/account?chainId=8453&address=${RELAY_ADDRESS}`);
    expect(call(0).init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit' });
    expect(call(0).init.headers).toEqual({ Accept: 'application/json' });
    expect(call(0).init.body).toBeUndefined();
  });

  it('reads a deduct account with a fee recipient and no known kind', async () => {
    const body = { ...accountBody(), mode: 'deduct', feeRecipient: FEE_RECIPIENT, kinds: { other: {} }, extra: 1 };
    const account = await fetchRelayAccount(8453, RELAY_ADDRESS, { fetch: fetchReturning(stubResponse(200, body)) });
    expect(account.mode).toBe('deduct');
    expect(account.feeRecipient).toBe(FEE_RECIPIENT);
    expect(account.kinds).toEqual({});
  });

  it.each([
    ['a body that is not an object', []],
    ['a missing chain id', { chainId: undefined }],
    ['a chain id of 0', { chainId: 0 }],
    ['a short address', { address: '0x1234' }],
    ['an unknown mode', { mode: 'free' }],
    ['a missing executor', { executor: undefined }],
    ['a missing fee recipient', { feeRecipient: undefined }],
    ['a fee recipient that is not an address', { feeRecipient: 'nobody' }],
    ['needsAuthorization as a string', { needsAuthorization: 'true' }],
    ['a negative authorization nonce', { authorizationNonce: -1 }],
    ['a fractional authorization nonce', { authorizationNonce: 1.5 }],
    ['a short salt', { salt: '0x1234' }],
    ['kinds that is not an object', { kinds: null }],
    ['a sequence as a number', { kinds: { 'agglayer-deposit': { sequence: 3 } } }],
    ['a sequence of 2^64', { kinds: { 'agglayer-deposit': { sequence: (1n << 64n).toString() } } }],
    ['balances that is not a list', { balances: {} }],
    ['a balance as a number', { balances: [{ token: USDC, balance: 1, minAmount: '1', fee: '0' }] }],
    ['a balance with a leading zero', { balances: [{ token: USDC, balance: '01', minAmount: '1', fee: '0' }] }],
    ['a negative fee', { balances: [{ token: USDC, balance: '1', minAmount: '1', fee: '-1' }] }],
    ['an amount of 2^256', { balances: [{ token: USDC, balance: (1n << 256n).toString(), minAmount: '1', fee: '0' }] }],
    ['a balance without a token', { balances: [{ balance: '1', minAmount: '1', fee: '0' }] }],
    [
      'two entries of one token',
      {
        balances: [
          { token: USDC, balance: '1', minAmount: '1', fee: '0' },
          { token: USDC.toUpperCase().replace('0X', '0x'), balance: '2', minAmount: '1', fee: '0' }
        ]
      }
    ]
  ])('refuses %s', async (_name, change) => {
    const body = Array.isArray(change) ? change : { ...accountBody(), ...change };
    const error = await failure(
      fetchRelayAccount(8453, RELAY_ADDRESS, { fetch: fetchReturning(stubResponse(200, body)) })
    );
    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect(error).toMatchObject({ reason: 'bad_response' });
  });

  it.each([
    ['a chain id of 0', 0, RELAY_ADDRESS],
    ['a fractional chain id', 1.5, RELAY_ADDRESS],
    ['an address that is not valid', 8453, '0x12']
  ])('refuses %s before any request', async (_name, chainId, address) => {
    const fetchFn = fetchReturning(stubResponse(200, accountBody()));
    await expect(fetchRelayAccount(chainId, `0x${address.slice(2)}`, { fetch: fetchFn })).rejects.toBeInstanceOf(
      TypeError
    );
    expect(calls).toHaveLength(0);
  });
});

describe('relaySubmissionBody', () => {
  it('writes amounts as decimal strings and a sponsored fee as "0"', () => {
    expect(relaySubmissionBody(submission())).toEqual({
      chainId: 8453,
      kind: 'agglayer-deposit',
      evmAddress: RELAY_ADDRESS,
      params: { token: USDC, amount: '999000', midenAccountHex: `0x${'12'.repeat(15)}`, fee: '0' },
      batchNonce: ((5n << 64n) | 3n).toString(),
      salt: SALT,
      deadline: 1_900_000_000,
      signature: SIGNATURE
    });
  });

  it('writes the fee amount and the authorization', () => {
    const authorization = { address: CHAIN.calibur.address, chainId: 8453, nonce: 0, r: SALT, s: JOB_ID, yParity: 1 };
    const request = submission({
      params: { ...submission().params, fee: { recipient: FEE_RECIPIENT, amount: 1000n } },
      authorization
    });
    const body = relaySubmissionBody(request);
    expect(body.params.fee).toBe('1000');
    expect(body.authorization).toEqual(authorization);
    expect(relaySubmissionBody(request)).toEqual(body);
  });

  it.each([
    ['above the safe integers', 2n ** 53n],
    ['negative', -1n]
  ])('refuses a deadline %s', (_name, deadline) => {
    expect(() => relaySubmissionBody(submission({ deadline }))).toThrow(TypeError);
  });
});

describe('submitRelay', () => {
  it('posts the body and reads the job', async () => {
    const fetchFn = fetchReturning(stubResponse(200, jobBody()));
    const job = await submitRelay(submission(), { fetch: fetchFn });
    expect(job).toEqual({ id: JOB_ID, state: 'pending', txHash: TX_HASH });
    expect(call(0).url).toBe(`${BASE}/v1/relay`);
    expect(call(0).init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit' });
    expect(call(0).init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(call(0).init.body).toBe(JSON.stringify(relaySubmissionBody(submission())));
  });

  it('sends the same body when the same request is sent again', async () => {
    const fetchFn = fetchReturning(stubResponse(200, jobBody()));
    const first = await submitRelay(submission(), { fetch: fetchFn });
    const second = await submitRelay(submission(), { fetch: fetchFn });
    expect(second).toEqual(first);
    expect(call(1).init.body).toBe(call(0).init.body);
  });

  it.each([
    ['an unknown state', jobBody('done')],
    ['a missing tx hash', { id: JOB_ID, state: 'pending' }],
    ['an id that is not a hash', { ...jobBody(), id: '0x12' }]
  ])('refuses %s', async (_name, body) => {
    const error = await failure(submitRelay(submission(), { fetch: fetchReturning(stubResponse(200, body)) }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'bad_response' });
  });
});

describe('fetchRelayJob', () => {
  it('reads the job by its id', async () => {
    const fetchFn = fetchReturning(stubResponse(200, jobBody('succeeded')));
    const job = await fetchRelayJob(JOB_ID, { fetch: fetchFn });
    expect(job.state).toBe('succeeded');
    expect(call(0).url).toBe(`${BASE}/v1/relay/${JOB_ID}`);
    expect(call(0).init.method).toBe('GET');
  });

  it('refuses an id that is not a hash before any request', async () => {
    const fetchFn = fetchReturning(stubResponse(200, jobBody()));
    await expect(fetchRelayJob('0x12/../account', { fetch: fetchFn })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('maps a 404 to not_found', async () => {
    const body = { error: 'not_found', message: 'no relay' };
    const error = await failure(fetchRelayJob(JOB_ID, { fetch: fetchReturning(stubResponse(404, body)) }));
    expect(error).toBeInstanceOf(RelayApiError);
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('error bodies', () => {
  it.each([
    ['invalid_request', 400],
    ['unsupported_chain', 400],
    ['unsupported_kind', 400],
    ['token_not_allowed', 400],
    ['below_minimum', 400],
    ['fee_too_low', 400],
    ['bad_signature', 400],
    ['stale_request', 409],
    ['simulation_failed', 409],
    ['busy', 409],
    ['relayer_unfunded', 503],
    ['rpc_unavailable', 502],
    ['rate_limited', 429],
    ['origin_not_allowed', 403],
    ['not_found', 404],
    ['method_not_allowed', 405],
    ['payload_too_large', 413],
    ['not_implemented', 501],
    ['service_unavailable', 503],
    ['internal_error', 500]
  ])('maps %s', async (code, status) => {
    const fetchFn = fetchReturning(stubResponse(status, { error: code, message: 'text' }));
    const error = await failure(submitRelay(submission(), { fetch: fetchFn }));
    expect(error).toBeInstanceOf(RelayApiError);
    expect(error).toMatchObject({ code, status, retryAfter: undefined, id: undefined });
  });

  it('maps an unknown code to unknown_error', async () => {
    const fetchFn = fetchReturning(stubResponse(418, { error: 'teapot', message: 'short and stout' }));
    const error = await failure(submitRelay(submission(), { fetch: fetchFn }));
    expect(error).toMatchObject({ code: 'unknown_error', status: 418 });
  });

  it("takes retryAfter from the body before the header's", async () => {
    const body = { error: 'rate_limited', message: 'slow down', retryAfter: 60 };
    const fetchFn = fetchReturning(stubResponse(429, body, { 'Retry-After': '5' }));
    expect(await failure(submitRelay(submission(), { fetch: fetchFn }))).toMatchObject({ retryAfter: 60 });
  });

  it.each([
    ['the header', {}, { 'Retry-After': '30' }, 30],
    ['a long wait held to one hour', { retryAfter: 86_400 }, {}, 3600],
    ['an HTTP date header, which is ignored', {}, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, undefined]
  ])('reads retryAfter from %s', async (_name, extra, headers, expected) => {
    const body = { error: 'rate_limited', message: 'slow down', ...extra };
    const fetchFn = fetchReturning(stubResponse(429, body, headers));
    expect(await failure(submitRelay(submission(), { fetch: fetchFn }))).toMatchObject({ retryAfter: expected });
  });

  it('reads the open relay id on busy', async () => {
    const body = { error: 'busy', message: 'open relay', id: JOB_ID.toUpperCase().replace('0X', '0x') };
    const error = await failure(submitRelay(submission(), { fetch: fetchReturning(stubResponse(409, body)) }));
    expect(error).toMatchObject({ code: 'busy', id: JOB_ID });
  });

  it('leaves out a busy id that is not a hash', async () => {
    const body = { error: 'busy', message: 'open relay', id: 'nope' };
    const error = await failure(submitRelay(submission(), { fetch: fetchReturning(stubResponse(409, body)) }));
    expect(error).toMatchObject({ code: 'busy', id: undefined });
  });

  it.each([
    ['a body without an error code', { message: 'no code' }],
    ['a body that is not an object', 'null']
  ])('treats %s as a bad response', async (_name, body) => {
    const error = await failure(submitRelay(submission(), { fetch: fetchReturning(stubResponse(500, body)) }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'bad_response' });
  });
});

describe('transport', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refuses without a base URL and sends nothing', async () => {
    jest.mocked(getRelayConfig).mockReturnValue(null);
    const fetchFn = fetchReturning(stubResponse(200, jobBody()));
    const error = await failure(fetchRelayJob(JOB_ID, { fetch: fetchFn }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('still reads the base URL when the bridge config fails to hydrate', async () => {
    jest.mocked(initBridgeConfig).mockRejectedValue(new Error('storage'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const job = await fetchRelayJob(JOB_ID, { fetch: fetchReturning(stubResponse(200, jobBody())) });
    expect(job.id).toBe(JOB_ID);
    warn.mockRestore();
  });

  it('maps a network failure', async () => {
    const fetchFn: RelayFetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const error = await failure(fetchRelayJob(JOB_ID, { fetch: fetchFn }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'network' });
  });

  it('maps a timeout', async () => {
    jest.useFakeTimers();
    const fetchFn: RelayFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const outcome = failure(fetchRelayJob(JOB_ID, { fetch: fetchFn }));
    await jest.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ name: 'RelayUnavailableError', reason: 'timeout' });
  });

  it('refuses a body that is not JSON', async () => {
    const error = await failure(fetchRelayJob(JOB_ID, { fetch: fetchReturning(stubResponse(200, '<html>')) }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'bad_response' });
  });

  it('refuses a body above the cap by its declared length', async () => {
    const response = stubResponse(200, jobBody(), { 'Content-Length': String(MAX_RELAY_RESPONSE_BYTES + 1) });
    const error = await failure(fetchRelayJob(JOB_ID, { fetch: fetchReturning(response) }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'bad_response' });
  });

  it('refuses a body above the cap as it reads it', async () => {
    const response = stubResponse(200, { ...jobBody(), pad: 'x'.repeat(MAX_RELAY_RESPONSE_BYTES) });
    const error = await failure(fetchRelayJob(JOB_ID, { fetch: fetchReturning(response) }));
    expect(error).toMatchObject({ name: 'RelayUnavailableError', reason: 'bad_response' });
  });
});
