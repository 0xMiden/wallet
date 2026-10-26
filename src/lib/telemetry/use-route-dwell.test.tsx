import { act, renderHook } from '@testing-library/react';

import { ROUTE_DWELL_MS, useRouteDwell } from './use-route-dwell';

const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

describe('useRouteDwell', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is false while the route is merely current', () => {
    const { result } = renderHook(() => useRouteDwell(true));
    expect(result.current).toBe(false);
  });

  it('turns true once the route has held still long enough', () => {
    const { result } = renderHook(() => useRouteDwell(true));
    advance(ROUTE_DWELL_MS);
    expect(result.current).toBe(true);
  });

  it('never fires for a route the carousel only passed through', () => {
    // The whole point. Swiping from Overview to Swap commits /send, /receive and
    // /earn on the way past, and each of those used to open and close a flow —
    // matched, plausible, and describing nothing anyone did.
    const { result, rerender } = renderHook(({ active }) => useRouteDwell(active), {
      initialProps: { active: true }
    });

    advance(ROUTE_DWELL_MS - 1);
    rerender({ active: false });
    advance(ROUTE_DWELL_MS);

    expect(result.current).toBe(false);
  });

  it('drops immediately on leaving, with no trailing grace period', () => {
    // Leaving has to settle the flow at once. A symmetric delay here would
    // attribute the exit to whatever the user did next.
    const { result, rerender } = renderHook(({ active }) => useRouteDwell(active), {
      initialProps: { active: true }
    });
    advance(ROUTE_DWELL_MS);
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it('restarts the clock when the route is re-entered', () => {
    // Two brief visits do not add up to one dwell. Otherwise a user flicking
    // back and forth would eventually trip the gate without ever stopping.
    const { result, rerender } = renderHook(({ active }) => useRouteDwell(active), {
      initialProps: { active: true }
    });

    advance(ROUTE_DWELL_MS - 100);
    rerender({ active: false });
    rerender({ active: true });
    advance(ROUTE_DWELL_MS - 100);
    expect(result.current).toBe(false);

    advance(100);
    expect(result.current).toBe(true);
  });

  it('clears its timer on unmount, so a settled screen cannot flip after it is gone', () => {
    const { unmount } = renderHook(() => useRouteDwell(true));
    unmount();
    expect(() => advance(ROUTE_DWELL_MS)).not.toThrow();
  });
});
