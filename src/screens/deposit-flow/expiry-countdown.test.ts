import { act, renderHook } from '@testing-library/react';

import { formatCountdown, useCountdown, useDeadlinePassed } from './expiry-countdown';

const NOW = Date.parse('2026-11-10T14:00:00Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('formatCountdown', () => {
  it.each([
    [1_200_000, '20:00'],
    [292_000, '4:52'],
    [9_999, '0:09'],
    [3_725_000, '1:02:05'],
    [0, '0:00'],
    [-5_000, '0:00']
  ])('shows %i ms as %s', (milliseconds, text) => {
    expect(formatCountdown(milliseconds)).toBe(text);
  });
});

describe('useCountdown', () => {
  it('counts down each second and stops at zero', () => {
    const { result } = renderHook(() => useCountdown(NOW + 2_500));
    expect(result.current).toBe(2_500);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(1_500);
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sets no timer for a time in the past', () => {
    const { result } = renderHook(() => useCountdown(NOW - 1));
    expect(result.current).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('useDeadlinePassed', () => {
  it('turns true once, when the deadline passes', () => {
    const { result } = renderHook(() => useDeadlinePassed(NOW + 60_000));
    expect(result.current).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    act(() => {
      jest.advanceTimersByTime(59_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is true for a past deadline and false for no deadline', () => {
    expect(renderHook(() => useDeadlinePassed(NOW - 1)).result.current).toBe(true);
    expect(renderHook(() => useDeadlinePassed(Number.NaN)).result.current).toBe(false);
  });

  it('follows a new deadline', () => {
    const { result, rerender } = renderHook(({ deadline }) => useDeadlinePassed(deadline), {
      initialProps: { deadline: NOW - 1 }
    });
    expect(result.current).toBe(true);
    rerender({ deadline: Number.NaN });
    expect(result.current).toBe(false);
  });
});
