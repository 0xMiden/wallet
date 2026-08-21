import { isExtension } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';

import {
  DEFAULT_DELEGATE_PROOF,
  DELEGATE_PROOF_STORAGE_KEY,
  AUTO_CONSUME_STORAGE_KEY,
  DEFAULT_AUTO_CONSUME,
  TELEMETRY_STORAGE_KEY,
  DEFAULT_TELEMETRY,
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

export function setTelemetrySetting(enabled: boolean) {
  setSetting(TELEMETRY_STORAGE_KEY, enabled);
  mirrorSetting(TELEMETRY_STORAGE_KEY, enabled);
}

export function isTelemetryEnabled() {
  return getSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);
}

/**
 * The Firefox data-collection permission the wallet declares as optional. Must
 * stay in step with `data_collection_permissions.optional` in
 * `public/manifest.v2.json` and `public/manifest.json`.
 */
const TECHNICAL_AND_INTERACTION = 'technicalAndInteraction';

/**
 * Whether the *browser* permits data collection, independently of our own
 * setting.
 *
 * Firefox 140+ asks the user whether the extension may collect
 * `technicalAndInteraction` data — at install time, and again in `about:addons`
 * → Permissions and data. That is a second consent sitting beside "Share usage
 * data", and two consents that can disagree is a defect, so both have to say
 * yes before anything is sent.
 *
 * **How "this browser has no such concept" is told apart from "this browser
 * said no".** This is the whole difficulty, and getting it backwards fails
 * silently in one of two directions: read an absent mechanism as a refusal and
 * telemetry dies everywhere including Chrome and mobile, with no error; read a
 * refusal as an absent mechanism and we collect from someone who explicitly
 * declined. Neither shows up as a crash.
 *
 * The discriminator is therefore NOT whether the call throws — Chrome would
 * reject an unknown `data_collection` key passed to `permissions.contains()`,
 * so keying off a throw is exactly the trap. It is the **presence of the
 * `data_collection` key in the `permissions.getAll()` response**, which is the
 * mechanism Mozilla documents for feature-detecting this experience at runtime:
 *
 * - **Key absent** — the browser does not implement data-collection consent at
 *   all (Chrome, any Firefox below 140). There is no browser-level answer to
 *   honour, so this gate abstains and the wallet's own setting decides.
 * - **Key present** — the browser implements it and its answer is
 *   authoritative. Granted only if the array actually names our data type. An
 *   empty array is a refusal, not an absence, and that is the distinction the
 *   key's presence buys us.
 *
 * Everything else fails **closed**: a non-extension context aside, a throw, a
 * rejected promise, or a `data_collection` that is not an array all return
 * false, because an error reading a permission must never read as permission
 * granted.
 *
 * Off-extension (mobile, desktop) there is no extension permission model to
 * consult, so this abstains rather than failing closed. Abstaining is not
 * failing open: the caller still requires the wallet's own setting to be on.
 */
async function isDataCollectionPermitted(): Promise<boolean> {
  if (!isExtension()) return true;

  try {
    const browser = await import('webextension-polyfill').then(m => m.default);
    const granted = await browser.permissions.getAll();
    const dataCollection = granted.data_collection;

    if (dataCollection === undefined) return true;

    // Not `dataCollection.includes(...)` alone: a bare string would satisfy
    // `includes` and read as granted.
    return Array.isArray(dataCollection) && dataCollection.includes(TECHNICAL_AND_INTERACTION);
  } catch {
    return false;
  }
}

/**
 * Service-worker-safe read of the telemetry consent toggle. The background is
 * the single consent gate for every send, so this is the authoritative read,
 * and it is the one place the browser-level permission is ANDed in — both
 * egress points (`lib/telemetry/sink` and `lib/telemetry/crash`) call this, so
 * there is one gate to audit rather than a discipline applied twice.
 *
 * Defaults to OFF on read-miss — unlike auto-consume, a missing mirror here
 * must fail closed.
 *
 * The local read comes first deliberately: it is cheap and it is false for
 * almost everyone, so the common opted-out path never touches an extension API.
 */
export async function isTelemetryEnabledAsync(): Promise<boolean> {
  if (!(await readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY))) return false;
  return isDataCollectionPermitted();
}

/**
 * Whether the user has ever answered the telemetry prompt. Absence of the key
 * means "never asked", which is what drives the first-launch step — and which
 * still sends nothing, since `isTelemetryEnabled()` reads false.
 */
export function hasTelemetryChoice(): boolean {
  return localStorage.getItem(TELEMETRY_STORAGE_KEY) !== null;
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
  mirrorSetting(TELEMETRY_STORAGE_KEY, isTelemetryEnabled());
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
