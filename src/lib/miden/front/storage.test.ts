import { act, renderHook, waitFor } from '@testing-library/react';
import { mutate } from 'swr';

import { deferred, SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import { storageCleared } from 'lib/storage-cleared';

import {
  fetchFromStorage,
  inStorageTurn,
  preloadStorage,
  putToStorage,
  onStorageChanged,
  usePassiveStorage,
  useStorage
} from './storage';

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

const mockPolyfillModule = () => ({ __esModule: true, default: { storage: mockStorage }, storage: mockStorage });

// Mock webextension-polyfill with default export for dynamic imports. An inline arrow, not mockPolyfillModule
// itself, because @swc/jest hoists jest.mock above every const.
jest.mock('webextension-polyfill', () => mockPolyfillModule());

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

    it('builds a functional update on the cached value, not the rendered one', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      await mutate('functional-key', 'cached', { revalidate: false });
      mockUseRetryableSWR.mockReturnValue({ data: 'rendered', mutate: jest.fn() });

      const { result } = renderHook(() => useStorage<string>('functional-key'));
      await act(async () => {
        await result.current[1](prev => `${prev}-updated`);
      });

      expect(mockStorage.local.set).toHaveBeenCalledWith({ 'functional-key': 'cached-updated' });
    });

    it('builds a functional update on the fallback when the key holds nothing', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      await mutate('functional-empty-key', null, { revalidate: false });
      mockUseRetryableSWR.mockReturnValue({ data: null, mutate: jest.fn() });

      const { result } = renderHook(() => useStorage<string>('functional-empty-key', 'fallback'));
      await act(async () => {
        await result.current[1](prev => `${prev}-updated`);
      });

      expect(mockStorage.local.set).toHaveBeenCalledWith({ 'functional-empty-key': 'fallback-updated' });
    });

    it('chains awaited functional updates on the value each one wrote', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      mockStorage.local.get.mockResolvedValue({ 'chained-key': 'base' });
      await preloadStorage(['chained-key']);
      mockUseRetryableSWR.mockReturnValue({ data: 'base', mutate: jest.fn() });

      const { result } = renderHook(() => useStorage<string>('chained-key'));
      await act(async () => {
        await result.current[1](prev => `${prev}-1`);
        await result.current[1](prev => `${prev}-2`);
      });

      expect(mockStorage.local.set).toHaveBeenLastCalledWith({ 'chained-key': 'base-1-2' });
    });

    it('builds a functional update on a value written through putToStorage, not the one read before it', async () => {
      mockStorage.local.set.mockResolvedValue(undefined);
      mockStorage.local.get.mockResolvedValue({ 'direct-then-update-key': 'read' });
      await preloadStorage(['direct-then-update-key']);
      await putToStorage('direct-then-update-key', 'direct');
      mockUseRetryableSWR.mockReturnValue({ data: 'read', mutate: jest.fn() });

      const { result } = renderHook(() => useStorage<string>('direct-then-update-key'));
      await act(async () => {
        await result.current[1](prev => `${prev}-updated`);
      });

      expect(mockStorage.local.set).toHaveBeenLastCalledWith({ 'direct-then-update-key': 'direct-updated' });
    });

    it('keeps the setter identity when the value changes', () => {
      mockUseRetryableSWR.mockReturnValue({ data: 'first', mutate: jest.fn() });
      const { result, rerender } = renderHook(() => useStorage<string>('stable-setter-key', 'fallback'));
      const setter = result.current[1];

      mockUseRetryableSWR.mockReturnValue({ data: 'second', mutate: jest.fn() });
      rerender();

      expect(result.current[0]).toBe('second');
      expect(result.current[1]).toBe(setter);
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
      let registeredHandler!: (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string
      ) => void;
      mockStorage.onChanged.addListener.mockImplementation(handler => {
        registeredHandler = handler;
      });

      const cleanup = onStorageChanged('my-key', callback);

      // The cleanup function is returned synchronously
      // (though the actual listener removal is async)
      expect(typeof cleanup).toBe('function');

      await flushPromises();
      cleanup();

      expect(mockStorage.onChanged.removeListener).toHaveBeenCalledWith(registeredHandler);
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

    it('does not register the extension listener on mobile/desktop', () => {
      mockIsExtension.mockReturnValue(false);
      const callback = jest.fn();

      const cleanup = onStorageChanged('my-key', callback);

      expect(typeof cleanup).toBe('function');
      expect(mockStorage.onChanged.addListener).not.toHaveBeenCalled();
    });

    it('re-reads its key and calls back with the value once this document wipes the platform store', async () => {
      mockIsExtension.mockReturnValue(false);
      const callback = jest.fn();
      mockStorage.local.get.mockResolvedValue({ 'my-key': 'restored-value' });

      onStorageChanged('my-key', callback);
      storageCleared();
      await flushPromises();

      expect(callback).toHaveBeenCalledWith('restored-value');
    });

    it('calls back with undefined, not null, when the re-read finds nothing', async () => {
      mockIsExtension.mockReturnValue(false);
      const callback = jest.fn();
      mockStorage.local.get.mockResolvedValue({});

      onStorageChanged('my-key', callback);
      storageCleared();
      await flushPromises();

      expect(callback).toHaveBeenCalledWith(undefined);
    });

    it('stops calling back once its cleanup unsubscribes', async () => {
      mockIsExtension.mockReturnValue(false);
      const callback = jest.fn();
      mockStorage.local.get.mockResolvedValue({ 'my-key': 'restored-value' });

      const cleanup = onStorageChanged('my-key', callback);
      cleanup();
      storageCleared();
      await flushPromises();

      expect(callback).not.toHaveBeenCalled();
    });

    it('calls back nothing when the re-read fails', async () => {
      mockIsExtension.mockReturnValue(false);
      const callback = jest.fn();
      mockStorage.local.get.mockRejectedValue(new Error('boom'));

      onStorageChanged('my-key', callback);
      storageCleared();
      await flushPromises();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('inStorageTurn', () => {
    afterEach(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    });

    it('takes the Web Lock of its name where Web Locks exist, and resolves with what the operation resolves with', async () => {
      const locks = new SharedEarnLocks();
      Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });

      await expect(inStorageTurn('turn:my-key', async () => 'done')).resolves.toBe('done');

      expect(locks.requests).toEqual(['turn:my-key']);
    });

    describe('without Web Locks (iOS before 15.4)', () => {
      beforeEach(() => {
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
      });

      it('runs turns of one name one at a time, in the order they were asked for', async () => {
        const order: string[] = [];
        const held = deferred<void>();
        const first = inStorageTurn('turn:my-key', async () => {
          order.push('first:start');
          await held.promise;
          order.push('first:end');
        });
        const second = inStorageTurn('turn:my-key', async () => {
          order.push('second');
        });
        await flushPromises();
        expect(order).toEqual(['first:start']);

        held.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(['first:start', 'first:end', 'second']);
      });

      it('starts the next turn after one whose operation failed', async () => {
        const failed = inStorageTurn('turn:my-key', async () => {
          throw new Error('quota');
        });
        const next = inStorageTurn('turn:my-key', async () => 'ran');

        await expect(failed).rejects.toThrow('quota');
        await expect(next).resolves.toBe('ran');
      });

      it('never holds a turn of one name behind a turn of another', async () => {
        // One account's funding-marker turn must not delay another account's.
        const held = deferred<void>();
        const accountA = inStorageTurn('faucet-funding-marker:accountA', () => held.promise);
        let ranB = false;
        const accountB = inStorageTurn('faucet-funding-marker:accountB', async () => {
          ranB = true;
        });
        try {
          await flushPromises();
          expect(ranB).toBe(true);
        } finally {
          held.resolve();
          await Promise.all([accountA, accountB]);
        }
      });
    });
  });

  describe('the page change listener (#1177)', () => {
    it('attaches before the page issues its first read', async () => {
      mockStorage.local.get.mockResolvedValue({ k: 'v' });

      await jest.isolateModulesAsync(async () => {
        const { preloadStorage: preloadFresh } = await import('./storage');
        await preloadFresh(['k']);
      });

      const [attachedAt] = mockStorage.onChanged.addListener.mock.invocationCallOrder;
      const [readAt] = mockStorage.local.get.mock.invocationCallOrder;
      expect(attachedAt).toBeLessThan(readAt!);
    });

    it('resets an attach whose addListener throws, so a later read attaches and settles changes', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockStorage.local.get.mockResolvedValue({ k: 'v' });
      mockStorage.onChanged.addListener.mockImplementationOnce(() => {
        throw new Error('no storage events');
      });
      try {
        await jest.isolateModulesAsync(async () => {
          const { preloadStorage: preloadFresh } = await import('./storage');
          const { SWRConfig } = await import('swr');

          await expect(preloadFresh(['k'])).resolves.toBeUndefined();
          await expect(preloadFresh(['k'])).resolves.toBeUndefined();
          expect(mockStorage.onChanged.addListener).toHaveBeenCalledTimes(2);
          expect(warn).toHaveBeenCalledTimes(1);

          const [, [listener]] = mockStorage.onChanged.addListener.mock.calls;
          listener({ k: { newValue: 'changed' } }, 'local');
          expect(SWRConfig.defaultValue.cache.get('k')?.data).toBe('changed');
        });
      } finally {
        warn.mockRestore();
      }
    });

    it('resolves with nothing to reread and touches neither the read nor the listener', async () => {
      await jest.isolateModulesAsync(async () => {
        const { rereadStorageCache: rereadFresh } = await import('./storage');
        await expect(rereadFresh()).resolves.toBeUndefined();
      });

      expect(mockStorage.local.get).not.toHaveBeenCalled();
      expect(mockStorage.onChanged.addListener).not.toHaveBeenCalled();
    });

    it('logs a failed attach, lets the read through, and attaches on the next read', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockStorage.local.get.mockResolvedValue({ k: 'v' });
      let imports = 0;
      // A mock the registry already holds would be reused, so the failing one needs a fresh registry.
      jest.resetModules();
      jest.doMock('webextension-polyfill', () => {
        imports += 1;
        if (imports === 1) throw new Error('chunk failed to load');
        return mockPolyfillModule();
      });
      try {
        const { preloadStorage: preloadFresh } = await import('./storage');
        const { SWRConfig } = await import('swr');

        await expect(preloadFresh(['k'])).resolves.toBeUndefined();
        expect(SWRConfig.defaultValue.cache.get('k')?.data).toBe('v');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(mockStorage.onChanged.addListener).not.toHaveBeenCalled();

        await preloadFresh(['k']);
        expect(mockStorage.onChanged.addListener).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        jest.doMock('webextension-polyfill', mockPolyfillModule);
        jest.resetModules();
      }
    });
  });
});
