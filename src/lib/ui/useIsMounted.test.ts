import { renderHook } from '@testing-library/react';

import useIsMounted from './useIsMounted';

// `useIsMounted` returns a stable getter that reports whether the owning
// component is currently mounted. Internally it flips a ref inside a mount
// effect (`true` on mount, `false` in the effect's cleanup). `renderHook`
// runs effects synchronously, so by the time `result.current` is readable the
// mount effect has already executed and the getter reports `true`; `unmount`
// runs the cleanup and flips it back to `false`.
describe('useIsMounted', () => {
  it('returns a function (the mounted getter)', () => {
    const { result } = renderHook(() => useIsMounted());

    expect(typeof result.current).toBe('function');
  });

  it('reports true once the mount effect has run', () => {
    const { result } = renderHook(() => useIsMounted());

    // The mount effect set mountedRef.current = true.
    expect(result.current()).toBe(true);
  });

  it('reports false after the component unmounts (cleanup branch)', () => {
    const { result, unmount } = renderHook(() => useIsMounted());

    // Capture the getter before teardown; it is stable and keeps pointing at
    // the same underlying ref after unmount.
    const isMounted = result.current;
    expect(isMounted()).toBe(true);

    unmount();

    // The effect's cleanup set mountedRef.current = false.
    expect(isMounted()).toBe(false);
  });

  it('keeps a stable getter identity across re-renders (useCallback [] dep)', () => {
    const { result, rerender } = renderHook(() => useIsMounted());

    const firstGetter = result.current;
    rerender();
    rerender();

    expect(result.current).toBe(firstGetter);
    // Still reports mounted after re-rendering without unmounting.
    expect(result.current()).toBe(true);
  });

  it('gives each hook instance its own independent mounted state', () => {
    const first = renderHook(() => useIsMounted());
    const second = renderHook(() => useIsMounted());

    const firstGetter = first.result.current;
    const secondGetter = second.result.current;

    expect(firstGetter()).toBe(true);
    expect(secondGetter()).toBe(true);

    // Unmounting one instance must not affect the other's mounted state.
    first.unmount();

    expect(firstGetter()).toBe(false);
    expect(secondGetter()).toBe(true);

    second.unmount();
    expect(secondGetter()).toBe(false);
  });
});
