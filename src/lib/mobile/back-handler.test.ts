import { App } from '@capacitor/app';

import { isMobile } from 'lib/platform';

import { initMobileBackHandler, registerMobileBackHandler } from './back-handler';

jest.mock('@capacitor/app', () => ({
  App: {
    addListener: jest.fn(),
    minimizeApp: jest.fn()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(),
  isAndroid: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;

describe('back-handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initMobileBackHandler', () => {
    it('does nothing when not on mobile', async () => {
      mockIsMobile.mockReturnValue(false);

      await initMobileBackHandler();

      expect(App.addListener).not.toHaveBeenCalled();
    });

    it('adds listener when on mobile', async () => {
      // Reset modules to get fresh state
      jest.resetModules();

      // Re-setup mocks after module reset
      jest.doMock('@capacitor/app', () => ({
        App: {
          addListener: jest.fn().mockResolvedValue({ remove: jest.fn() }),
          minimizeApp: jest.fn()
        }
      }));
      jest.doMock('lib/platform', () => ({
        isMobile: jest.fn().mockReturnValue(true),
        isAndroid: jest.fn().mockReturnValue(true)
      }));

      const { initMobileBackHandler: init } = await import('./back-handler');
      const { App: MockApp } = await import('@capacitor/app');

      await init();

      expect(MockApp.addListener).toHaveBeenCalledWith('backButton', expect.any(Function));
    });
  });

  describe('registerMobileBackHandler', () => {
    it('registers a handler and returns unregister function', () => {
      const handler = jest.fn();

      const unregister = registerMobileBackHandler(handler);

      expect(typeof unregister).toBe('function');
    });

    it('unregister removes the handler', () => {
      const handler = jest.fn(() => true);

      const unregister = registerMobileBackHandler(handler);
      // Handler should be de-registerable without throwing.
      expect(() => unregister()).not.toThrow();
    });

    it('unregister is safe to call multiple times', () => {
      const handler = jest.fn();

      const unregister = registerMobileBackHandler(handler);
      unregister();
      unregister(); // Should not throw

      expect(true).toBe(true);
    });
  });

  describe('back button behavior', () => {
    it('calls handlers in reverse order', async () => {
      jest.resetModules();

      let backButtonCallback: (() => void) | null = null;

      jest.doMock('@capacitor/app', () => ({
        App: {
          addListener: jest.fn().mockImplementation((event: string, callback: () => void) => {
            if (event === 'backButton') {
              backButtonCallback = callback;
            }
            return Promise.resolve({ remove: jest.fn() });
          }),
          minimizeApp: jest.fn()
        }
      }));
      jest.doMock('lib/platform', () => ({
        isMobile: jest.fn().mockReturnValue(true),
        isAndroid: jest.fn().mockReturnValue(false)
      }));

      const { initMobileBackHandler: init, registerMobileBackHandler: register } = await import('./back-handler');
      await init();

      const order: number[] = [];
      const handler1 = jest.fn(() => {
        order.push(1);
        return false;
      });
      const handler2 = jest.fn(() => {
        order.push(2);
        return false;
      });

      register(handler1);
      register(handler2);

      // Trigger back button
      expect(backButtonCallback).not.toBeNull();
      backButtonCallback!();

      expect(order).toEqual([2, 1]); // Reverse order
    });

    it('stops calling handlers when one returns true', async () => {
      jest.resetModules();

      let backButtonCallback: (() => void) | null = null;

      jest.doMock('@capacitor/app', () => ({
        App: {
          addListener: jest.fn().mockImplementation((event: string, callback: () => void) => {
            if (event === 'backButton') {
              backButtonCallback = callback;
            }
            return Promise.resolve({ remove: jest.fn() });
          }),
          minimizeApp: jest.fn()
        }
      }));
      jest.doMock('lib/platform', () => ({
        isMobile: jest.fn().mockReturnValue(true),
        isAndroid: jest.fn().mockReturnValue(false)
      }));

      const { initMobileBackHandler: init, registerMobileBackHandler: register } = await import('./back-handler');
      await init();

      const handler1 = jest.fn(() => false);
      const handler2 = jest.fn(() => true); // This one consumes

      register(handler1);
      register(handler2);

      expect(backButtonCallback).not.toBeNull();
      backButtonCallback!();

      expect(handler2).toHaveBeenCalled();
      expect(handler1).not.toHaveBeenCalled(); // Should not be reached
    });

    it('minimizes app on Android when no handler consumes', async () => {
      jest.resetModules();

      let backButtonCallback: (() => void) | null = null;
      const mockMinimizeApp = jest.fn();

      jest.doMock('@capacitor/app', () => ({
        App: {
          addListener: jest.fn().mockImplementation((event: string, callback: () => void) => {
            if (event === 'backButton') {
              backButtonCallback = callback;
            }
            return Promise.resolve({ remove: jest.fn() });
          }),
          minimizeApp: mockMinimizeApp
        }
      }));
      jest.doMock('lib/platform', () => ({
        isMobile: jest.fn().mockReturnValue(true),
        isAndroid: jest.fn().mockReturnValue(true)
      }));

      const { initMobileBackHandler: init } = await import('./back-handler');
      await init();

      expect(backButtonCallback).not.toBeNull();
      backButtonCallback!();

      expect(mockMinimizeApp).toHaveBeenCalled();
    });

    it('does not minimize on iOS when no handler consumes', async () => {
      jest.resetModules();

      let backButtonCallback: (() => void) | null = null;
      const mockMinimizeApp = jest.fn();

      jest.doMock('@capacitor/app', () => ({
        App: {
          addListener: jest.fn().mockImplementation((event: string, callback: () => void) => {
            if (event === 'backButton') {
              backButtonCallback = callback;
            }
            return Promise.resolve({ remove: jest.fn() });
          }),
          minimizeApp: mockMinimizeApp
        }
      }));
      jest.doMock('lib/platform', () => ({
        isMobile: jest.fn().mockReturnValue(true),
        isAndroid: jest.fn().mockReturnValue(false)
      }));

      const { initMobileBackHandler: init } = await import('./back-handler');
      await init();

      expect(backButtonCallback).not.toBeNull();
      backButtonCallback!();

      expect(mockMinimizeApp).not.toHaveBeenCalled();
    });
  });
});
