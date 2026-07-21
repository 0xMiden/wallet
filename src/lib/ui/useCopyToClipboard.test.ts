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
    writeText.mockClear();
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

  it('focuses, selects, writes the field value to the clipboard and flips copied=true', () => {
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

  it('is a no-op on a second copy while still in the copied state', () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('value-1');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });
    expect(writeText).toHaveBeenCalledTimes(1);

    // Second call short-circuits because `copied` is already true.
    act(() => {
      result.current.copy();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('resets copied and blurs the field after the default 2s delay when it is still focused', () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('blur-me');
    const blurSpy = jest.spyOn(field, 'blur');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
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

  it('honours a custom copyDelay', () => {
    const { result } = renderHook(() => useCopyToClipboard(500));
    const field = makeField('custom-delay');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('resets copied but does NOT blur when the field is no longer the active element', () => {
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

  it('resets copied without blurring when the field ref has been cleared before the timeout fires', () => {
    const { result } = renderHook(() => useCopyToClipboard());
    const field = makeField('cleared');
    const blurSpy = jest.spyOn(field, 'blur');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });

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

  it('clears the pending timeout on unmount so copied never resets after teardown', () => {
    const clearSpy = jest.spyOn(window, 'clearTimeout');
    const { result, unmount } = renderHook(() => useCopyToClipboard());
    const field = makeField('unmount');

    act(() => {
      setFieldRef(result.current.fieldRef, field);
    });
    act(() => {
      result.current.copy();
    });

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
