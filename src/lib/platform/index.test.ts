// Test platform detection utilities
// Note: These tests need to be run in isolation since the module caches Capacitor

describe('platform detection', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe('isExtension', () => {
    afterEach(() => {
      delete (globalThis as any).browser;
      delete (globalThis as any).chrome;
    });

    it('returns true when browser.runtime.id exists (Firefox)', () => {
      (globalThis as any).browser = { runtime: { id: 'test-extension-id' } };

      const { isExtension } = require('./index');
      expect(isExtension()).toBe(true);
    });

    it('returns true when chrome.runtime.id exists (Chrome)', () => {
      (globalThis as any).chrome = { runtime: { id: 'test-chrome-extension-id' } };

      const { isExtension } = require('./index');
      expect(isExtension()).toBe(true);
    });

    it('returns false when neither browser nor chrome is defined', () => {
      const { isExtension } = require('./index');
      expect(isExtension()).toBe(false);
    });

    it('returns false when browser.runtime is undefined', () => {
      (globalThis as any).browser = {};

      const { isExtension } = require('./index');
      expect(isExtension()).toBe(false);
    });

    it('returns false when browser.runtime.id is undefined', () => {
      (globalThis as any).browser = { runtime: {} };

      const { isExtension } = require('./index');
      expect(isExtension()).toBe(false);
    });

    it('returns false when chrome.runtime.id is undefined', () => {
      (globalThis as any).chrome = { runtime: {} };

      const { isExtension } = require('./index');
      expect(isExtension()).toBe(false);
    });
  });

  describe('hasExtensionRuntime', () => {
    afterEach(() => {
      delete (globalThis as any).browser;
      delete (globalThis as any).chrome;
    });

    it('returns true when browser.runtime.id exists (Firefox)', () => {
      (globalThis as any).browser = { runtime: { id: 'test-extension-id' } };

      const { hasExtensionRuntime } = require('./index');
      expect(hasExtensionRuntime()).toBe(true);
    });

    it('returns true when chrome.runtime.id exists (Chrome)', () => {
      (globalThis as any).chrome = { runtime: { id: 'test-chrome-extension-id' } };

      const { hasExtensionRuntime } = require('./index');
      expect(hasExtensionRuntime()).toBe(true);
    });

    it('returns false when the runtime reports no id', () => {
      (globalThis as any).chrome = { runtime: {} };

      const { hasExtensionRuntime } = require('./index');
      expect(hasExtensionRuntime()).toBe(false);
    });
  });

  describe('isCapacitor', () => {
    it('returns false when Capacitor is not available', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });

      const { isCapacitor } = require('./index');
      expect(isCapacitor()).toBe(false);
    });
  });

  describe('isMobile', () => {
    it('returns false when not on mobile', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });

      const { isMobile } = require('./index');
      expect(isMobile()).toBe(false);
    });
  });

  describe('isIOS', () => {
    it('returns false when Capacitor is not available', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });

      const { isIOS } = require('./index');
      expect(isIOS()).toBe(false);
    });
  });

  describe('isAndroid', () => {
    it('returns false when Capacitor is not available', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });

      const { isAndroid } = require('./index');
      expect(isAndroid()).toBe(false);
    });
  });

  describe('getPlatform', () => {
    afterEach(() => {
      delete (globalThis as any).browser;
      delete (globalThis as any).chrome;
    });

    it('returns extension when in extension context (Firefox)', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });
      (globalThis as any).browser = { runtime: { id: 'test-id' } };

      const { getPlatform } = require('./index');
      expect(getPlatform()).toBe('extension');
    });

    it('returns extension when in extension context (Chrome)', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });
      (globalThis as any).chrome = { runtime: { id: 'test-chrome-id' } };

      const { getPlatform } = require('./index');
      expect(getPlatform()).toBe('extension');
    });

    it('returns web when not in extension or mobile', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });

      const { getPlatform } = require('./index');
      expect(getPlatform()).toBe('web');
    });

    it('returns desktop when in Tauri context', () => {
      jest.doMock('@capacitor/core', () => {
        throw new Error('Module not found');
      });
      (window as any).__TAURI__ = {};

      const { getPlatform } = require('./index');
      expect(getPlatform()).toBe('desktop');

      delete (window as any).__TAURI__;
    });
  });

  describe('isTauri', () => {
    afterEach(() => {
      delete (window as any).__TAURI__;
      delete (window as any).__TAURI_INTERNALS__;
    });

    it('returns true when __TAURI__ global exists', () => {
      (window as any).__TAURI__ = {};

      const { isTauri } = require('./index');
      expect(isTauri()).toBe(true);
    });

    it('returns true when __TAURI_INTERNALS__ global exists', () => {
      (window as any).__TAURI_INTERNALS__ = {};

      const { isTauri } = require('./index');
      expect(isTauri()).toBe(true);
    });

    it('returns false when neither Tauri global exists', () => {
      const { isTauri } = require('./index');
      expect(isTauri()).toBe(false);
    });
  });

  describe('isDesktop', () => {
    afterEach(() => {
      delete (window as any).__TAURI__;
      delete (window as any).__TAURI_INTERNALS__;
    });

    it('returns true when running in Tauri', () => {
      (window as any).__TAURI__ = {};

      const { isDesktop } = require('./index');
      expect(isDesktop()).toBe(true);
    });

    it('returns false when not running in Tauri', () => {
      const { isDesktop } = require('./index');
      expect(isDesktop()).toBe(false);
    });
  });

  describe('platform object', () => {
    it('exports all detection functions', () => {
      const { platform } = require('./index');

      expect(typeof platform.isCapacitor).toBe('function');
      expect(typeof platform.isExtension).toBe('function');
      expect(typeof platform.isIOS).toBe('function');
      expect(typeof platform.isAndroid).toBe('function');
      expect(typeof platform.isMobile).toBe('function');
      expect(typeof platform.isTauri).toBe('function');
      expect(typeof platform.isDesktop).toBe('function');
      expect(typeof platform.getPlatform).toBe('function');
    });
  });

  describe('with mocked Capacitor', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('isCapacitor returns true when Capacitor reports native platform', () => {
      jest.doMock('@capacitor/core', () => ({
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'ios'
        }
      }));

      const { isCapacitor } = require('./index');
      expect(isCapacitor()).toBe(true);
    });

    it('isIOS returns true when platform is ios', () => {
      jest.doMock('@capacitor/core', () => ({
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'ios'
        }
      }));

      const { isIOS } = require('./index');
      expect(isIOS()).toBe(true);
    });

    it('isAndroid returns true when platform is android', () => {
      jest.doMock('@capacitor/core', () => ({
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'android'
        }
      }));

      const { isAndroid } = require('./index');
      expect(isAndroid()).toBe(true);
    });

    it('getPlatform returns mobile when on native platform', () => {
      jest.doMock('@capacitor/core', () => ({
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'ios'
        }
      }));

      const { getPlatform } = require('./index');
      expect(getPlatform()).toBe('mobile');
    });
  });
});
