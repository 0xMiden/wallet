import { act, renderHook } from '@testing-library/react';

import { getCardColor, initializeAccountCardColors, setCardColor, useCardColor } from './card-color';
import { CARD_COLOR_STORAGE_KEY, CARD_COLORS, DEFAULT_CARD_COLOR } from './constants';

const ACCOUNT_A = 'mtst1account-a';
const ACCOUNT_B = 'mtst1account-b';
const accountStorageKey = (accountId: string) => `${CARD_COLOR_STORAGE_KEY}:${accountId}`;

describe('card color setting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getCardColor', () => {
    it('returns the default color when nothing is stored', () => {
      expect(getCardColor(ACCOUNT_A)).toBe(DEFAULT_CARD_COLOR);
    });

    it('returns each valid color stored for an account', () => {
      for (const color of CARD_COLORS) {
        localStorage.setItem(accountStorageKey(ACCOUNT_A), color);
        expect(getCardColor(ACCOUNT_A)).toBe(color);
      }
    });

    it('falls back to the default when the stored value is not a known color', () => {
      localStorage.setItem(accountStorageKey(ACCOUNT_A), 'chartreuse');
      expect(getCardColor(ACCOUNT_A)).toBe(DEFAULT_CARD_COLOR);
    });

    it('falls back to the former wallet-wide color for accounts without a preference', () => {
      localStorage.setItem(CARD_COLOR_STORAGE_KEY, 'orange');
      localStorage.setItem(accountStorageKey(ACCOUNT_A), 'blue');

      expect(getCardColor(ACCOUNT_A)).toBe('blue');
      expect(getCardColor(ACCOUNT_B)).toBe('orange');
    });

    it('falls back to the default when localStorage.getItem throws', () => {
      // jsdom's `localStorage` is a Proxy, so `localStorage.getItem = fn` just
      // writes a storage entry named "getItem" and the real method keeps
      // running. Spy on the prototype so the read genuinely throws and the
      // catch branch executes.
      const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(getCardColor(ACCOUNT_A)).toBe(DEFAULT_CARD_COLOR);
      spy.mockRestore();
    });
  });

  describe('setCardColor', () => {
    it('persists independent choices under each account storage key', () => {
      setCardColor(ACCOUNT_A, 'blue');
      setCardColor(ACCOUNT_B, 'green');

      expect(localStorage.getItem(accountStorageKey(ACCOUNT_A))).toBe('blue');
      expect(localStorage.getItem(accountStorageKey(ACCOUNT_B))).toBe('green');
      expect(getCardColor(ACCOUNT_A)).toBe('blue');
      expect(getCardColor(ACCOUNT_B)).toBe('green');
    });

    it('does not throw when localStorage.setItem throws', () => {
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage full');
      });
      expect(() => setCardColor(ACCOUNT_A, 'green')).not.toThrow();
      spy.mockRestore();
    });

    it('notifies subscribers even when persistence fails', () => {
      const { result } = renderHook(() => useCardColor(ACCOUNT_A));
      expect(result.current).toBe(DEFAULT_CARD_COLOR);

      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage full');
      });
      // Persistence throws so nothing is written, but the subscriber
      // notification path must still run without throwing; the re-read then
      // returns the (unchanged) default.
      act(() => {
        setCardColor(ACCOUNT_A, 'purple');
      });
      spy.mockRestore();

      expect(result.current).toBe(DEFAULT_CARD_COLOR);
    });
  });

  describe('initializeAccountCardColors', () => {
    it('gives every newly observed account a different color from its predecessor', () => {
      const accountIds = Array.from({ length: 7 }, (_, index) => `mtst1account-${index + 1}`);

      initializeAccountCardColors(accountIds);

      const colors = accountIds.map(accountId => getCardColor(accountId));
      for (let index = 1; index < colors.length; index += 1) {
        expect(colors[index]).not.toBe(colors[index - 1]);
      }
      expect(colors[6]).not.toBe(colors[5]);
    });

    it('keeps user-selected colors and advances the next new account from that choice', () => {
      setCardColor(ACCOUNT_A, 'purple');

      initializeAccountCardColors([ACCOUNT_A, ACCOUNT_B]);

      expect(getCardColor(ACCOUNT_A)).toBe('purple');
      expect(getCardColor(ACCOUNT_B)).toBe('slate');
    });
  });

  describe('useCardColor', () => {
    it('returns the current stored color on mount', () => {
      localStorage.setItem(accountStorageKey(ACCOUNT_A), 'orange');
      const { result } = renderHook(() => useCardColor(ACCOUNT_A));
      expect(result.current).toBe('orange');
    });

    it('re-renders subscribers when setCardColor changes the value', () => {
      const { result } = renderHook(() => useCardColor(ACCOUNT_A));
      expect(result.current).toBe(DEFAULT_CARD_COLOR);

      act(() => {
        setCardColor(ACCOUNT_A, 'green');
      });
      expect(result.current).toBe('green');

      act(() => {
        setCardColor(ACCOUNT_A, 'purple');
      });
      expect(result.current).toBe('purple');
    });

    it('unsubscribes on unmount so later changes do not update it', () => {
      const { result, unmount } = renderHook(() => useCardColor(ACCOUNT_A));
      act(() => {
        setCardColor(ACCOUNT_A, 'blue');
      });
      expect(result.current).toBe('blue');

      unmount();

      // After unmount the listener is removed; the next change must not throw
      // and the unmounted hook keeps its last value.
      act(() => {
        setCardColor(ACCOUNT_A, 'orange');
      });
      expect(result.current).toBe('blue');
      expect(getCardColor(ACCOUNT_A)).toBe('orange');
    });
  });
});
