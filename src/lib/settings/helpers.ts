import { getStorageProvider } from 'lib/platform/storage-adapter';

import {
  DEFAULT_DELEGATE_PROOF,
  DELEGATE_PROOF_STORAGE_KEY,
  AUTO_CONSUME_STORAGE_KEY,
  DEFAULT_AUTO_CONSUME,
  BG_SETTINGS_MIRRORED_KEY,
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

/**
 * Write a boolean setting to the platform KV store so the extension service worker
 * (which has no `localStorage`) can read it via `readMirroredSetting`. Guarded:
 * `getStorageProvider()` can throw before platform detection is ready.
 */
function mirrorSetting(key: string, value: boolean): void {
  try {
    void getStorageProvider()
      .set({ [key]: value })
      .catch(() => {});
  } catch {
    /* storage not ready — the startup mirror / defaults cover it */
  }
}

/** Service-worker-safe read of a mirrored boolean setting (default on read-miss). */
async function readMirroredSetting(key: string, defaultValue: boolean): Promise<boolean> {
  try {
    const items = await getStorageProvider().get([key]);
    const value = items[key];
    return typeof value === 'boolean' ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setDelegateProofSetting(enabled: boolean) {
  setSetting(DELEGATE_PROOF_STORAGE_KEY, enabled);
  mirrorSetting(DELEGATE_PROOF_STORAGE_KEY, enabled);
}

export function isDelegateProofEnabled() {
  return getSetting(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF);
}

/**
 * Service-worker-safe read of the delegated-proving toggle (the SW cannot read
 * `localStorage`). Background native-note auto-consume proves via this so it honors
 * the user's delegated/local choice, exactly like every in-page proving path.
 */
export function isDelegateProofEnabledAsync(): Promise<boolean> {
  return readMirroredSetting(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF);
}

export function setAutoConsumeSetting(enabled: boolean) {
  setSetting(AUTO_CONSUME_STORAGE_KEY, enabled);
  mirrorSetting(AUTO_CONSUME_STORAGE_KEY, enabled);
}

export function isAutoConsumeEnabled() {
  return getSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
}

/**
 * Service-worker-safe read of the auto-consume toggle (the SW cannot read
 * `localStorage`). Defaults to ON when the mirror is absent (matches
 * `DEFAULT_AUTO_CONSUME`) so existing users who never toggled it are not silently
 * opted out of background auto-consume.
 */
export function isAutoConsumeEnabledAsync(): Promise<boolean> {
  return readMirroredSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
}

/**
 * One-shot migration: copy the current `localStorage` values of the settings the
 * extension service worker needs — auto-consume (whether to run) and delegated-proving
 * (how to prove) — into the platform KV mirror, so the SW honors a user's choices it
 * otherwise can't read. Setting changes also write-through via their setters; this
 * covers existing users who never re-toggle. Call from a frontend context (the popup)
 * where `localStorage` is available.
 */
export function mirrorBackgroundSettings(): void {
  mirrorSetting(AUTO_CONSUME_STORAGE_KEY, isAutoConsumeEnabled());
  mirrorSetting(DELEGATE_PROOF_STORAGE_KEY, isDelegateProofEnabled());
  // Marker last: the SW treats an absent marker as "settings not yet mirrored" and
  // holds off background native-consume, so it never acts on read-miss defaults for a
  // user who opted out of auto-consume or remote proving.
  mirrorSetting(BG_SETTINGS_MIRRORED_KEY, true);
}

/**
 * True once `mirrorBackgroundSettings` has run (from the popup). The extension service
 * worker gates its background native-note auto-consume on this — before the first
 * mirror the SW would otherwise read defaults and could auto-consume / remote-prove
 * against a user who opted out. Defaults false (not mirrored) on read-miss.
 */
export function areBackgroundSettingsMirrored(): Promise<boolean> {
  return readMirroredSetting(BG_SETTINGS_MIRRORED_KEY, false);
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
