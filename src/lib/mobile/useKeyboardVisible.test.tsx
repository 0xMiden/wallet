/**
 * @jest-environment jsdom
 */
import { Keyboard } from '@capacitor/keyboard';
import { act, renderHook } from '@testing-library/react';

import { isMobile } from 'lib/platform';

import { useKeyboardVisible } from './useKeyboardVisible';

jest.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: jest.fn()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

const isMobileMock = isMobile as jest.Mock;
const addListenerMock = Keyboard.addListener as jest.Mock;

let listeners: Record<string, () => void>;
let removeMock: jest.Mock;

describe('useKeyboardVisible', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listeners = {};
    removeMock = jest.fn();
    addListenerMock.mockImplementation((event: string, cb: () => void) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: removeMock });
    });
  });

  it('stays false and registers nothing off mobile', async () => {
    isMobileMock.mockReturnValue(false);

    const { result } = renderHook(() => useKeyboardVisible());
    await act(async () => {});

    expect(result.current).toBe(false);
    expect(addListenerMock).not.toHaveBeenCalled();
  });

  it('flips true on keyboardWillShow and back on keyboardWillHide', async () => {
    isMobileMock.mockReturnValue(true);

    const { result } = renderHook(() => useKeyboardVisible());
    await act(async () => {});

    expect(result.current).toBe(false);

    act(() => listeners['keyboardWillShow']!());
    expect(result.current).toBe(true);

    act(() => listeners['keyboardWillHide']!());
    expect(result.current).toBe(false);
  });

  it('removes both listeners on unmount', async () => {
    isMobileMock.mockReturnValue(true);

    const { unmount } = renderHook(() => useKeyboardVisible());
    await act(async () => {});

    unmount();

    expect(removeMock).toHaveBeenCalledTimes(2);
  });

  it('stays false when the Keyboard plugin has no native implementation', async () => {
    isMobileMock.mockReturnValue(true);
    addListenerMock.mockRejectedValue(new Error('"Keyboard" plugin is not implemented on web'));

    const { result } = renderHook(() => useKeyboardVisible());
    await act(async () => {});

    expect(result.current).toBe(false);
  });

  it('removes the show listener if the hook unmounts before it finishes registering', async () => {
    isMobileMock.mockReturnValue(true);
    const showRemove = jest.fn();
    let resolveShow: () => void = () => {};
    addListenerMock.mockImplementationOnce(
      () => new Promise(resolve => (resolveShow = () => resolve({ remove: showRemove }))) // show pending
    );

    const { unmount } = renderHook(() => useKeyboardVisible());
    unmount(); // cancelled = true before show resolves
    await act(async () => resolveShow()); // show resolves after cancel → removed inline, never tracked

    expect(showRemove).toHaveBeenCalledTimes(1);
  });

  it('removes an already-registered listener if the hook unmounts mid-registration', async () => {
    isMobileMock.mockReturnValue(true);
    const showRemove = jest.fn();
    const hideRemove = jest.fn();
    let resolveHide: () => void = () => {};
    addListenerMock
      .mockImplementationOnce(() => Promise.resolve({ remove: showRemove })) // show resolves
      .mockImplementationOnce(
        () => new Promise(resolve => (resolveHide = () => resolve({ remove: hideRemove }))) // hide is pending
      );

    const { unmount } = renderHook(() => useKeyboardVisible());
    await act(async () => {}); // show registers + is tracked; the hook now awaits hide
    unmount(); // cancelled = true, cleanup removes the tracked show handle
    await act(async () => resolveHide()); // hide resolves after cancel → removed inline, not tracked

    expect(showRemove).toHaveBeenCalledTimes(1);
    expect(hideRemove).toHaveBeenCalledTimes(1);
  });
});
