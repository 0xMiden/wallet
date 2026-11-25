import {
  RelayApiError,
  RelayMismatchError,
  RelayUnavailableError,
  relayErrorAction,
  type RelayErrorCode
} from './errors';

describe('relayErrorAction', () => {
  it.each<[RelayErrorCode, number, string]>([
    ['stale_request', 409, 'sign-again'],
    ['simulation_failed', 409, 'sign-again'],
    ['rate_limited', 429, 'wait'],
    ['busy', 409, 'wait'],
    ['relayer_unfunded', 503, 'wait'],
    ['rpc_unavailable', 502, 'wait'],
    ['service_unavailable', 503, 'wait'],
    ['internal_error', 500, 'wait'],
    ['invalid_request', 400, 'stop'],
    ['unsupported_chain', 400, 'stop'],
    ['unsupported_kind', 400, 'stop'],
    ['token_not_allowed', 400, 'stop'],
    ['below_minimum', 400, 'stop'],
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
    ['a mismatch', new RelayMismatchError('text'), 'stop'],
    ['a plain error', new Error('text'), 'stop'],
    ['a value that is not an error', 'text', 'stop']
  ])('classifies %s as %s', (_name, error, action) => {
    expect(relayErrorAction(error)).toBe(action);
  });
});
