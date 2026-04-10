import React from 'react';

import { act, render, renderHook } from '@testing-library/react';

import { isExtension, isMobile } from 'lib/platform';

import { AppEnvProvider, OpenInFullPage, useAppEnv, WindowType, IS_DEV_ENV, onboardingUrls, openInFullPage } from './env';

// Mock lib/platform
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isExtension: jest.fn(() => true),
  isDesktop: jest.fn(() => false)
}));

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

// Mock lib/woozie
jest.mock('lib/woozie', () => ({
  createUrl: jest.fn((base, search, hash) => `${base}${search}${hash}`)
}));

// Mock webextension-polyfill
const mockTabsCreate = jest.fn();
const mockTabsQuery = jest.fn().mockResolvedValue([]);
const mockTabsUpdate = jest.fn();
const mockRuntimeGetURL = jest.fn((path: string) => `chrome-extension://test/${path}`);
const mockAddListener = jest.fn();
const mockSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    tabs: {
      create: (...args: unknown[]) => mockTabsCreate(...args),
      query: (...args: unknown[]) => mockTabsQuery(...args),
      update: (...args: unknown[]) => mockTabsUpdate(...args)
    },
    runtime: {
      getURL: (path: string) => mockRuntimeGetURL(path),
      onMessage: {
        addListener: (...args: unknown[]) => mockAddListener(...args)
      },
      sendMessage: (...args: unknown[]) => mockSendMessage(...args)
    }
  },
  runtime: {
    getURL: (path: string) => mockRuntimeGetURL(path),
    onMessage: {
      addListener: (...args: unknown[]) => mockAddListener(...args)
    },
    sendMessage: (...args: unknown[]) => mockSendMessage(...args)
  }
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;

