/**
 * `useGuardianAvailability` pings every endpoint in parallel and reports each
 * verdict as it settles — an endpoint absent from the map is still checking,
 * a slow ping never delays the others, and a late result must not land on an
 * unmounted component or a superseded endpoint set.
 */
import { act, renderHook } from '@testing-library/react';

import { useGuardianAvailability } from './useGuardianAvailability';

const mockPing = jest.fn();
jest.mock('lib/miden/guardian/availability', () => ({
  pingGuardianEndpoint: (...args: unknown[]) => mockPing(...args)
}));

/** One controllable ping per endpoint, resolved manually by tests. */
function deferredPings(): Map<string, (online: boolean) => void> {
  const resolvers = new Map<string, (online: boolean) => void>();
  mockPing.mockImplementation(
    (endpoint: string) =>
      new Promise<boolean>(resolve => {
        resolvers.set(endpoint, resolve);
      })
  );
  return resolvers;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useGuardianAvailability', () => {
  it('pings every endpoint and reports verdicts independently as they settle', async () => {
    const resolvers = deferredPings();
    const endpoints = ['https://a.example.com', 'https://b.example.com'];
    const { result } = renderHook(() => useGuardianAvailability(endpoints));

    // Nothing settled yet: everything is still "checking" (absent from the map).
    expect(result.current).toEqual({});
    expect(mockPing).toHaveBeenCalledTimes(2);

    await act(async () => resolvers.get('https://b.example.com')!(false));
    expect(result.current).toEqual({ 'https://b.example.com': 'offline' });

    await act(async () => resolvers.get('https://a.example.com')!(true));
    expect(result.current).toEqual({
      'https://a.example.com': 'online',
      'https://b.example.com': 'offline'
    });
  });

  it('drops a late verdict after unmount instead of setting state', async () => {
    const resolvers = deferredPings();
    const endpoint = 'https://late.example.com';
    const { unmount } = renderHook(() => useGuardianAvailability([endpoint]));

    unmount();
    // Resolving after unmount must be inert — no React "setState on unmounted
    // component" warning, no throw.
    await act(async () => resolvers.get(endpoint)!(true));
  });

  // Regression: the effect used to key on array IDENTITY, so a caller passing
  // an inline array looped forever (reset state → re-render → new array →
  // effect again). Same content must mean no re-ping, whatever the identity.
  it('does not re-ping when a rerender passes a fresh array with the same endpoints', async () => {
    const resolvers = deferredPings();
    const { result, rerender } = renderHook(({ endpoints }) => useGuardianAvailability(endpoints), {
      initialProps: { endpoints: ['https://same.example.com'] }
    });

    await act(async () => resolvers.get('https://same.example.com')!(true));
    rerender({ endpoints: ['https://same.example.com'] });

    expect(mockPing).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ 'https://same.example.com': 'online' });
  });

  it('re-pings and clears stale verdicts when the endpoint set changes', async () => {
    const resolvers = deferredPings();
    const first = ['https://old.example.com'];
    const second = ['https://new.example.com'];
    const { result, rerender } = renderHook(({ endpoints }) => useGuardianAvailability(endpoints), {
      initialProps: { endpoints: first }
    });

    await act(async () => resolvers.get('https://old.example.com')!(false));
    expect(result.current).toEqual({ 'https://old.example.com': 'offline' });

    rerender({ endpoints: second });
    // The old verdict is gone and the new endpoint is being pinged.
    expect(result.current).toEqual({});
    expect(mockPing).toHaveBeenLastCalledWith('https://new.example.com');

    await act(async () => resolvers.get('https://new.example.com')!(true));
    expect(result.current).toEqual({ 'https://new.example.com': 'online' });
  });
});
