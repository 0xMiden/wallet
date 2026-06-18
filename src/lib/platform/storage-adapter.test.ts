import { CapacitorStorage, DesktopStorage, ExtensionStorage } from './storage-adapter';

// Mock platform detection
jest.mock('./index', () => ({
  isMobile: jest.fn(),
  isDesktop: jest.fn(),
  isExtension: jest.fn()
}));

// Mock webextension-polyfill
const mockStorageGet = jest.fn();
const mockStorageSet = jest.fn();
const mockStorageRemove = jest.fn();

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: {
        get: (...args: unknown[]) => mockStorageGet(...args),
        set: (...args: unknown[]) => mockStorageSet(...args),
        remove: (...args: unknown[]) => mockStorageRemove(...args)
      }
    }
  }
}));

// Mock @capacitor/preferences
const mockPreferencesGet = jest.fn();
const mockPreferencesSet = jest.fn();
const mockPreferencesRemove = jest.fn();

jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (...args: unknown[]) => mockPreferencesGet(...args),
    set: (...args: unknown[]) => mockPreferencesSet(...args),
    remove: (...args: unknown[]) => mockPreferencesRemove(...args)
  }
}));

describe('ExtensionStorage', () => {
  let storage: ExtensionStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = new ExtensionStorage();
  });

  describe('get', () => {
    it('retrieves values from browser.storage.local', async () => {
      mockStorageGet.mockResolvedValue({ key1: 'value1', key2: 'value2' });

      const result = await storage.get(['key1', 'key2']);

      expect(mockStorageGet).toHaveBeenCalledWith(['key1', 'key2']);
      expect(result).toEqual({ key1: 'value1', key2: 'value2' });
    });
  });

  describe('set', () => {
    it('stores values in browser.storage.local', async () => {
      mockStorageSet.mockResolvedValue(undefined);

      await storage.set({ key1: 'value1' });

      expect(mockStorageSet).toHaveBeenCalledWith({ key1: 'value1' });
    });
  });

  describe('remove', () => {
    it('removes values from browser.storage.local', async () => {
      mockStorageRemove.mockResolvedValue(undefined);

      await storage.remove(['key1']);

      expect(mockStorageRemove).toHaveBeenCalledWith(['key1']);
    });
  });
});

describe('DesktopStorage', () => {
  let storage: DesktopStorage;
  const prefix = 'miden_wallet_';

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    storage = new DesktopStorage();
  });

  describe('get', () => {
    it('retrieves JSON values from localStorage', async () => {
      localStorage.setItem(prefix + 'key1', '{"name":"test"}');
      localStorage.setItem(prefix + 'key2', '"simpleString"');

      const result = await storage.get(['key1', 'key2']);

      expect(result).toEqual({ key1: { name: 'test' }, key2: 'simpleString' });
    });

    it('skips keys that do not exist', async () => {
      localStorage.setItem(prefix + 'key1', '"value1"');

      const result = await storage.get(['key1', 'nonexistent']);

      expect(result).toEqual({ key1: 'value1' });
    });

    it('handles non-JSON strings', async () => {
      localStorage.setItem(prefix + 'key1', 'not-valid-json');

      const result = await storage.get(['key1']);

      expect(result).toEqual({ key1: 'not-valid-json' });
    });

    it('returns empty object when no keys match', async () => {
      const result = await storage.get(['nonexistent']);

      expect(result).toEqual({});
    });
  });

  describe('set', () => {
    it('stores JSON values in localStorage', async () => {
      await storage.set({ key1: { name: 'test' } });

      expect(localStorage.getItem(prefix + 'key1')).toBe('{"name":"test"}');
    });

    it('stores string values directly', async () => {
      await storage.set({ key1: 'simpleString' });

      expect(localStorage.getItem(prefix + 'key1')).toBe('simpleString');
    });

    it('stores multiple values', async () => {
      await storage.set({ key1: 'value1', key2: { nested: true } });

      expect(localStorage.getItem(prefix + 'key1')).toBe('value1');
      expect(localStorage.getItem(prefix + 'key2')).toBe('{"nested":true}');
    });
  });

  describe('remove', () => {
    it('removes values from localStorage', async () => {
      localStorage.setItem(prefix + 'key1', 'value1');
      localStorage.setItem(prefix + 'key2', 'value2');

      await storage.remove(['key1', 'key2']);

      expect(localStorage.getItem(prefix + 'key1')).toBeNull();
      expect(localStorage.getItem(prefix + 'key2')).toBeNull();
    });
  });
});

