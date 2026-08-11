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
  getThemeSetting,
  isValidGuardianUrl,
  sanitizeGuardianUrl,
  isAutoConsumeEnabledAsync,
  isDelegateProofEnabledAsync,
  mirrorBackgroundSettings,
  areBackgroundSettingsMirrored
} from './helpers';

const mockKvStore: Record<string, unknown> = {};
let mockStorageThrows = false;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => {
    if (mockStorageThrows) throw new Error('storage provider not ready');
    return {
      get: async (keys: string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(mockKvStore, obj);
      }
    };
  }
}));

describe('settings helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
    mockStorageThrows = false;
  });

  describe('isValidGuardianUrl', () => {
    it('accepts https URLs', () => {
      expect(isValidGuardianUrl('https://guardian.example.com')).toBe(true);
      expect(isValidGuardianUrl('  https://guardian.example.com/path  ')).toBe(true);
    });

    it('accepts http only for localhost / 127.0.0.1', () => {
      expect(isValidGuardianUrl('http://localhost:8080')).toBe(true);
      expect(isValidGuardianUrl('http://127.0.0.1:3000')).toBe(true);
    });

    it('rejects plain http on non-localhost hosts (signatures must use TLS)', () => {
      expect(isValidGuardianUrl('http://guardian.example.com')).toBe(false);
    });

    it('rejects malformed / non-http(s) input', () => {
      expect(isValidGuardianUrl('')).toBe(false);
      expect(isValidGuardianUrl('not-a-url')).toBe(false);
      expect(isValidGuardianUrl('ftp://guardian.example.com')).toBe(false);
      expect(isValidGuardianUrl('guardian.example.com')).toBe(false);
    });
  });

  describe('sanitizeGuardianUrl', () => {
    it('trims whitespace and strips trailing slashes', () => {
      expect(sanitizeGuardianUrl('  https://guardian.example.com/  ')).toBe('https://guardian.example.com');
      expect(sanitizeGuardianUrl('https://guardian.example.com///')).toBe('https://guardian.example.com');
      expect(sanitizeGuardianUrl('https://guardian.example.com/path/')).toBe('https://guardian.example.com/path');
    });

    it('leaves an already-clean URL unchanged', () => {
      expect(sanitizeGuardianUrl('https://guardian.example.com')).toBe('https://guardian.example.com');
    });
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

    it('defaults to off so a completed transaction screen is not auto-dismissed before the user acts (#472)', () => {
      // No stored setting (localStorage cleared in beforeEach).
      expect(isAutoCloseEnabled()).toBe(false);
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

  describe('auto consume setting mirror (service-worker readable)', () => {
    it('isAutoConsumeEnabledAsync defaults ON when the mirror is absent', async () => {
      expect(await isAutoConsumeEnabledAsync()).toBe(DEFAULT_AUTO_CONSUME);
    });

    it('setAutoConsumeSetting write-throughs to the SW-readable mirror', async () => {
      setAutoConsumeSetting(false);
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      setAutoConsumeSetting(true);
      expect(await isAutoConsumeEnabledAsync()).toBe(true);
    });

    it('mirrorBackgroundSettings copies the current localStorage values into the mirror', async () => {
      localStorage.setItem(AUTO_CONSUME_STORAGE_KEY, JSON.stringify(false));
      localStorage.setItem(DELEGATE_PROOF_STORAGE_KEY, JSON.stringify(false));
      mirrorBackgroundSettings();
      await Promise.resolve();
      expect(await isAutoConsumeEnabledAsync()).toBe(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
    });
  });

  describe('delegate proof setting mirror (service-worker readable)', () => {
    it('isDelegateProofEnabledAsync defaults to the delegate default when the mirror is absent', async () => {
      expect(await isDelegateProofEnabledAsync()).toBe(DEFAULT_DELEGATE_PROOF);
    });

    it('setDelegateProofSetting write-throughs to the SW-readable mirror', async () => {
      setDelegateProofSetting(false);
      expect(await isDelegateProofEnabledAsync()).toBe(false);
      setDelegateProofSetting(true);
      expect(await isDelegateProofEnabledAsync()).toBe(true);
    });
  });

  describe('background-settings mirror marker', () => {
    it('areBackgroundSettingsMirrored defaults false until the popup mirrors', async () => {
      expect(await areBackgroundSettingsMirrored()).toBe(false);
    });

    it('mirrorBackgroundSettings sets the marker so the SW may act', async () => {
      mirrorBackgroundSettings();
      await Promise.resolve();
      expect(await areBackgroundSettingsMirrored()).toBe(true);
    });
  });

  describe('mirror is resilient to an unavailable storage provider', () => {
    it('setters and mirrorBackgroundSettings do not throw when getStorageProvider throws', () => {
      mockStorageThrows = true;
      expect(() => setAutoConsumeSetting(false)).not.toThrow();
      expect(() => setDelegateProofSetting(false)).not.toThrow();
      expect(() => mirrorBackgroundSettings()).not.toThrow();
    });

    it('async readers return defaults when getStorageProvider throws', async () => {
      mockStorageThrows = true;
      expect(await isAutoConsumeEnabledAsync()).toBe(DEFAULT_AUTO_CONSUME);
      expect(await isDelegateProofEnabledAsync()).toBe(DEFAULT_DELEGATE_PROOF);
      expect(await areBackgroundSettingsMirrored()).toBe(false);
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
    it('returns default theme (system) when not set', () => {
      expect(getThemeSetting()).toBe('system');
    });

    it('sets and gets dark theme', () => {
      setThemeSetting('dark');
      expect(getThemeSetting()).toBe('dark');
    });

    it('sets and gets light theme', () => {
      setThemeSetting('light');
      expect(getThemeSetting()).toBe('light');
    });

    it('sets and gets system theme', () => {
      setThemeSetting('system');
      expect(getThemeSetting()).toBe('system');
    });

    it('returns default when stored value is invalid', () => {
      localStorage.setItem('theme_setting', 'invalid');
      expect(getThemeSetting()).toBe('system');
    });

    it('handles localStorage error in getThemeSetting', () => {
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = () => {
        throw new Error('Storage error');
      };
      expect(getThemeSetting()).toBe('system');
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
