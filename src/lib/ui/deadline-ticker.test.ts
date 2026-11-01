import { act, renderHook } from '@testing-library/react';

import { subscribeDeadlineSample, useDeadlineNow } from './deadline-ticker';

const START = Date.parse('2026-10-30T12:00:00Z');

const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('the deadline ticker (#2060)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    jest.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('samples every second up to the deadline, then stops', () => {
    const { result, unmount } = renderHook(() => useDeadlineNow(START + 2_500));
    expect(result.current).toBe(START);

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(START + 1_000);

    act(() => {
      jest.advanceTimersByTime(1_500);
    });
    expect(result.current).toBe(START + 2_500);
    expect(jest.getTimerCount()).toBe(0);

    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(START + 2_500);
    unmount();
  });

  it('arms nothing without a deadline', () => {
    const { unmount } = renderHook(() => useDeadlineNow(null));

    expect(jest.getTimerCount()).toBe(0);
    unmount();
  });

  it('resamples on the way back to a visible page, not after the wait it armed', () => {
    const { result, unmount } = renderHook(() => useDeadlineNow(START + 60_000));

    act(() => setVisibility('hidden'));
    // A frozen page runs no timer: only the clock moves.
    jest.setSystemTime(START + 30_000);
    act(() => setVisibility('visible'));

    expect(result.current).toBe(START + 30_000);
    unmount();
  });

  it('drops its timer and its listener with the last subscriber', () => {
    const removed = jest.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useDeadlineNow(START + 60_000));
    expect(jest.getTimerCount()).toBe(1);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('keeps sampling for a later deadline once a sooner one has passed', () => {
    const samples: number[] = [];
    const stopSooner = subscribeDeadlineSample(START + 1_000, () => undefined);
    const stopLater = subscribeDeadlineSample(START + 3_000, now => samples.push(now));
    samples.length = 0;

    jest.advanceTimersByTime(3_000);

    expect(samples).toEqual([START + 1_000, START + 2_000, START + 3_000]);
    expect(jest.getTimerCount()).toBe(0);
    stopLater();
    stopSooner();
  });
});
