import { getStorageProvider } from 'lib/platform/storage-adapter';

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
  // Mirror to the platform KV store. The extension service worker (background
  // native-note auto-consume in sync-manager runSync) has NO `localStorage`, so it
  // reads the toggle from here via `isAutoConsumeEnabledAsync`. Fire-and-forget;
  // frontend `isAutoConsumeEnabled` remains the source of truth for the in-page UI.
  // Guarded: getStorageProvider() can throw before platform detection is ready.
  try {
    void getStorageProvider()
      .set({ [AUTO_CONSUME_STORAGE_KEY]: enabled })
      .catch(() => {});
  } catch {
    /* storage not ready — the startup mirror / SW default (ON) cover it */
  }
}

export function isAutoConsumeEnabled() {
  return getSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
}

/**
 * Service-worker-safe read of the auto-consume toggle (the SW cannot read
 * `localStorage`). Reads the platform KV mirror written by `setAutoConsumeSetting` /
 * `mirrorAutoConsumeSetting`. Defaults to ON when the mirror is absent (matches
 * `DEFAULT_AUTO_CONSUME`) so existing users who never toggled the setting are not
 * silently opted out of background auto-consume.
 */
export async function isAutoConsumeEnabledAsync(): Promise<boolean> {
  try {
    const items = await getStorageProvider().get([AUTO_CONSUME_STORAGE_KEY]);
    const value = items[AUTO_CONSUME_STORAGE_KEY];
    return typeof value === 'boolean' ? value : DEFAULT_AUTO_CONSUME;
  } catch {
    return DEFAULT_AUTO_CONSUME;
  }
}

/**
 * One-shot migration: copy the current `localStorage` auto-consume value into the
 * platform KV mirror so an existing user who had turned auto-consume OFF is honored
 * by the extension service worker (which otherwise defaults ON). Call from a
 * frontend context (the popup) where `localStorage` is available.
 */
export function mirrorAutoConsumeSetting(): void {
  try {
    void getStorageProvider()
      .set({ [AUTO_CONSUME_STORAGE_KEY]: isAutoConsumeEnabled() })
      .catch(() => {});
  } catch {
    /* storage not ready — write-through on the next setting change covers it */
  }
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

/**
 * Normalize a Guardian endpoint for storage and comparison: trim surrounding
 * whitespace and strip any trailing slashes, so `https://g.example.com/` and
 * `https://g.example.com` are treated as the same endpoint. Apply this to any
 * user-entered Guardian URL before persisting or comparing it.
 */
export function sanitizeGuardianUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
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
