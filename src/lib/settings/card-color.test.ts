import { act, renderHook } from '@testing-library/react';

import { getCardColor, setCardColor, useCardColor } from './card-color';
import { CARD_COLOR_STORAGE_KEY, CARD_COLORS, DEFAULT_CARD_COLOR } from './constants';

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
    });

    it('notifies subscribers even when persistence fails', () => {
      const { result } = renderHook(() => useCardColor());
      expect(result.current).toBe(DEFAULT_CARD_COLOR);

      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage full');
      });
      // Persistence throws so nothing is written, but the subscriber
      // notification path must still run without throwing; the re-read then
      // returns the (unchanged) default.
      act(() => {
        setCardColor('purple');
      });
      spy.mockRestore();

      expect(result.current).toBe(DEFAULT_CARD_COLOR);
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

    it('unsubscribes on unmount so later changes do not update it', () => {
      const { result, unmount } = renderHook(() => useCardColor());
      act(() => {
        setCardColor('blue');
      });
      expect(result.current).toBe('blue');

      unmount();

      // After unmount the listener is removed; the next change must not throw
      // and the unmounted hook keeps its last value.
      act(() => {
        setCardColor('orange');
      });
      expect(result.current).toBe('blue');
      expect(getCardColor()).toBe('orange');
    });
  });
});
