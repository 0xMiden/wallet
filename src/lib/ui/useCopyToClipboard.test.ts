import { renderHook, act } from '@testing-library/react';

import useCopyToClipboard from './useCopyToClipboard';

// jsdom does not implement the async Clipboard API, so `navigator.clipboard`
// is `undefined` and `navigator.clipboard.writeText(...)` would throw. Install
// a spy-able stub once; the spy is reset between tests in `beforeEach`.
const writeText = jest.fn();
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText },
  configurable: true,
  writable: true
});

/** Create a focusable field connected to the document (required for jsdom to
 * report it via `document.activeElement`). */
function makeField(value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.value = value;
  document.body.appendChild(input);
  return input;
}

/** Assign to the hook's `fieldRef.current`, which React types as a read-only
 * property on `RefObject`. Accepting the ref through a writable-`current` view
 * lets the test drive the ref without an `as any` cast. */
function setFieldRef(ref: { current: HTMLInputElement | null }, value: HTMLInputElement | null): void {
  ref.current = value;
}

describe('useCopyToClipboard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true
    });
  });

  afterEach(() => {
    // Discard (rather than run) any timer a test left pending so its callback
    // never fires setCopied outside of act() and taints the next test.
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  it('starts with copied=false, a null ref, and the expected API surface', () => {
    const { result } = renderHook(() => useCopyToClipboard());

    expect(result.current.copied).toBe(false);
    expect(result.current.fieldRef.current).toBeNull();
    expect(typeof result.current.copy).toBe('function');
    expect(typeof result.current.setCopied).toBe('function');
  });

  it('focuses, selects, writes the field value to the clipboard and flips copied=true after write succeeds', async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('secret-mnemonic');
    const focusSpy = jest.spyOn(field, 'focus');
    const selectSpy = jest.spyOn(field, 'select');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });

    act(() => {
      result.current.copy();
    });

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('secret-mnemonic');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it('does nothing when the field ref is null (no clipboard write, copied stays false)', () => {
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copy();
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
  });

  it('is a no-op on a second copy while a clipboard write is pending', async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('value-1');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    act(() => {
      result.current.copy();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);
  });

  it('does not report success when the clipboard write rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('not-copied');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    await act(async () => {
      result.current.copy();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(result.current.copied).toBe(false);
  });

  it('does not throw or report success when the Clipboard API is unavailable', () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true
    });
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('not-copied');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });

    expect(() => {
      act(() => {
        result.current.copy();
      });
    }).not.toThrow();
    expect(result.current.copied).toBe(false);
  });

  it('resets copied and blurs the field after the default 2s delay when it is still focused', async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('blur-me');
    const blurSpy = jest.spyOn(field, 'blur');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);
    expect(document.activeElement).toBe(field);

    // Just before the default 2000ms delay nothing has fired yet.
    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(result.current.copied).toBe(true);
    expect(blurSpy).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(field);
  });

  it('honours a custom copyDelay', async () => {
    const { result } = renderHook(() => useCopyToClipboard(500));
    const field = makeField('custom-delay');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('resets copied but does NOT blur when the field is no longer the active element', async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('not-active');
    const other = makeField('other');
    const blurSpy = jest.spyOn(field, 'blur');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    // Move focus elsewhere so `document.activeElement === textarea` is false.
    act(() => {
      other.focus();
    });
    expect(document.activeElement).toBe(other);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(result.current.copied).toBe(false);
    expect(blurSpy).not.toHaveBeenCalled();
  });

  it('resets copied without blurring when the field ref has been cleared before the timeout fires', async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('cleared');
    const blurSpy = jest.spyOn(field, 'blur');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    // Clear the ref so the `textarea` guard is falsy inside the timeout.
    act(() => {
      setFieldRef(result.current.fieldRef, null);
    });

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(result.current.copied).toBe(false);
    expect(blurSpy).not.toHaveBeenCalled();
  });

  it('clears the pending timeout on unmount so copied never resets after teardown', async () => {
    const clearSpy = jest.spyOn(window, 'clearTimeout');
    const { result, unmount } = renderHook(() => useCopyToClipboard());
    const field = makeField('unmount');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    unmount();
    expect(clearSpy).toHaveBeenCalled();

    // Advancing past the delay must not throw or touch anything post-teardown.
    act(() => {
      jest.advanceTimersByTime(2000);
    });

    clearSpy.mockRestore();
  });

  it('exposes setCopied to drive the copied state directly', () => {
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.setCopied(true);
    });
    expect(result.current.copied).toBe(true);

    // The effect scheduled a reset; let it run so no timers leak.
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(result.current.copied).toBe(false);
  });
});
