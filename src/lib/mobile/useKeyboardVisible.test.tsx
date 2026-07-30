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
});
