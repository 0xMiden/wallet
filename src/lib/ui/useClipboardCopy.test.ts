import React from 'react';

import { act, renderHook } from '@testing-library/react';

import { COPY_FEEDBACK_MS } from 'lib/animation/copy';

import { useClipboardCopy } from './useClipboardCopy';

let resolveWrite: (() => void) | undefined;
let rejectWrite: ((error: Error) => void) | undefined;
const mockWrite = jest.fn(
  (..._args: unknown[]) =>
    new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    })
);
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: (...args: unknown[]) => mockWrite(...args) } }));

beforeEach(() => {
  jest.clearAllMocks();
  resolveWrite = undefined;
  rejectWrite = undefined;
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

it('reports a rejected write as a failure, then idle after the feedback window', async () => {
  jest.useFakeTimers();
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useClipboardCopy('0xabc123'));

  await act(async () => {
    const p = result.current.copy();
    rejectWrite?.(new Error('denied'));
    await p;
  });

  expect(result.current.status).toBe('failure');
  expect(result.current.copied).toBe(false);
  expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Error));

  act(() => {
    jest.advanceTimersByTime(COPY_FEEDBACK_MS - 1);
  });
  expect(result.current.status).toBe('failure');
  act(() => {
    jest.advanceTimersByTime(1);
  });
  expect(result.current.status).toBe('idle');

  errorSpy.mockRestore();
});

it('keeps a failure that lands inside a success window up for its own full window', async () => {
  jest.useFakeTimers();
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useClipboardCopy('0xabc123'));
  const gap = 500;

  await act(async () => {
    const p = result.current.copy();
    resolveWrite?.();
    await p;
  });
  expect(result.current.status).toBe('success');

  act(() => {
    jest.advanceTimersByTime(gap);
  });
  await act(async () => {
    const p = result.current.copy();
    rejectWrite?.(new Error('denied'));
    await p;
  });
  expect(result.current.status).toBe('failure');

  // The success's timer would fire here had the failure not cleared it.
  act(() => {
    jest.advanceTimersByTime(COPY_FEEDBACK_MS - gap);
  });
  expect(result.current.status).toBe('failure');

  act(() => {
    jest.advanceTimersByTime(gap);
  });
  expect(result.current.status).toBe('idle');

  errorSpy.mockRestore();
});

it('does not arm the revert timer for a write that rejects after unmount', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  const { result, unmount } = renderHook(() => useClipboardCopy('0xabc123'));

  let copyPromise: Promise<void>;
  act(() => {
    copyPromise = result.current.copy();
  });

  unmount();
  setTimeoutSpy.mockClear();

  await act(async () => {
    rejectWrite?.(new Error('denied'));
    await copyPromise;
  });

  expect(setTimeoutSpy).not.toHaveBeenCalled();

  setTimeoutSpy.mockRestore();
  errorSpy.mockRestore();
});

it('ignores a copy while a write is in flight, and writes again once that write has rejected', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useClipboardCopy('0xabc123'));

  let first: Promise<void>;
  act(() => {
    first = result.current.copy();
  });
  act(() => {
    void result.current.copy();
  });
  expect(mockWrite).toHaveBeenCalledTimes(1);

  // Settled by REJECTING: a latch released only on success would still be held after this.
  await act(async () => {
    rejectWrite?.(new Error('denied'));
    await first;
  });
  expect(result.current.status).toBe('failure');

  act(() => {
    void result.current.copy();
  });
  expect(mockWrite).toHaveBeenCalledTimes(2);

  errorSpy.mockRestore();
});
