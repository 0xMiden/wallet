import {
  DEFAULT_DELEGATE_PROOF,
  DELEGATE_PROOF_STORAGE_KEY,
  DEFAULT_AUTO_CLOSE,
  AUTO_CLOSE_STORAGE_KEY,
  AUTO_CONSUME_STORAGE_KEY,
  DEFAULT_AUTO_CONSUME,
  HAPTIC_FEEDBACK_STORAGE_KEY,
  DEFAULT_HAPTIC_FEEDBACK,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  ThemeSetting
} from './constants';

function setSetting(key: string, value: boolean) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } /* c8 ignore next -- jsdom localStorage.setItem is non-configurable */ catch {}
}

function getSetting(key: string, defaultValue: boolean) {
  const stored = localStorage.getItem(key);
  return stored ? (JSON.parse(stored) as boolean) : defaultValue;
}

export function setDelegateProofSetting(enabled: boolean) {
  setSetting(DELEGATE_PROOF_STORAGE_KEY, enabled);
}

export function isDelegateProofEnabled() {
  return getSetting(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF);
}

export function setAutoCloseSetting(enabled: boolean) {
  setSetting(AUTO_CLOSE_STORAGE_KEY, enabled);
}

export function isAutoCloseEnabled() {
  return getSetting(AUTO_CLOSE_STORAGE_KEY, DEFAULT_AUTO_CLOSE);
}

export function setAutoConsumeSetting(enabled: boolean) {
  setSetting(AUTO_CONSUME_STORAGE_KEY, enabled);
}

export function isAutoConsumeEnabled() {
  return getSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
}

export function setHapticFeedbackSetting(enabled: boolean) {
  setSetting(HAPTIC_FEEDBACK_STORAGE_KEY, enabled);
}

export function isHapticFeedbackEnabled() {
  return getSetting(HAPTIC_FEEDBACK_STORAGE_KEY, DEFAULT_HAPTIC_FEEDBACK);
}

/**
 * Validate a Guardian endpoint URL. Guardian auth signatures are sent to this
 * endpoint, so require TLS; plain http:// is only tolerated for localhost
 * development. Shared by the onboarding import flow and Guardian Settings.
 */
export function isValidGuardianUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost);
}

export function setThemeSetting(theme: ThemeSetting) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } /* c8 ignore next -- jsdom localStorage.setItem is non-configurable */ catch {}
}

export function getThemeSetting(): ThemeSetting {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored;
    }
    return DEFAULT_THEME;
  } /* c8 ignore next 2 -- jsdom localStorage.getItem is non-configurable */ catch {
    return DEFAULT_THEME;
  }
}