describe('CapacitorStorage', () => {
  let storage: CapacitorStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = new CapacitorStorage();
  });

  describe('get', () => {
    it('retrieves values from Capacitor Preferences', async () => {
      mockPreferencesGet
        .mockResolvedValueOnce({ value: '{"name":"test"}' })
        .mockResolvedValueOnce({ value: '"simpleString"' });

      const result = await storage.get(['key1', 'key2']);

      expect(mockPreferencesGet).toHaveBeenCalledWith({ key: 'key1' });
      expect(mockPreferencesGet).toHaveBeenCalledWith({ key: 'key2' });
      expect(result).toEqual({ key1: { name: 'test' }, key2: 'simpleString' });
    });

    it('skips null values', async () => {
      mockPreferencesGet.mockResolvedValue({ value: null });

      const result = await storage.get(['key1']);

      expect(result).toEqual({});
    });

    it('handles non-JSON strings', async () => {
      mockPreferencesGet.mockResolvedValue({ value: 'not-json' });

      const result = await storage.get(['key1']);

      expect(result).toEqual({ key1: 'not-json' });
    });
  });

  describe('set', () => {
    it('stores JSON values in Capacitor Preferences', async () => {
      mockPreferencesSet.mockResolvedValue(undefined);

      await storage.set({ key1: { name: 'test' } });

      expect(mockPreferencesSet).toHaveBeenCalledWith({
        key: 'key1',
        value: '{"name":"test"}'
      });
    });

    it('stores string values directly', async () => {
      mockPreferencesSet.mockResolvedValue(undefined);

      await storage.set({ key1: 'simpleString' });

      expect(mockPreferencesSet).toHaveBeenCalledWith({
        key: 'key1',
        value: 'simpleString'
      });
    });

    it('stores multiple values', async () => {
      mockPreferencesSet.mockResolvedValue(undefined);

      await storage.set({ key1: 'value1', key2: { nested: true } });

      expect(mockPreferencesSet).toHaveBeenCalledTimes(2);
    });
  });

  describe('remove', () => {
    it('removes values from Capacitor Preferences', async () => {
      mockPreferencesRemove.mockResolvedValue(undefined);

      await storage.remove(['key1', 'key2']);

      expect(mockPreferencesRemove).toHaveBeenCalledWith({ key: 'key1' });
      expect(mockPreferencesRemove).toHaveBeenCalledWith({ key: 'key2' });
    });
  });
});

describe('getStorageProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the singletons by reimporting the module
    jest.resetModules();
  });

  it('returns CapacitorStorage when on mobile', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(true),
      isDesktop: jest.fn().mockReturnValue(false),
      isExtension: jest.fn().mockReturnValue(false)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider = getProvider();

    expect(provider.constructor.name).toBe('CapacitorStorage');
  });

  it('returns DesktopStorage when on desktop', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(false),
      isDesktop: jest.fn().mockReturnValue(true),
      isExtension: jest.fn().mockReturnValue(false)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider = getProvider();

    expect(provider.constructor.name).toBe('DesktopStorage');
  });

  it('returns ExtensionStorage when in extension context', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(false),
      isDesktop: jest.fn().mockReturnValue(false),
      isExtension: jest.fn().mockReturnValue(true)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider = getProvider();

    expect(provider.constructor.name).toBe('ExtensionStorage');
  });

  it('returns DesktopStorage as fallback when no platform detected', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(false),
      isDesktop: jest.fn().mockReturnValue(false),
      isExtension: jest.fn().mockReturnValue(false)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider = getProvider();

    expect(provider.constructor.name).toBe('DesktopStorage');
  });

  it('returns DesktopStorage when Tauri globals are present', async () => {
    // Simulate Tauri environment
    (window as any).__TAURI__ = {};

    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(false),
      isDesktop: jest.fn().mockReturnValue(false),
      isExtension: jest.fn().mockReturnValue(false)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider = getProvider();

    expect(provider.constructor.name).toBe('DesktopStorage');

    // Cleanup
    delete (window as any).__TAURI__;
  });

  it('returns singleton instance for mobile', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(true),
      isDesktop: jest.fn().mockReturnValue(false),
      isExtension: jest.fn().mockReturnValue(false)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider1 = getProvider();
    const provider2 = getProvider();

    expect(provider1).toBe(provider2);
  });

  it('returns singleton instance for desktop', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(false),
      isDesktop: jest.fn().mockReturnValue(true),
      isExtension: jest.fn().mockReturnValue(false)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider1 = getProvider();
    const provider2 = getProvider();

    expect(provider1).toBe(provider2);
  });

  it('returns singleton instance for extension', async () => {
    jest.doMock('./index', () => ({
      isMobile: jest.fn().mockReturnValue(false),
      isDesktop: jest.fn().mockReturnValue(false),
      isExtension: jest.fn().mockReturnValue(true)
    }));

    const { getStorageProvider: getProvider } = await import('./storage-adapter');
    const provider1 = getProvider();
    const provider2 = getProvider();

    expect(provider1).toBe(provider2);
  });
});
