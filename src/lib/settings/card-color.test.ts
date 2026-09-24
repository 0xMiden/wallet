import { act, renderHook } from '@testing-library/react';

import { getCardColor, setCardColor, useCardColor } from './card-color';
import { CARD_COLOR_STORAGE_KEY, CARD_COLORS, DEFAULT_CARD_COLOR } from './constants';
import { createPersistedSetting } from './persisted-setting';

// Every listener React hands a setting's `subscribe` is a spy, so a test can see whether a write
// still reaches a hook after it unmounted.
const mockListeners: jest.Mock[] = [];
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  const spied = new WeakMap<object, (listener: () => void) => () => void>();
  return {
    ...actual,
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
      let wrapped = spied.get(subscribe);
      if (!wrapped) {
        wrapped = listener => {
          const spy = jest.fn(listener);
          mockListeners.push(spy);
          return subscribe(spy);
        };
        spied.set(subscribe, wrapped);
      }
      return actual.useSyncExternalStore(wrapped, getSnapshot);
    }
  };
});

describe('card color setting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getCardColor', () => {
    it('returns the default color when nothing is stored', () => {
      expect(getCardColor()).toBe(DEFAULT_CARD_COLOR);
    });

    it('returns each valid stored color', () => {
      for (const color of CARD_COLORS) {
        localStorage.setItem(CARD_COLOR_STORAGE_KEY, color);
        expect(getCardColor()).toBe(color);
      }
    });

    it('falls back to the default when the stored value is not a known color', () => {
      localStorage.setItem(CARD_COLOR_STORAGE_KEY, 'chartreuse');
      expect(getCardColor()).toBe(DEFAULT_CARD_COLOR);
    });

    it('falls back to the default when localStorage.getItem throws', () => {
      // jsdom's `localStorage` is a Proxy, so `localStorage.getItem = fn` just
      // writes a storage entry named "getItem" and the real method keeps
      // running. Spy on the prototype so the read genuinely throws and the
      // catch branch executes.
      const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(getCardColor()).toBe(DEFAULT_CARD_COLOR);
      spy.mockRestore();
    });
  });

  describe('setCardColor', () => {
    it('persists the chosen color under the storage key', () => {
      setCardColor('blue');
      expect(localStorage.getItem(CARD_COLOR_STORAGE_KEY)).toBe('blue');
      expect(getCardColor()).toBe('blue');
    });

    it('does not throw when localStorage.setItem throws', () => {
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage full');
      });
      expect(() => setCardColor('green')).not.toThrow();
      spy.mockRestore();
      expect(getCardColor()).toBe('green');
      // A successful write ends the in-memory value, so it cannot leak into the next case.
      setCardColor(DEFAULT_CARD_COLOR);
    });

    it('takes effect when storage refuses the write, then reads storage again once a write succeeds', () => {
      const { result } = renderHook(() => useCardColor());
      expect(result.current).toBe(DEFAULT_CARD_COLOR);

      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage full');
      });
      act(() => {
        setCardColor('purple');
      });
      spy.mockRestore();

      expect(localStorage.getItem(CARD_COLOR_STORAGE_KEY)).toBeNull();
      expect(getCardColor()).toBe('purple');
      expect(result.current).toBe('purple');

      act(() => {
        setCardColor('blue');
      });
      expect(localStorage.getItem(CARD_COLOR_STORAGE_KEY)).toBe('blue');
      expect(result.current).toBe('blue');
      // Storage is the source again, read fresh: a value written behind the setting's back is seen.
      localStorage.setItem(CARD_COLOR_STORAGE_KEY, 'orange');
      expect(getCardColor()).toBe('orange');
    });
  });

  describe('useCardColor', () => {
    it('returns the current stored color on mount', () => {
      localStorage.setItem(CARD_COLOR_STORAGE_KEY, 'orange');
      const { result } = renderHook(() => useCardColor());
      expect(result.current).toBe('orange');
    });

    it('re-renders subscribers when setCardColor changes the value', () => {
      const { result } = renderHook(() => useCardColor());
      expect(result.current).toBe(DEFAULT_CARD_COLOR);

      act(() => {
        setCardColor('green');
      });
      expect(result.current).toBe('green');

      act(() => {
        setCardColor('purple');
      });
      expect(result.current).toBe('purple');
    });

    it('unsubscribes on unmount so later changes do not reach it', () => {
      mockListeners.length = 0;
      const { unmount } = renderHook(() => useCardColor());
      act(() => {
        setCardColor('blue');
      });
      expect(mockListeners.some(listener => listener.mock.calls.length > 0)).toBe(true);

      unmount();
      mockListeners.forEach(listener => listener.mockClear());

      act(() => {
        setCardColor('orange');
      });
      expect(mockListeners.every(listener => listener.mock.calls.length === 0)).toBe(true);
      expect(getCardColor()).toBe('orange');
    });
  });

  describe('createPersistedSetting', () => {
    const KEY = 'persisted_setting_test';
    const make = () => createPersistedSetting(KEY, ['a', 'b'] as const, 'a');

    it('stops telling a listener about writes once it unsubscribes', () => {
      const setting = make();
      const listener = jest.fn();
      const unsubscribe = setting.subscribe(listener);
      setting.set('b');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      setting.set('a');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reads the fallback, writes through storage, and re-renders subscribers', () => {
      const setting = make();
      expect(setting.get()).toBe('a');

      const { result, unmount } = renderHook(() => setting.useValue());
      expect(result.current).toBe('a');

      act(() => {
        setting.set('b');
      });
      expect(localStorage.getItem(KEY)).toBe('b');
      expect(setting.get()).toBe('b');
      expect(result.current).toBe('b');

      unmount();
      act(() => {
        setting.set('a');
      });
      expect(result.current).toBe('b');
    });

    it('falls back when the stored value is outside the allow-list', () => {
      localStorage.setItem(KEY, 'c');
      expect(make().get()).toBe('a');
    });
  });
});
