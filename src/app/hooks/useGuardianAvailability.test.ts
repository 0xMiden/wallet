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

  // Unmount has to STOP the hook, and what is observable about that is also what
  // costs something: the 30s interval and the two foreground listeners outlive
  // the component unless the effect's cleanup tears them down, so a picker
  // opened and closed a few times would leave one dead instance per visit
  // fanning out a round at every operator, forever.
  //
  // The in-round `if (cancelled) return` guard is deliberately NOT what this
  // asserts, because it cannot be: React 18 discards a setState on an unmounted
  // component silently (the warning it used to print is gone), so a verdict
  // landing after unmount looks identical with the guard and without it.
  it('stops probing after unmount', async () => {
    jest.useFakeTimers();
    try {
      const resolvers = deferredPings();
      const endpoint = 'https://late.example.com';
      const { unmount } = renderHook(() => useGuardianAvailability([endpoint]));
      await act(async () => resolvers.get(endpoint)!(true));
      expect(mockPing).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        jest.advanceTimersByTime(GUARDIAN_AVAILABILITY_REPROBE_MS * 3);
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });

      expect(mockPing).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // The other half of teardown: a verdict for a ping that was already out when
  // the screen closed still has to settle harmlessly — the round's promise chain
  // must not throw or reject into an unhandled rejection.
  it('absorbs a verdict that arrives after unmount', async () => {
    const resolvers = deferredPings();
    const endpoint = 'https://gone.example.com';
    const { unmount } = renderHook(() => useGuardianAvailability([endpoint]));

    unmount();

    await expect(act(async () => resolvers.get(endpoint)!(true))).resolves.toBeUndefined();
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

  // The case above changes the set only AFTER the first round settled, which is
  // the easy half. Changing it MID-round is where both guards used to fail, and
  // it is the real sequence: the picker swaps its option list while four pings
  // are out, so every probe in flight belongs to a set nobody is looking at.
  it('probes a set that replaces another one mid-round, and drops the superseded verdict', async () => {
    const resolvers = deferredPings();
    const { result, rerender } = renderHook(({ endpoints }) => useGuardianAvailability(endpoints), {
      initialProps: { endpoints: ['https://old.example.com'] }
    });
    expect(mockPing).toHaveBeenCalledTimes(1);

    // Swap the set while the first ping is still unsettled.
    rerender({ endpoints: ['https://new.example.com'] });

    // The new set must be probed straight away. The unsettled previous round used
    // to hold the in-flight slot, so this round never started and the picker sat
    // with no verdict for its current options until the 30s interval.
    expect(mockPing).toHaveBeenCalledTimes(2);
    expect(mockPing).toHaveBeenLastCalledWith('https://new.example.com');

    // The retired endpoint now answers. Its verdict belongs to a set that is no
    // longer on screen and must not be written: the single cancel flag was reset
    // by the very rerender that superseded this round, so this landed anyway.
    await act(async () => resolvers.get('https://old.example.com')!(true));
    expect(result.current).toEqual({});

    // And the live round still works after the stale one resolved through it.
    await act(async () => resolvers.get('https://new.example.com')!(false));
    expect(result.current).toEqual({ 'https://new.example.com': 'offline' });
  });

  // A superseded round handing the in-flight slot back would clear it out from
  // under the round that replaced it, re-opening the duplicate fan-out that slot
  // exists to prevent.
  it('keeps the in-flight slot held by the live round when a superseded round settles', async () => {
    jest.useFakeTimers();
    try {
      const resolvers = deferredPings();
      const { rerender } = renderHook(({ endpoints }) => useGuardianAvailability(endpoints), {
        initialProps: { endpoints: ['https://old.example.com'] }
      });
      rerender({ endpoints: ['https://new.example.com'] });
      expect(mockPing).toHaveBeenCalledTimes(2);

      // The stale round settles; the live round is still out.
      await act(async () => resolvers.get('https://old.example.com')!(true));

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(mockPing).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