describe('env', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockIsExtension.mockReturnValue(true);
  });

  describe('IS_DEV_ENV', () => {
    it('reflects NODE_ENV', () => {
      expect(typeof IS_DEV_ENV).toBe('boolean');
    });
  });

  describe('useAppEnv', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(AppEnvProvider, { windowType: WindowType.FullPage }, children);

    it('returns fullPage true when windowType is FullPage', () => {
      const { result } = renderHook(() => useAppEnv(), { wrapper });

      expect(result.current.fullPage).toBe(true);
      expect(result.current.popup).toBe(false);
    });

    it('returns popup true when windowType is Popup', () => {
      const popupWrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(AppEnvProvider, { windowType: WindowType.Popup }, children);

      const { result } = renderHook(() => useAppEnv(), { wrapper: popupWrapper });

      expect(result.current.popup).toBe(true);
      expect(result.current.fullPage).toBe(false);
    });

    it('returns confirmWindow from env', () => {
      const confirmWrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(AppEnvProvider, { windowType: WindowType.FullPage, confirmWindow: true }, children);

      const { result } = renderHook(() => useAppEnv(), { wrapper: confirmWrapper });

      expect(result.current.confirmWindow).toBe(true);
    });

    describe('onBack', () => {
      it('calls the registered handler', () => {
        const { result } = renderHook(() => useAppEnv(), { wrapper });

        const handler = jest.fn();
        act(() => {
          result.current.registerBackHandler(handler);
        });

        act(() => {
          result.current.onBack();
        });

        expect(handler).toHaveBeenCalled();
      });

      it('does nothing when no handler registered', () => {
        const { result } = renderHook(() => useAppEnv(), { wrapper });

        // Should not throw when onBack is called without a registered handler.
        expect(() =>
          act(() => {
            result.current.onBack();
          })
        ).not.toThrow();
      });
    });

    describe('registerBackHandler', () => {
      it('registers and unregisters handlers', () => {
        const { result } = renderHook(() => useAppEnv(), { wrapper });

        const handler = jest.fn();
        let unregister: () => void;

        act(() => {
          unregister = result.current.registerBackHandler(handler);
        });

        act(() => {
          result.current.onBack();
        });
        expect(handler).toHaveBeenCalledTimes(1);

        act(() => {
          unregister();
        });

        // Register a new handler to test previous handler was restored
        const handler2 = jest.fn();
        act(() => {
          result.current.registerBackHandler(handler2);
        });

        act(() => {
          result.current.onBack();
        });
        expect(handler2).toHaveBeenCalled();
      });

      it('stacks handlers and restores previous on unregister', () => {
        const { result } = renderHook(() => useAppEnv(), { wrapper });

        const handler1 = jest.fn();
        const handler2 = jest.fn();

        act(() => {
          result.current.registerBackHandler(handler1);
        });

        let unregister2: () => void;
        act(() => {
          unregister2 = result.current.registerBackHandler(handler2);
        });

        // Current handler should be handler2
        act(() => {
          result.current.onBack();
        });
        expect(handler2).toHaveBeenCalled();
        expect(handler1).not.toHaveBeenCalled();

        // Unregister handler2, handler1 should be restored
        act(() => {
          unregister2();
        });

        handler1.mockClear();
        handler2.mockClear();

        act(() => {
          result.current.onBack();
        });
        expect(handler1).toHaveBeenCalled();
        expect(handler2).not.toHaveBeenCalled();
      });
    });
  });

  describe('onboardingUrls', () => {
    it('returns empty array when not in extension context', async () => {
      mockIsExtension.mockReturnValue(false);

      const urls = await onboardingUrls();

      expect(urls).toEqual([]);
    });

    it('returns array of onboarding URLs', async () => {
      mockIsMobile.mockReturnValue(false);

      const urls = await onboardingUrls();

      expect(Array.isArray(urls)).toBe(true);
      expect(urls.length).toBeGreaterThan(0);
      expect(mockRuntimeGetURL).toHaveBeenCalled();
    });
  });

  describe('openInFullPage', () => {
    it('does nothing when not in extension context', async () => {
      mockIsExtension.mockReturnValue(false);

      await openInFullPage();

      expect(mockTabsCreate).not.toHaveBeenCalled();
    });

    it('creates a new tab with fullpage URL', async () => {
      mockIsMobile.mockReturnValue(false);

      await openInFullPage();

      expect(mockTabsCreate).toHaveBeenCalledWith({
        url: expect.stringContaining('fullpage.html')
      });
    });
  });

  describe('OpenInFullPage', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(AppEnvProvider, { windowType: WindowType.Popup }, children);

    it('focuses an existing onboarding tab when one exists', async () => {
      mockTabsQuery.mockResolvedValueOnce([
        { id: 42, url: 'chrome-extension://test/fullpage.html' }
      ]);
      // Stub window.close so we can verify it's called for compact windows
      const closeSpy = jest.spyOn(window, 'close').mockImplementation(() => {});
      render(React.createElement(OpenInFullPage), { wrapper });
      // Wait for the async useLayoutEffect chain to settle
      await new Promise(r => setTimeout(r, 0));
      expect(mockTabsUpdate).toHaveBeenCalledWith(42, { active: true });
      closeSpy.mockRestore();
    });

    it('opens a new tab when no onboarding tab is found', async () => {
      mockTabsQuery.mockResolvedValueOnce([]);
      const closeSpy = jest.spyOn(window, 'close').mockImplementation(() => {});
      render(React.createElement(OpenInFullPage), { wrapper });
      await new Promise(r => setTimeout(r, 0));
      expect(mockTabsCreate).toHaveBeenCalled();
      closeSpy.mockRestore();
    });

    it('is a no-op outside extension context', async () => {
      mockIsExtension.mockReturnValue(false);
      const fullPageWrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(AppEnvProvider, { windowType: WindowType.FullPage }, children);
      render(React.createElement(OpenInFullPage), { wrapper: fullPageWrapper });
      await new Promise(r => setTimeout(r, 0));
      expect(mockTabsQuery).not.toHaveBeenCalled();
    });

    it('logs and recovers when browser APIs throw', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockTabsQuery.mockRejectedValueOnce(new Error('boom'));
      render(React.createElement(OpenInFullPage), { wrapper });
      await new Promise(r => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('OpenInFullPage'), expect.any(Error));
      errSpy.mockRestore();
    });
  });
});
