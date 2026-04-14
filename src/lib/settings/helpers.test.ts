import {
  DELEGATE_PROOF_STORAGE_KEY,
  AUTO_CLOSE_STORAGE_KEY,
  AUTO_CONSUME_STORAGE_KEY,
  HAPTIC_FEEDBACK_STORAGE_KEY,
  DEFAULT_DELEGATE_PROOF,
  DEFAULT_AUTO_CLOSE,
  DEFAULT_AUTO_CONSUME,
  DEFAULT_HAPTIC_FEEDBACK
} from './constants';
import {
  setDelegateProofSetting,
  isDelegateProofEnabled,
  setAutoCloseSetting,
  isAutoCloseEnabled,
  setAutoConsumeSetting,
  isAutoConsumeEnabled,
  setHapticFeedbackSetting,
  isHapticFeedbackEnabled,
  setThemeSetting,
  getThemeSetting
} from './helpers';

describe('settings helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('delegate proof setting', () => {
    it('returns default value when not set', () => {
      expect(isDelegateProofEnabled()).toBe(DEFAULT_DELEGATE_PROOF);
    });

    it('sets and gets true value', () => {
      setDelegateProofSetting(true);
      expect(isDelegateProofEnabled()).toBe(true);
      expect(localStorage.getItem(DELEGATE_PROOF_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setDelegateProofSetting(false);
      expect(isDelegateProofEnabled()).toBe(false);
      expect(localStorage.getItem(DELEGATE_PROOF_STORAGE_KEY)).toBe('false');
    });
  });

  describe('auto close setting', () => {
    it('returns default value when not set', () => {
      expect(isAutoCloseEnabled()).toBe(DEFAULT_AUTO_CLOSE);
    });

    it('sets and gets true value', () => {
      setAutoCloseSetting(true);
      expect(isAutoCloseEnabled()).toBe(true);
      expect(localStorage.getItem(AUTO_CLOSE_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setAutoCloseSetting(false);
      expect(isAutoCloseEnabled()).toBe(false);
      expect(localStorage.getItem(AUTO_CLOSE_STORAGE_KEY)).toBe('false');
    });
  });

  describe('auto consume setting', () => {
    it('returns default value when not set', () => {
      expect(isAutoConsumeEnabled()).toBe(DEFAULT_AUTO_CONSUME);
    });

    it('sets and gets true value', () => {
      setAutoConsumeSetting(true);
      expect(isAutoConsumeEnabled()).toBe(true);
      expect(localStorage.getItem(AUTO_CONSUME_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setAutoConsumeSetting(false);
      expect(isAutoConsumeEnabled()).toBe(false);
      expect(localStorage.getItem(AUTO_CONSUME_STORAGE_KEY)).toBe('false');
    });
  });

  describe('haptic feedback setting', () => {
    it('returns default value when not set', () => {
      expect(isHapticFeedbackEnabled()).toBe(DEFAULT_HAPTIC_FEEDBACK);
    });

    it('sets and gets true value', () => {
      setHapticFeedbackSetting(true);
      expect(isHapticFeedbackEnabled()).toBe(true);
      expect(localStorage.getItem(HAPTIC_FEEDBACK_STORAGE_KEY)).toBe('true');
    });

    it('sets and gets false value', () => {
      setHapticFeedbackSetting(false);
      expect(isHapticFeedbackEnabled()).toBe(false);
      expect(localStorage.getItem(HAPTIC_FEEDBACK_STORAGE_KEY)).toBe('false');
    });
  });

  describe('theme setting', () => {
    it('returns default theme when not set', () => {
      expect(getThemeSetting()).toBe('light');
    });

    it('sets and gets dark theme', () => {
      setThemeSetting('dark');
      expect(getThemeSetting()).toBe('dark');
    });

    it('sets and gets light theme', () => {
      setThemeSetting('light');
      expect(getThemeSetting()).toBe('light');
    });

    it('returns default when stored value is invalid', () => {
      localStorage.setItem('theme_setting', 'invalid');
      expect(getThemeSetting()).toBe('light');
    });

    it('handles localStorage error in getThemeSetting', () => {
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = () => {
        throw new Error('Storage error');
      };
      expect(getThemeSetting()).toBe('light');
      localStorage.getItem = originalGetItem;
    });

    it('handles localStorage error in setThemeSetting', () => {
      const originalSetItem = localStorage.setItem;
      localStorage.setItem = () => {
        throw new Error('Storage full');
      };
      expect(() => setThemeSetting('dark')).not.toThrow();
      localStorage.setItem = originalSetItem;
    });
  });

  describe('error handling', () => {
    it('handles localStorage errors gracefully on set', () => {
      const originalSetItem = localStorage.setItem;
      localStorage.setItem = () => {
        throw new Error('Storage full');
      };

      // Should not throw
      expect(() => setDelegateProofSetting(true)).not.toThrow();

      localStorage.setItem = originalSetItem;
    });
  });
});
