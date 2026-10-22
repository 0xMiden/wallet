import React, { useLayoutEffect } from 'react';

import { act, renderHook } from '@testing-library/react';

import { useMainnetLaunched } from './use-mainnet-launch';

// The remote config's section, as the runtime hands it to this realm; null stands for no accepted document.
let mockCountdown: { enabled: boolean; launchAt?: number } | null = null;
jest.mock('./use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({
    network: 'testnet',
    status: 'ready',
    config: mockCountdown === null ? null : { mainnetCountdown: mockCountdown },
    derived: null,
    lastFetch: null
  })
}));

const LAUNCH_AT = Date.parse('2026-10-26T14:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

function restoreVisibility(): void {
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  else Reflect.deleteProperty(document, 'visibilityState');
}

describe('useMainnetLaunched', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(LAUNCH_AT - DAY_MS);
    mockCountdown = { enabled: true, launchAt: LAUNCH_AT };
    setVisibility('visible');
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreVisibility();
  });

  it('is false before the moment and true from the moment on', () => {
    const before = renderHook(() => useMainnetLaunched());
    expect(before.result.current).toBe(false);
    before.unmount();

    jest.setSystemTime(LAUNCH_AT);
    expect(renderHook(() => useMainnetLaunched()).result.current).toBe(true);
  });

  it('turns true at the moment without a re-render from outside', () => {
    jest.setSystemTime(LAUNCH_AT - 5_000);
    const { result } = renderHook(() => useMainnetLaunched());
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('catches a forward system-clock correction while a launch is pending', () => {
    jest.setSystemTime(LAUNCH_AT - 60_000);
    const { result } = renderHook(() => useMainnetLaunched());
    expect(result.current).toBe(false);

    act(() => {
      jest.setSystemTime(LAUNCH_AT + 60_000);
      jest.advanceTimersByTime(1_000);
    });

    expect(result.current).toBe(true);
  });

  it('catches a forward clock correction when the page becomes visible', () => {
    setVisibility('hidden');
    jest.setSystemTime(LAUNCH_AT - 60_000);
    const { result } = renderHook(() => useMainnetLaunched());
    expect(result.current).toBe(false);

    act(() => {
      jest.setSystemTime(LAUNCH_AT + 60_000);
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(result.current).toBe(true);
  });

  it('rechecks the clock after the first render commits', () => {
    jest.setSystemTime(LAUNCH_AT - 60_000);
    const ClockAdvancingWrapper = ({ children }: React.PropsWithChildren) => {
      useLayoutEffect(() => {
        jest.setSystemTime(LAUNCH_AT + 60_000);
      }, []);
      return React.createElement(React.Fragment, null, children);
    };

    const { result } = renderHook(() => useMainnetLaunched(), { wrapper: ClockAdvancingWrapper });

    expect(result.current).toBe(true);
  });

  it('reaches a moment further off than one timer can wait', () => {
    // Hidden, so the advance is the capped chain and not a one-second poll across these weeks.
    setVisibility('hidden');
    jest.setSystemTime(LAUNCH_AT - 40 * DAY_MS);
    const { result } = renderHook(() => useMainnetLaunched());

    act(() => {
      jest.advanceTimersByTime(39 * DAY_MS);
    });
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(DAY_MS);
    });
    expect(result.current).toBe(true);
  });

  it.each([
    ['the switch is off', { enabled: false, launchAt: LAUNCH_AT }],
    ['the switch is on with no moment', { enabled: true }],
    ['no document has been accepted', null]
  ])('stays false after the moment while %s', (_label, countdown) => {
    mockCountdown = countdown;
    jest.setSystemTime(LAUNCH_AT + DAY_MS);
    expect(renderHook(() => useMainnetLaunched()).result.current).toBe(false);
  });

  it('follows a document that moves the moment', () => {
    jest.setSystemTime(LAUNCH_AT);
    const { result, rerender } = renderHook(() => useMainnetLaunched());
    expect(result.current).toBe(true);

    mockCountdown = { enabled: true, launchAt: LAUNCH_AT + DAY_MS };
    rerender();
    expect(result.current).toBe(false);

    mockCountdown = { enabled: true, launchAt: LAUNCH_AT - DAY_MS };
    rerender();
    expect(result.current).toBe(true);
  });
});
