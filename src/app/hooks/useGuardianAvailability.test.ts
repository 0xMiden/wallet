/**
 * `useGuardianAvailability` pings every endpoint in parallel and reports each
 * verdict as it settles — an endpoint absent from the map is still checking,
 * a slow ping never delays the others, and a late result must not land on an
 * unmounted component or a superseded endpoint set.
 */
import { act, renderHook } from '@testing-library/react';

import { GUARDIAN_AVAILABILITY_REPROBE_MS, useGuardianAvailability } from './useGuardianAvailability';

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
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolvers = deferredPings();
    const endpoint = 'https://late.example.com';
    const { unmount } = renderHook(() => useGuardianAvailability([endpoint]));

    unmount();
    // Resolving after unmount must be inert — no React "setState on unmounted
    // component" warning, no throw.
    await expect(act(async () => resolvers.get(endpoint)!(true))).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Regression: the effect used to key on array IDENTITY, so a caller passing
  // an inline array looped forever (reset state → re-render → new array →
  // effect again). Same content must mean no re-ping, whatever the identity.
  it('does not re-probe on rerender alone when a fresh array carries the same endpoints', async () => {
    const resolvers = deferredPings();
    const { result, rerender } = renderHook(({ endpoints }) => useGuardianAvailability(endpoints), {
      initialProps: { endpoints: ['https://same.example.com'] }
    });

    await act(async () => resolvers.get('https://same.example.com')!(true));
    rerender({ endpoints: ['https://same.example.com'] });

    expect(mockPing).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ 'https://same.example.com': 'online' });
  });

  it('re-probes on the interval and clears an offline verdict when the operator recovers', async () => {
    jest.useFakeTimers();
    try {
      const endpoint = 'https://flaky.example.com';
      mockPing.mockResolvedValueOnce(false).mockResolvedValue(true);
      const { result } = renderHook(() => useGuardianAvailability([endpoint]));

      await act(async () => undefined);
      expect(result.current).toEqual({ [endpoint]: 'offline' });

      // A one-shot probe left this verdict up for the life of the screen — on the
      // picker the outage banner's CTA routes to, where the user may well be
      // waiting for exactly this recovery.
      await act(async () => {
        jest.advanceTimersByTime(GUARDIAN_AVAILABILITY_REPROBE_MS);
      });

      expect(mockPing).toHaveBeenCalledTimes(2);
      expect(result.current).toEqual({ [endpoint]: 'online' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-probes immediately when the app returns to the foreground', async () => {
    jest.useFakeTimers();
    try {
      const endpoint = 'https://resumed.example.com';
      mockPing.mockResolvedValue(true);
      renderHook(() => useGuardianAvailability([endpoint]));
      await act(async () => undefined);
      expect(mockPing).toHaveBeenCalledTimes(1);

      // A wallet spends most of its life backgrounded; verdicts from before the
      // suspend describe a different moment.
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(mockPing).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips an interval round while the document is hidden', async () => {
    jest.useFakeTimers();
    const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      mockPing.mockResolvedValue(true);
      renderHook(() => useGuardianAvailability(['https://hidden.example.com']));
      await act(async () => undefined);
      expect(mockPing).toHaveBeenCalledTimes(1); // the mount probe still runs

      await act(async () => {
        jest.advanceTimersByTime(GUARDIAN_AVAILABILITY_REPROBE_MS * 3);
      });

      // Probing a background tab buys nothing and still costs the operator.
      expect(mockPing).toHaveBeenCalledTimes(1);
    } finally {
      visibility.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does not start a second round while one is still in flight', async () => {
    jest.useFakeTimers();
    try {
      const resolvers = deferredPings();
      const endpoint = 'https://slow.example.com';
      renderHook(() => useGuardianAvailability([endpoint]));
      expect(mockPing).toHaveBeenCalledTimes(1);

      // Foreground return landing on top of an unsettled round must not fan out
      // a duplicate request at an operator that is already struggling.
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      expect(mockPing).toHaveBeenCalledTimes(1);

      await act(async () => resolvers.get(endpoint)!(true));
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(mockPing).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
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
