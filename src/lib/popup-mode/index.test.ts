import {
  POPUP_MODE_STORAGE_KEY,
  DEFAULT_POPUP_MODE,
  setPopupMode,
  isPopupModeEnabled
} from './index';

describe('popup-mode storage helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  describe('constants', () => {
    it('exposes the storage key and default mode', () => {
      expect(POPUP_MODE_STORAGE_KEY).toBe('popup_mode');
      expect(DEFAULT_POPUP_MODE).toBe(true);
    });
  });

  describe('setPopupMode', () => {
    it('persists the enabled value as JSON under the storage key', () => {
      setPopupMode(true);
      expect(localStorage.getItem(POPUP_MODE_STORAGE_KEY)).toBe('true');
    });

    it('persists the disabled value as JSON under the storage key', () => {
      setPopupMode(false);
      expect(localStorage.getItem(POPUP_MODE_STORAGE_KEY)).toBe('false');
    });

    it('swallows errors thrown by localStorage.setItem', () => {
      const setItemSpy = jest
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('quota exceeded');
        });

      expect(() => setPopupMode(true)).not.toThrow();
      expect(setItemSpy).toHaveBeenCalledWith(
        POPUP_MODE_STORAGE_KEY,
        JSON.stringify(true)
      );
    });
  });

  describe('isPopupModeEnabled', () => {
    it('returns the default when nothing is stored', () => {
      expect(isPopupModeEnabled()).toBe(DEFAULT_POPUP_MODE);
    });

    it('returns the default when the stored value is an empty string', () => {
      // Empty string is falsy, exercising the else branch of the ternary
      // without going through JSON.parse.
      localStorage.setItem(POPUP_MODE_STORAGE_KEY, '');
      expect(isPopupModeEnabled()).toBe(DEFAULT_POPUP_MODE);
    });

    it('returns true when true was previously stored', () => {
      setPopupMode(true);
      expect(isPopupModeEnabled()).toBe(true);
    });

    it('returns false when false was previously stored', () => {
      setPopupMode(false);
      expect(isPopupModeEnabled()).toBe(false);
    });

    it('round-trips the value written by setPopupMode', () => {
      setPopupMode(false);
      expect(isPopupModeEnabled()).toBe(false);
      setPopupMode(true);
      expect(isPopupModeEnabled()).toBe(true);
    });
  });
});
