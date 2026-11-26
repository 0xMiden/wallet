import React, { type ReactNode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { PageActiveContext } from 'app/layouts/page-active';
import type { RelayConfig } from 'lib/remote-config/schema';

import { RelayApiError, RelayUnavailableError } from './errors';
import { EXECUTOR, FEE_RECIPIENT, relayConfig } from './testing';
import type { RelayService } from './types';
import {
  RELAY_SERVICE_CACHE_MS,
  type RelayServiceState,
  relayServiceStateOf,
  useRelayService
} from './use-relay-service';

const BASE = 'https://relay.example.workers.dev';
const SERVICE: RelayService = { mode: 'sponsor', executor: EXECUTOR, chains: [1, 8453] };

let mockRelay: RelayConfig | null = relayConfig(BASE);
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectRelayConfig: () => mockRelay,
  getRelayConfig: () => mockRelay
}));

const mockFetchRelayService = jest.fn(async (): Promise<RelayService> => SERVICE);
jest.mock('./client', () => ({ fetchRelayService: () => mockFetchRelayService() }));

/** One SWR cache for every hook of a render, so two readers share one read. */
function renderService(enabled: boolean, active = true, dedupe?: number) {
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, ...(dedupe === undefined ? {} : { dedupingInterval: dedupe }) }}>
      <PageActiveContext.Provider value={active}>{children}</PageActiveContext.Provider>
    </SWRConfig>
  );
  return renderHook(
    (): [RelayServiceState, RelayServiceState] => [useRelayService(enabled), useRelayService(enabled)],
    {
      wrapper
    }
  );
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  mockRelay = relayConfig(BASE);
  delete process.env.MIDEN_EVM_RELAY_URL;
  mockFetchRelayService.mockReset().mockResolvedValue(SERVICE);
});

describe('useRelayService', () => {
  it('reads the service one time for every reader while the page is on screen', async () => {
    const { result } = renderService(true);

    expect(result.current[0]).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', service: SERVICE }));
    expect(result.current[1]).toEqual({ status: 'ready', service: SERVICE });
    expect(mockFetchRelayService).toHaveBeenCalledTimes(1);
  });

  it('keeps the answer for a short time', () => {
    expect(RELAY_SERVICE_CACHE_MS).toBe(60_000);
  });

  it.each<[string, boolean, boolean, RelayConfig | null, string]>([
    ['when the caller does not ask', false, true, relayConfig(BASE), 'off'],
    ['while the relay is off', true, true, null, 'off'],
    ['off screen', true, false, relayConfig(BASE), 'loading']
  ])('reads nothing %s', async (_name, enabled, active, relay, status) => {
    mockRelay = relay;
    const { result } = renderService(enabled, active);
    await flush();

    expect(mockFetchRelayService).not.toHaveBeenCalled();
    expect(result.current[0].status).toBe(status);
  });

  it('gives an answer with another executor as unreachable, never as data', async () => {
    mockFetchRelayService.mockResolvedValue({ ...SERVICE, executor: FEE_RECIPIENT });
    const { result } = renderService(true);

    await waitFor(() => expect(result.current[0].status).toBe('unreachable'));
  });

  it.each<[string, Error]>([
    ['an older service with no route (404 not_found)', new RelayApiError('not_found', 404, 'relay (404 not_found)')],
    ['a network failure', new RelayUnavailableError('network', 'relay /v1/chains: the request failed (network)')],
    ['a timeout', new RelayUnavailableError('timeout', 'relay /v1/chains: the request failed (timeout)')]
  ])('gives %s as unreachable and does not read again on its own', async (_name, error) => {
    mockFetchRelayService.mockRejectedValue(error);
    const { result } = renderService(true);

    await waitFor(() => expect(result.current[0]).toEqual({ status: 'unreachable', error }));
    await flush();
    expect(mockFetchRelayService).toHaveBeenCalledTimes(1);
  });
});

describe('relayServiceStateOf', () => {
  it('keeps a good answer over a later error', () => {
    expect(relayServiceStateOf(true, SERVICE, new Error('later'))).toEqual({ status: 'ready', service: SERVICE });
  });
});
