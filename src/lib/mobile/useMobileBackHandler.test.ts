import React from 'react';

import { renderHook } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';
import { isMobile } from 'lib/platform';

import { useMobileBackHandler } from './useMobileBackHandler';

const mockRegisterMobileBackHandler = jest.fn();

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

jest.mock('./back-handler', () => ({
  registerMobileBackHandler: (...args: unknown[]) => mockRegisterMobileBackHandler(...args)
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;

describe('useMobileBackHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterMobileBackHandler.mockReturnValue(jest.fn());
  });

  it('does not register handler when not on mobile', () => {
    mockIsMobile.mockReturnValue(false);

    renderHook(() => useMobileBackHandler(() => true, []));

    expect(mockRegisterMobileBackHandler).not.toHaveBeenCalled();
  });

  it('registers handler when on mobile', () => {
    mockIsMobile.mockReturnValue(true);
    const handler = jest.fn(() => true);

    renderHook(() => useMobileBackHandler(handler, []));

    expect(mockRegisterMobileBackHandler).toHaveBeenCalledWith(handler, { overlay: false });
  });

  it('registers an overlay handler in the overlay tier', () => {
    mockIsMobile.mockReturnValue(true);
    const handler = jest.fn(() => true);

    renderHook(() => useMobileBackHandler(handler, [], { overlay: true }));

    expect(mockRegisterMobileBackHandler).toHaveBeenCalledWith(handler, { overlay: true });
  });

  it('unregisters handler on unmount', () => {
    mockIsMobile.mockReturnValue(true);
    const unregister = jest.fn();
    mockRegisterMobileBackHandler.mockReturnValue(unregister);

    const { unmount } = renderHook(() => useMobileBackHandler(() => true, []));

    unmount();

    expect(unregister).toHaveBeenCalled();
  });

  it('re-registers handler when dependencies change', () => {
    mockIsMobile.mockReturnValue(true);
    const unregister1 = jest.fn();
    const unregister2 = jest.fn();
    mockRegisterMobileBackHandler.mockReturnValueOnce(unregister1).mockReturnValueOnce(unregister2);

    const { rerender } = renderHook(({ dep }) => useMobileBackHandler(() => true, [dep]), {
      initialProps: { dep: 1 }
    });

    expect(mockRegisterMobileBackHandler).toHaveBeenCalledTimes(1);

    rerender({ dep: 2 });

    expect(unregister1).toHaveBeenCalled();
    expect(mockRegisterMobileBackHandler).toHaveBeenCalledTimes(2);
  });

  it('does not re-register when dependencies are the same', () => {
    mockIsMobile.mockReturnValue(true);

    const { rerender } = renderHook(({ dep }) => useMobileBackHandler(() => true, [dep]), {
      initialProps: { dep: 1 }
    });

    expect(mockRegisterMobileBackHandler).toHaveBeenCalledTimes(1);

    rerender({ dep: 1 });

    expect(mockRegisterMobileBackHandler).toHaveBeenCalledTimes(1);
  });
});

it('registers nothing while its page is off screen, and registers again when the page returns', () => {
  // This test sits outside the describe, so it clears the calls the tests above left behind.
  mockRegisterMobileBackHandler.mockClear();
  mockIsMobile.mockReturnValue(true);
  const handler = jest.fn(() => true);
  const unregister = jest.fn();
  mockRegisterMobileBackHandler.mockReturnValue(unregister);
  let onScreen = false;
  const wrapper = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(PageActiveContext.Provider, { value: onScreen }, children);

  const { rerender } = renderHook(() => useMobileBackHandler(handler, []), { wrapper });
  expect(mockRegisterMobileBackHandler).not.toHaveBeenCalled();

  onScreen = true;
  rerender();
  expect(mockRegisterMobileBackHandler).toHaveBeenCalledWith(handler, { overlay: false });

  onScreen = false;
  rerender();
  expect(unregister).toHaveBeenCalled();
});
