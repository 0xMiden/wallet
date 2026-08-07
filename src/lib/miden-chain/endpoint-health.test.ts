import { act, renderHook, waitFor } from '@testing-library/react';

import { probeEndpointHealth, useEndpointHealth } from './endpoint-health';

describe('probeEndpointHealth', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns idle for an empty url', async () => {
    expect(await probeEndpointHealth('', 'reachability')).toBe('idle');
  });

  it('reachability: resolves fetch => reachable', async () => {
    global.fetch = jest.fn().mockResolvedValue({}) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://x', 'reachability')).toBe('reachable');
  });

  it('reachability: thrown fetch => error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('nope')) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://x', 'reachability')).toBe('error');
  });

  it('faucet-api: 2xx JSON => reachable', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: '0x1' }) }) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://f', 'faucet-api')).toBe('reachable');
  });

  it('faucet-api: non-2xx => error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://f', 'faucet-api')).toBe('error');
  });
});

describe('useEndpointHealth', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('stays idle for an empty url: no timer is scheduled and fetch is never called', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useEndpointHealth('', 'reachability'));

    expect(result.current).toBe('idle');

    // If a timer had been (incorrectly) scheduled, advancing past the debounce
    // window would fire it. Confirm nothing happens.
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(result.current).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-empty url: goes pending immediately, then reachable once the debounce fires and the probe resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({}) as unknown as typeof fetch;

    const { result } = renderHook(() => useEndpointHealth('https://x', 'reachability'));

    // Synchronous effect: pending before the debounce timer ever fires.
    expect(result.current).toBe('pending');

    act(() => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => expect(result.current).toBe('reachable'));
  });

  it('stale-guard: clearTimeout cancels an un-fired debounce when the url changes before it fires', () => {
    // A's probe would reject (=> 'error') if it ever ran; B's resolves (=> 'reachable').
    // If the debounce weren't cancelled, both timers would fire on the same
    // advance and whichever settles last would decide the outcome.
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url === 'https://a' ? Promise.reject(new Error('should never be called')) : Promise.resolve({});
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, rerender } = renderHook(({ url }) => useEndpointHealth(url, 'reachability'), {
      initialProps: { url: 'https://a' }
    });

    expect(result.current).toBe('pending');

    // Switch to B before A's 500ms debounce elapses. The effect cleanup runs
    // `clearTimeout` on A's still-pending timer before B's effect schedules its own.
    rerender({ url: 'https://b' });
    expect(result.current).toBe('pending');

    act(() => {
      jest.advanceTimersByTime(500);
    });

    return waitFor(() => expect(result.current).toBe('reachable')).then(() => {
      // A's debounce never fired, so its fetch (which would reject) was never invoked.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('https://b', expect.anything());
    });
  });

  it('stale-guard: a superseded in-flight probe cannot overwrite a newer url status', async () => {
    // A's debounce is allowed to fire (its fetch starts and stays pending), then
    // the url changes to B before A resolves. Only the `latest` ref-token check
    // (not clearTimeout, since A's timer already fired) can prevent A's eventual
    // rejection from clobbering B's status.
    let resolveA!: (value: unknown) => void;
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://a') {
        return new Promise(resolve => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({});
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, rerender } = renderHook(({ url }) => useEndpointHealth(url, 'reachability'), {
      initialProps: { url: 'https://a' }
    });

    expect(result.current).toBe('pending');

    // Fire A's debounce: probeEndpointHealth('https://a', ...) starts and is now
    // in-flight (its fetch promise is still unresolved).
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current).toBe('pending');

    // Switch to B while A's probe is still in flight. This bumps the `latest`
    // token, so even though A's timer already fired (clearTimeout can't help here),
    // A's eventual result is stale once it lands.
    rerender({ url: 'https://b' });
    expect(result.current).toBe('pending');

    act(() => {
      jest.advanceTimersByTime(500);
    });
    await waitFor(() => expect(result.current).toBe('reachable'));

    // Let A's stale probe resolve now. Without the token guard this would flip
    // the status; with it, B's 'reachable' must be left untouched.
    await act(async () => {
      resolveA({});
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toBe('reachable');
  });
});
