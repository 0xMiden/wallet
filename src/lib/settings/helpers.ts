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
  DEFAULT_THEME
} from './constants';

function setSetting(key: string, value: boolean) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
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

export function setThemeSetting(theme: 'light' | 'dark') {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

export function getThemeSetting(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' ? 'dark' : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
