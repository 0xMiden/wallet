import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, putToStorage, onStorageChanged, usePassiveStorage, useStorage } from './storage';

// Mock platform detection - default to extension context
const mockIsExtension = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => mockIsExtension()
}));

const mockStorage = {
  local: {
    get: jest.fn(),
    set: jest.fn()
  },
  onChanged: {
    addListener: jest.fn(),
    removeListener: jest.fn()
  }
};

// Mock webextension-polyfill with default export for dynamic imports
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: mockStorage
  },
  storage: mockStorage
}));

// Mock storage adapter to use the mock storage
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => mockStorage.local
}));

const mockUseRetryableSWR = jest.fn();
jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: any[]) => mockUseRetryableSWR(...args)
}));

// Helper to flush promises
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

describe('storage utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsExtension.mockReturnValue(true);
    mockUseRetryableSWR.mockReturnValue({ data: undefined, mutate: jest.fn() });
  });

  describe('fetchFromStorage', () => {
    it('returns value when key exists', async () => {
      mockStorage.local.get.mockResolvedValue({
        'my-key': 'my-value'
      });

      const result = await fetchFromStorage('my-key');

      expect(mockStorage.local.get).toHaveBeenCalledWith(['my-key']);
      expect(result).toBe('my-value');
    });

    it('returns null when key does not exist', async () => {
      mockStorage.local.get.mockResolvedValue({});

      const result = await fetchFromStorage('missing-key');

      expect(result).toBeNull();
    });

    it('handles complex objects', async () => {
      const complexValue = { nested: { data: [1, 2, 3] } };
      mockStorage.local.get.mockResolvedValue({
        'complex-key': complexValue
      });

      const result = await fetchFromStorage('complex-key');

      expect(result).toEqual(complexValue);
    });
  });

  describe('putToStorage', () => {
    it('stores value with key', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);

      await putToStorage('my-key', 'my-value');

      expect(mockStorage.local.set).toHaveBeenCalledWith({ 'my-key': 'my-value' });
    });

    it('stores complex objects', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      const complexValue = { nested: { data: [1, 2, 3] } };

      await putToStorage('complex-key', complexValue);

      expect(mockStorage.local.set).toHaveBeenCalledWith({ 'complex-key': complexValue });
    });
  });

  describe('useStorage', () => {
    it('returns fallback data and stores direct updates', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      mockUseRetryableSWR.mockReturnValue({ data: undefined, mutate: jest.fn() });

      const { result } = renderHook(() => useStorage('settings-key', 'fallback-value'));

      expect(result.current[0]).toBe('fallback-value');

      await act(async () => {
        await result.current[1]('next-value');
      });

      expect(mockStorage.local.set).toHaveBeenCalledWith({ 'settings-key': 'next-value' });
    });

    it('stores functional updates against the latest value ref', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      mockUseRetryableSWR.mockReturnValue({ data: 'current-value', mutate: jest.fn() });

      const { result } = renderHook(() => useStorage<string>('settings-key'));

      await act(async () => {
        await result.current[1](prev => `${prev}-updated`);
      });

      expect(mockStorage.local.set).toHaveBeenCalledWith({ 'settings-key': 'current-value-updated' });
    });
  });

  describe('usePassiveStorage', () => {
    it('returns initial storage data and persists local state changes', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      mockUseRetryableSWR.mockReturnValue({ data: 'initial-value', mutate: jest.fn() });

      const { result } = renderHook(() => usePassiveStorage<string>('passive-key'));

      expect(result.current[0]).toBe('initial-value');

      act(() => {
        result.current[1]('changed-value');
      });

      await waitFor(() => {
        expect(mockStorage.local.set).toHaveBeenCalledWith({ 'passive-key': 'changed-value' });
      });
    });

    it('uses the fallback when storage has no value', () => {
      mockUseRetryableSWR.mockReturnValue({ data: undefined, mutate: jest.fn() });

      const { result } = renderHook(() => usePassiveStorage('missing-key', 'fallback-value'));

      expect(result.current[0]).toBe('fallback-value');
    });
  });

  describe('onStorageChanged', () => {
    it('registers a listener', async () => {
      const callback = jest.fn();

      onStorageChanged('my-key', callback);

      // Wait for the dynamic import to complete
      await flushPromises();

      expect(mockStorage.onChanged.addListener).toHaveBeenCalled();
    });

    it('returns cleanup function', async () => {
      const callback = jest.fn();

      const cleanup = onStorageChanged('my-key', callback);

      // The cleanup function is returned synchronously
      // (though the actual listener removal is async)
      expect(typeof cleanup).toBe('function');
    });

    it('calls callback when key changes in local storage', async () => {
      const callback = jest.fn();
      let registeredHandler: any;

      mockStorage.onChanged.addListener.mockImplementation(handler => {
        registeredHandler = handler;
      });

      onStorageChanged('my-key', callback);

      // Wait for the dynamic import to complete
      await flushPromises();

      // Simulate storage change
      registeredHandler({ 'my-key': { newValue: 'new-value' } }, 'local');

      expect(callback).toHaveBeenCalledWith('new-value');
    });

    it('does not call callback for different key', async () => {
      const callback = jest.fn();
      let registeredHandler: any;

      mockStorage.onChanged.addListener.mockImplementation(handler => {
        registeredHandler = handler;
      });

      onStorageChanged('my-key', callback);

      // Wait for the dynamic import to complete
      await flushPromises();

      // Simulate storage change for different key
      registeredHandler({ 'other-key': { newValue: 'new-value' } }, 'local');

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not call callback for non-local storage area', async () => {
      const callback = jest.fn();
      let registeredHandler: any;

      mockStorage.onChanged.addListener.mockImplementation(handler => {
        registeredHandler = handler;
      });

      onStorageChanged('my-key', callback);

      // Wait for the dynamic import to complete
      await flushPromises();

      // Simulate storage change in sync area
      registeredHandler({ 'my-key': { newValue: 'new-value' } }, 'sync');

      expect(callback).not.toHaveBeenCalled();
    });

    it('returns no-op cleanup on mobile/desktop', () => {
      mockIsExtension.mockReturnValue(false);
      const callback = jest.fn();

      const cleanup = onStorageChanged('my-key', callback);

      expect(typeof cleanup).toBe('function');
      // Should not register listener on mobile/desktop
      expect(mockStorage.onChanged.addListener).not.toHaveBeenCalled();
    });
  });
});
