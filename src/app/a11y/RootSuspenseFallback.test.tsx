import React from 'react';

import { act, render, screen } from '@testing-library/react';

import RootSuspenseFallback from './RootSuspenseFallback';

// The scheduled re-render is driven by `use-force-update`. Mock it so the hook
// returns a stable, inspectable function — this lets us assert that the value
// passed to `setTimeout` is exactly the force-update callback.
const forceUpdate = jest.fn();
jest.mock('use-force-update', () => ({
  __esModule: true,
  default: () => forceUpdate
}));

// Isolate the component from the Spinner subtree (CircularProgress / brand
// colors); we only care about this file's behavior.
jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => <div data-testid="spinner" />
}));

// Matches the module-level `DELAY` constant in the source under test.
const DELAY = 5_000;
// Fixed epoch used as the fake "now". The source keeps a module-level
// `startedAt` that is set on the very FIRST render and never reset, so the
// first test in this file exercises the `!startedAt` (unset) branch and all
// later tests exercise the already-set branch — this ordering is intentional.
const T0 = 1_000_000_000_000;

describe('RootSuspenseFallback', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    forceUpdate.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders a centered spinner', () => {
    jest.setSystemTime(T0);

    const { container } = render(<RootSuspenseFallback />);

    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    // Outer layout wrapper is present.
    expect(container.querySelector('.h-screen.bg-app-bg')).toBeInTheDocument();
  });

  it('schedules a forced update for the full delay when no time has elapsed', () => {
    // The very first render happened in the previous test at T0, which is when
    // module-level `startedAt` was set (exercising the `!startedAt` branch).
    // Here Date.now() === startedAt === T0, so no time has elapsed and the
    // timeout is scheduled for the full DELAY.
    jest.setSystemTime(T0);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    render(<RootSuspenseFallback />);

    expect(setTimeoutSpy).toHaveBeenCalledWith(forceUpdate, DELAY);
  });

  it('clears the scheduled timeout when unmounted (cleanup branch)', () => {
    // startedAt is now set (= T0) from the previous test; advance the clock
    // within the delay window so a timeout is scheduled and can be cleared.
    jest.setSystemTime(T0 + 2_000);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    const { unmount } = render(<RootSuspenseFallback />);

    // Remaining time = DELAY - elapsed = 5000 - 2000 = 3000.
    expect(setTimeoutSpy).toHaveBeenCalledWith(forceUpdate, DELAY - 2_000);
    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('invokes forceUpdate once the remaining delay elapses', () => {
    jest.setSystemTime(T0 + 1_000);

    render(<RootSuspenseFallback />);

    expect(forceUpdate).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DELAY);
    });

    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a timeout once the delay has already elapsed (returns undefined)', () => {
    // startedAt is T0; jump past the delay window so the timing guard is false
    // and the effect returns undefined without scheduling anything.
    jest.setSystemTime(T0 + DELAY + 1_000);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    render(<RootSuspenseFallback />);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });
});
