import { initBridgeConfig } from 'lib/remote-config/runtime';
import { getRelayConfig } from 'lib/remote-config/values';

import { fetchRelayService, type RelayFetch, type RelayRequestInit } from './client';
import { RelayApiError, RelayMismatchError, RelayUnavailableError } from './errors';
import { assertRelayServiceMatches } from './guards';
import { parseRelayService } from './parse';
import { EXECUTOR, FEE_RECIPIENT, relayConfig, stubResponse, upperHex } from './testing';

jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: jest.fn() }));
jest.mock('lib/remote-config/values', () => ({ getRelayConfig: jest.fn() }));

const BASE = 'https://relay.example.workers.dev';

let calls: { url: string; init: RelayRequestInit }[] = [];

function fetchReturning(response: ReturnType<typeof stubResponse>): RelayFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return response;
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

const serviceBody = (overrides: Record<string, unknown> = {}) => ({
  mode: 'sponsor',
  executor: upperHex(EXECUTOR),
  chains: [1, 8453, 42161],
  ...overrides
});

beforeEach(() => {
  calls = [];
  delete process.env.MIDEN_EVM_RELAY_URL;
  jest.mocked(initBridgeConfig).mockReset();
  jest.mocked(getRelayConfig).mockReset().mockReturnValue(relayConfig(BASE));
});

describe('parseRelayService', () => {
  it('reads the mode, the executor in lower case and the chains, and ignores unknown fields', () => {
    expect(parseRelayService({ ...serviceBody(), version: 2 })).toEqual({
      mode: 'sponsor',
      executor: EXECUTOR,
      chains: [1, 8453, 42161]
    });
    expect(parseRelayService(serviceBody({ mode: 'deduct', chains: [] }))).toEqual({
      mode: 'deduct',
      executor: EXECUTOR,
      chains: []
    });
  });

  it.each<[string, unknown]>([
    ['a body that is not an object', []],
    ['an unknown mode', serviceBody({ mode: 'free' })],
    ['a missing mode', serviceBody({ mode: undefined })],
    ['an executor that is not an address', serviceBody({ executor: '0x1234' })],
    ['an executor of the wrong type', serviceBody({ executor: 42 })],
    ['chains that are not a list', serviceBody({ chains: '1,8453' })],
    ['a chain id in text', serviceBody({ chains: ['1'] })],
    ['a chain id that is not an integer', serviceBody({ chains: [1.5] })],
    ['a chain id of zero', serviceBody({ chains: [0] })],
    ['a chain id that is not safe', serviceBody({ chains: [2 ** 53] })],
    ['chains out of order', serviceBody({ chains: [8453, 1] })],
    ['a chain twice', serviceBody({ chains: [1, 1] })]
  ])('refuses %s', (_name, body) => {
    expect(() => parseRelayService(body)).toThrow(RelayUnavailableError);
  });
});

describe('fetchRelayService', () => {
  it('reads GET /v1/chains with no address and no credentials', async () => {
    const service = await fetchRelayService({ fetch: fetchReturning(stubResponse(200, serviceBody())) });

    expect(service).toEqual({ mode: 'sponsor', executor: EXECUTOR, chains: [1, 8453, 42161] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/v1/chains`);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('gives the 404 of an older service with no such route as a not_found error', async () => {
    const error = await failure(
      fetchRelayService({
        fetch: fetchReturning(stubResponse(404, { error: 'not_found', message: 'no such route' }))
      })
    );

    expect(error).toBeInstanceOf(RelayApiError);
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('refuses a body of the wrong shape', async () => {
    const error = await failure(
      fetchRelayService({ fetch: fetchReturning(stubResponse(200, serviceBody({ chains: [8453, 1] }))) })
    );

    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect(error).toMatchObject({ reason: 'bad_response' });
  });

  it('fails as a network failure when the request fails', async () => {
    const error = await failure(
      fetchRelayService({
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        }
      })
    );

    expect(error).toBeInstanceOf(RelayUnavailableError);
    expect(error).toMatchObject({ reason: 'network' });
  });

  it('sends nothing while the relay is not configured', async () => {
    jest.mocked(getRelayConfig).mockReturnValue(null);
    const fetchFn = jest.fn();

    const error = await failure(fetchRelayService({ fetch: fetchFn }));

    expect(error).toMatchObject({ reason: 'not_configured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('assertRelayServiceMatches', () => {
  it('takes the configured executor in any letter case', () => {
    expect(() =>
      assertRelayServiceMatches({ mode: 'sponsor', executor: EXECUTOR, chains: [1] }, { executor: upperHex(EXECUTOR) })
    ).not.toThrow();
  });

  it('refuses another executor', () => {
    expect(() =>
      assertRelayServiceMatches({ mode: 'sponsor', executor: FEE_RECIPIENT, chains: [1] }, { executor: EXECUTOR })
    ).toThrow(RelayMismatchError);
  });
});
