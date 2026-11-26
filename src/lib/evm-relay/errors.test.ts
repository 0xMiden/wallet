import { createWalletClient, custom, zeroAddress } from 'viem';
import { base } from 'viem/chains';

import {
  RELAY_ERROR_CODES,
  RelayApiError,
  RelayExpiredError,
  RelayMismatchError,
  RelayNotSubmittedError,
  RelayProviderRpcError,
  RelayRefusedError,
  RelayRevertedError,
  RelayStillPendingError,
  RelayUnavailableError,
  RelayUnknownOutcomeError,
  openRelayJobError,
  relayErrorAction,
  relaySubmitFailure,
  type RelayErrorCode
} from './errors';
import { JOB_ID, TX_HASH } from './testing';
import type { RelayJobRef } from './types';

const JOB: RelayJobRef = { chainId: 8453, id: JOB_ID, deadline: 1_800_000_000 };

describe('relayErrorAction', () => {
  it.each<[RelayErrorCode, number, string]>([
    ['stale_request', 409, 'review-again'],
    ['simulation_failed', 409, 'review-again'],
    ['rate_limited', 429, 'wait'],
    ['busy', 409, 'wait'],
    ['relayer_unfunded', 503, 'wait'],
    ['rpc_unavailable', 502, 'wait'],
    ['service_unavailable', 503, 'wait'],
    ['internal_error', 500, 'wait'],
    ['invalid_request', 400, 'stop'],
    ['unsupported_chain', 400, 'stop'],
    ['target_not_allowed', 400, 'stop'],
    ['fee_too_low', 400, 'stop'],
    ['bad_signature', 400, 'stop'],
    ['origin_not_allowed', 403, 'stop'],
    ['not_found', 404, 'stop'],
    ['method_not_allowed', 405, 'stop'],
    ['payload_too_large', 413, 'stop'],
    ['not_implemented', 501, 'stop'],
    ['unknown_error', 400, 'stop'],
    ['unknown_error', 429, 'wait'],
    ['unknown_error', 503, 'wait']
  ])('classifies %s (%i) as %s', (code, status, action) => {
    expect(relayErrorAction(new RelayApiError(code, status, 'text'))).toBe(action);
  });

  it.each([
    ['a missing base URL', new RelayUnavailableError('not_configured', 'text'), 'wait'],
    ['a timeout', new RelayUnavailableError('timeout', 'text'), 'wait'],
    ['a job that is still pending', new RelayStillPendingError(JOB, TX_HASH), 'wait'],
    ['a job with an unknown outcome', new RelayUnknownOutcomeError(JOB), 'wait'],
    ['a job that was not submitted', new RelayNotSubmittedError(JOB), 'review-again'],
    ['an expired job', new RelayExpiredError(JOB_ID, TX_HASH), 'review-again'],
    ['a reverted job', new RelayRevertedError(JOB_ID, TX_HASH), 'review-again'],
    ['a mismatch', new RelayMismatchError('text'), 'stop'],
    ['a refusal', new RelayRefusedError('no-fee'), 'stop'],
    ['a provider error', new RelayProviderRpcError(4200, 'text'), 'stop'],
    ['a plain error', new Error('text'), 'stop'],
    ['a value that is not an error', 'text', 'stop']
  ])('classifies %s as %s', (_name, error, action) => {
    expect(relayErrorAction(error)).toBe(action);
  });
});

describe('relaySubmitFailure', () => {
  it.each<[RelayErrorCode, number, string]>([
    ['invalid_request', 400, 'refused'],
    ['unsupported_chain', 400, 'refused'],
    ['target_not_allowed', 400, 'refused'],
    ['fee_too_low', 400, 'refused'],
    ['bad_signature', 400, 'refused'],
    ['stale_request', 409, 'refused'],
    ['simulation_failed', 409, 'refused'],
    ['busy', 409, 'refused'],
    ['relayer_unfunded', 503, 'refused'],
    ['rate_limited', 429, 'refused'],
    ['origin_not_allowed', 403, 'refused'],
    ['not_found', 404, 'refused'],
    ['method_not_allowed', 405, 'refused'],
    ['payload_too_large', 413, 'refused'],
    ['not_implemented', 501, 'refused'],
    ['rpc_unavailable', 502, 'unknown'],
    ['service_unavailable', 503, 'unknown'],
    ['internal_error', 500, 'unknown'],
    ['unknown_error', 400, 'unknown'],
    ['unknown_error', 503, 'unknown']
  ])('classifies %s (%i) as %s', (code, status, failure) => {
    expect(relaySubmitFailure(new RelayApiError(code, status, 'text'))).toBe(failure);
  });

  it.each([
    ['a missing base URL', new RelayUnavailableError('not_configured', 'text'), 'refused'],
    ['a network failure', new RelayUnavailableError('network', 'text'), 'unknown'],
    ['a timeout', new RelayUnavailableError('timeout', 'text'), 'unknown'],
    ['an answer that does not parse', new RelayUnavailableError('bad_response', 'text'), 'unknown'],
    ['an answer for another job', new RelayMismatchError('text'), 'unknown'],
    ['a plain error', new Error('text'), 'unknown']
  ])('classifies %s as %s', (_name, error, failure) => {
    expect(relaySubmitFailure(error)).toBe(failure);
  });
});

