import { renderHook, act } from '@testing-library/react';

import useSafeState from './useSafeState';

// `useSafeState` delegates its "is this component still mounted?" check to the
// sibling `useIsMounted` hook. We mock that collaborator so we can drive the
// mounted/unmounted branch deterministically (its real behaviour flips a ref
// inside an effect, which is exercised by its own test).
let mockMounted = true;
const mockIsMountedFn = jest.fn(() => mockMounted);

jest.mock('lib/ui/useIsMounted', () => ({
  __esModule: true,
  default: () => mockIsMountedFn
}));

describe('useSafeState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMounted = true;
  });

  describe('initial state', () => {
    it('uses a plain initial value', () => {
      const { result } = renderHook(() => useSafeState(5));

      expect(result.current[0]).toBe(5);
      expect(typeof result.current[1]).toBe('function');
    });

    it('supports a lazy initializer function, invoked exactly once', () => {
      const init = jest.fn(() => 'lazy');

      const { result } = renderHook(() => useSafeState(init));

      expect(result.current[0]).toBe('lazy');
      expect(init).toHaveBeenCalledTimes(1);
    });
  });

  describe('setState while mounted', () => {
    it('applies a direct value update', () => {
      const { result } = renderHook(() => useSafeState(0));

      act(() => {
        result.current[1](10);
      });

      expect(result.current[0]).toBe(10);
    });

    it('applies a functional updater', () => {
      const { result } = renderHook(() => useSafeState(1));

      act(() => {
        result.current[1](prev => prev + 41);
      });

      expect(result.current[0]).toBe(42);
    });

    it('keeps the same setState identity across re-renders', () => {
      const { result, rerender } = renderHook(() => useSafeState('stable'));

      const firstSetter = result.current[1];
      rerender();

      expect(result.current[1]).toBe(firstSetter);
    });
  });

  describe('setState after unmount (guarded branch)', () => {
    it('is a no-op when the component is no longer mounted', () => {
      const { result } = renderHook(() => useSafeState('mounted'));

      const setState = result.current[1];
      // Simulate the component having unmounted: the real useIsMounted would
      // now report false.
      mockMounted = false;

      act(() => {
        setState('should-be-ignored');
      });

      // State is untouched because the guard short-circuited before
      // setStatePure ran.
      expect(result.current[0]).toBe('mounted');
      expect(mockIsMountedFn).toHaveBeenCalled();
    });
  });

  describe('dependency-driven reset', () => {
    it('resets state to the current initialState when dep changes', () => {
      const { result, rerender } = renderHook(({ init, dep }) => useSafeState(init, dep), {
        initialProps: { init: 'first', dep: 1 }
      });

      // Mutate the state away from its initial value.
      act(() => {
        result.current[1]('user-edited');
      });
      expect(result.current[0]).toBe('user-edited');

      // Changing the dep resets to whatever initialState is now.
      rerender({ init: 'second', dep: 2 });

      expect(result.current[0]).toBe('second');
    });

    it('does NOT reset when dep is unchanged across re-renders', () => {
      const { result, rerender } = renderHook(({ init, dep }) => useSafeState(init, dep), {
        initialProps: { init: 'first', dep: 1 }
      });

      act(() => {
        result.current[1]('user-edited');
      });

      // Same dep value -> the effect's guard is false, state is preserved even
      // though initialState prop changed.
      rerender({ init: 'second', dep: 1 });

      expect(result.current[0]).toBe('user-edited');
    });

    it('never resets when no dep argument is supplied', () => {
      const { result, rerender } = renderHook(({ init }) => useSafeState(init), {
        initialProps: { init: 'first' }
      });

      act(() => {
        result.current[1]('user-edited');
      });

      // dep stays undefined on every render (undefined !== undefined is false),
      // so the reset branch is never taken.
      rerender({ init: 'second' });

      expect(result.current[0]).toBe('user-edited');
    });

    it('does not reset state on a dep change while unmounted', () => {
      const { result, rerender } = renderHook(({ init, dep }) => useSafeState(init, dep), {
        initialProps: { init: 'first', dep: 1 }
      });

      act(() => {
        result.current[1]('user-edited');
      });

      // Unmounted: the dep-change effect fires setState, but the mounted guard
      // inside setState swallows it.
      mockMounted = false;
      rerender({ init: 'second', dep: 2 });

      expect(result.current[0]).toBe('user-edited');
    });
  });
});
