import React from 'react';

import { act, renderHook } from '@testing-library/react';

import { useClipboardCopy } from './useClipboardCopy';

let resolveWrite: (() => void) | undefined;
const mockWrite = jest.fn(
  (..._args: unknown[]) =>
    new Promise<void>(resolve => {
      resolveWrite = resolve;
    })
);
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: (...args: unknown[]) => mockWrite(...args) } }));

beforeEach(() => {
  jest.clearAllMocks();
  resolveWrite = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

it('writes the given text and flips copied true, then false after the feedback window', async () => {
  jest.useFakeTimers();
  const { result } = renderHook(() => useClipboardCopy('0xabc123'));

  await act(async () => {
    const p = result.current.copy();
    resolveWrite?.();
    await p;
  });

  expect(mockWrite).toHaveBeenCalledWith({ string: '0xabc123' });
  expect(result.current.copied).toBe(true);

  act(() => {
    jest.advanceTimersByTime(1500);
  });
  expect(result.current.copied).toBe(false);
});

it('does not arm the revert timer for a write that resolves after unmount', async () => {
  // React 18 silently no-ops a `setState` call on an unmounted fiber (no console warning to
  // assert on), so the guard's real, testable effect is the SIDE EFFECT it must not run: arming
  // `setTimeout` for the "revert to not-copied" step. Spy on the global directly rather than
  // relying on React's (removed) unmounted-update warning.
  const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  const { result, unmount } = renderHook(() => useClipboardCopy('0xabc123'));

  let copyPromise: Promise<void>;
  act(() => {
    copyPromise = result.current.copy();
  });

  unmount();
  setTimeoutSpy.mockClear();

  // Resolve the write only after the component is gone.
  await act(async () => {
    resolveWrite?.();
    await copyPromise;
  });

  expect(setTimeoutSpy).not.toHaveBeenCalled();

  setTimeoutSpy.mockRestore();
});

it('resets the mounted guard on a remount, so feedback still works afterward', async () => {
  // React 18 Strict Mode (dev only) mounts, unmounts, then remounts every component once, on the
  // SAME hook call — so `mountedRef` isn't a fresh `useRef(true)` the second time around; only
  // the effect's own setup can put it back to `true`. Without that reset, the cleanup's `false`
  // sticks forever and every `copy()` after the remount silently no-ops (the early return added
  // for the unmount guard fires even though the component is back on screen).
  const { result } = renderHook(() => useClipboardCopy('0xabc123'), { wrapper: React.StrictMode });

  await act(async () => {
    const p = result.current.copy();
    resolveWrite?.();
    await p;
  });

  expect(result.current.copied).toBe(true);
});