describe('the error codes', () => {
  it('lists each code once, the target refusal included', () => {
    expect(new Set(RELAY_ERROR_CODES).size).toBe(RELAY_ERROR_CODES.length);
    expect(RELAY_ERROR_CODES).toContain('target_not_allowed');
    expect(RELAY_ERROR_CODES).not.toContain('token_not_allowed');
  });
});

describe('the typed errors', () => {
  it('carry their fields', () => {
    expect(new RelayRefusedError('target-not-allowed')).toMatchObject({
      name: 'RelayRefusedError',
      reason: 'target-not-allowed'
    });
    expect(new RelayRevertedError(JOB_ID, TX_HASH)).toMatchObject({
      name: 'RelayRevertedError',
      id: JOB_ID,
      txHash: TX_HASH
    });
    expect(new RelayExpiredError(JOB_ID, TX_HASH)).toMatchObject({
      name: 'RelayExpiredError',
      id: JOB_ID,
      txHash: TX_HASH
    });
    expect(new RelayStillPendingError(JOB, TX_HASH)).toMatchObject({
      name: 'RelayStillPendingError',
      job: JOB,
      id: JOB_ID,
      txHash: TX_HASH
    });
    const cause = new Error('lost');
    expect(new RelayUnknownOutcomeError(JOB, cause)).toMatchObject({
      name: 'RelayUnknownOutcomeError',
      job: JOB,
      id: JOB_ID,
      cause
    });
    expect(new RelayNotSubmittedError(JOB)).toMatchObject({ name: 'RelayNotSubmittedError', job: JOB, id: JOB_ID });
    expect(new RelayProviderRpcError(3, 'execution reverted', '0x08c379a0')).toMatchObject({
      name: 'RelayProviderRpcError',
      code: 3,
      message: 'execution reverted',
      data: '0x08c379a0'
    });
  });
});

describe('openRelayJobError', () => {
  const unknown = new RelayUnknownOutcomeError(JOB);
  const pending = new RelayStillPendingError(JOB, TX_HASH);

  it('finds the error itself', () => {
    expect(openRelayJobError(unknown)).toBe(unknown);
    expect(openRelayJobError(pending)).toBe(pending);
  });

  it('finds the error deep in a cause chain, as viem wraps a provider error', async () => {
    const provider = custom({
      request: async ({ method }) => {
        if (method === 'eth_chainId') return '0x2105';
        throw pending;
      }
    });
    const client = createWalletClient({ account: zeroAddress, chain: base, transport: provider });
    const wrapped = await client.sendTransaction({ to: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582', value: 0n }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(wrapped).not.toBe(pending);
    expect(openRelayJobError(wrapped)).toBe(pending);
    expect(openRelayJobError(new Error('outer', { cause: new Error('middle', { cause: unknown }) }))).toBe(unknown);
  });

  it.each<[string, unknown]>([
    ['a final relay error', new RelayRevertedError(JOB_ID, TX_HASH)],
    ['a not-submitted job', new RelayNotSubmittedError(JOB)],
    ['a refusal', new RelayApiError('bad_signature', 400, 'no')],
    ['an error with the text alone', new Error(unknown.message)],
    ['a value that is not an object', 'relay'],
    ['undefined', undefined]
  ])('finds nothing in %s', (_name, error) => {
    expect(openRelayJobError(error)).toBeUndefined();
  });

  it('stops at a cause chain that loops and after 16 links', () => {
    const loop = new Error('loop');
    Object.defineProperty(loop, 'cause', { value: loop });
    expect(openRelayJobError(loop)).toBeUndefined();
    let deep: Error = unknown;
    for (let index = 0; index < 16; index += 1) deep = new Error(`link ${index}`, { cause: deep });
    expect(openRelayJobError(deep)).toBeUndefined();
  });
});
