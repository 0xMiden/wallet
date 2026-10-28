import { RENAMED_GUARDIAN_ENDPOINTS } from 'lib/miden-chain/networks-config';
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

function readSetting(key: string, defaultValue: boolean): boolean | null {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    const value: unknown = JSON.parse(stored);
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

function getSetting(key: string, defaultValue: boolean) {
  return readSetting(key, defaultValue) ?? defaultValue;
}

function getOperationalSetting(key: string, defaultValue: boolean) {
  return readSetting(key, defaultValue) ?? false;
}

let backgroundMirrorAttempt = 0;
const settingWriteTails = new Map<string, Promise<void>>();

// One tail per key. An idle write runs before enqueue returns. A busy key runs the
// next write after the previous one settles, fulfilled or rejected. The stored tail
// always fulfills and drops itself if it is still the tail, so a rejection does not
// stick. A synchronous throw from an idle write leaves no tail.
function trackSettingWrite(key: string, pending: Promise<void>): void {
  const tail = pending.then(
    () => {},
    () => {}
  );
  settingWriteTails.set(key, tail);
  void tail.then(() => {
    if (settingWriteTails.get(key) === tail) settingWriteTails.delete(key);
  });
}

function enqueueSettingWrite(key: string, write: () => Promise<void>): Promise<void> {
  const current = settingWriteTails.get(key);
  if (current === undefined) {
    try {
      const pending = write();
      trackSettingWrite(key, pending);
      return pending;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const pending = current.then(
    () => write(),
    () => write()
  );
  trackSettingWrite(key, pending);
  return pending;
}

/**
 * Write a boolean setting to the platform KV store so the extension service worker
 * (which has no `localStorage`) can read it via `readMirroredSetting`. Guarded:
 * `getStorageProvider()` can throw before platform detection is ready.
 */
function mirrorSetting(key: string, value: boolean): Promise<void> {
  try {
    return enqueueSettingWrite(key, () => getStorageProvider().set({ [key]: value })).catch(() => {});
  } catch {
    /* storage not ready — the startup mirror / defaults cover it */
    return Promise.resolve();
  }
}

/** Service-worker-safe read of a mirrored boolean. A missing key returns `defaultValue`. */
async function readMirroredSetting(
  key: string,
  defaultValue: boolean,
  invalidValue: boolean = defaultValue
): Promise<boolean> {
  try {
    const items = await getStorageProvider().get([key]);
    // Not Object.hasOwn: Safari before 15.4 lacks it and the build ships no polyfill.
    if (!Object.prototype.hasOwnProperty.call(items, key)) return defaultValue;
    const value = items[key];
    return typeof value === 'boolean' ? value : invalidValue;
  } catch {
    return invalidValue;
  }
}

export function setDelegateProofSetting(enabled: boolean) {
  setSetting(DELEGATE_PROOF_STORAGE_KEY, enabled);
  mirrorSetting(DELEGATE_PROOF_STORAGE_KEY, enabled);
}

export function isDelegateProofEnabled() {
  return getOperationalSetting(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF);
}

/**
 * Service-worker-safe read of the delegated-proving toggle (the SW cannot read
 * `localStorage`). Background native-note auto-consume proves via this so it honors
 * the user's delegated/local choice, exactly like every in-page proving path.
 */
export function isDelegateProofEnabledAsync(): Promise<boolean> {
  return readMirroredSetting(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF, false);
}

export function setAutoConsumeSetting(enabled: boolean) {
  setSetting(AUTO_CONSUME_STORAGE_KEY, enabled);
  mirrorSetting(AUTO_CONSUME_STORAGE_KEY, enabled);
}

export function isAutoConsumeEnabled() {
  return getOperationalSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
}

/**
 * Service-worker-safe read of the auto-consume toggle (the SW cannot read
 * `localStorage`). Defaults to ON when the mirror is absent (matches
 * `DEFAULT_AUTO_CONSUME`) so existing users who never toggled it are not silently
 * opted out of background auto-consume.
 */
export function isAutoConsumeEnabledAsync(): Promise<boolean> {
  return readMirroredSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME, false);
}

/**
 * Awaitable, unlike its siblings, because for telemetry the TIMING of the
 * mirror is part of the guarantee.
 *
 * The background reads consent from the mirror, so until that write lands the
 * gate still answers with the old value. For auto-consume or delegated proving
 * that window is harmless. Here it means a user can switch telemetry off and
 * have an event about their session sent afterwards — which is precisely what
 * "off stops the sharing already under way" promises not to happen. Callers that
 * turn it OFF must await this before anything that could produce an event; the
 * telemetry egress e2e caught exactly that ordering (a flow cancelled by the
 * navigation right after the toggle still reported itself).
 *
 * Not a complete ordering guarantee, and cannot be: an event already dispatched
 * to the background is past the gate. It closes the window that is ours to
 * close, which is everything the UI does after the switch is flipped.
 */
export function setTelemetrySetting(enabled: boolean): Promise<void> {
  setSetting(TELEMETRY_STORAGE_KEY, enabled);
  return mirrorSetting(TELEMETRY_STORAGE_KEY, enabled);
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
 * → Permissions and data. Its answer applies to both usage data and crash
 * reports, independently of the wallet's "Share usage data" setting.
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
 *   honour, so this gate abstains.
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
 * consult, so this abstains rather than failing closed. Usage data separately
 * requires the wallet's own setting to be on.
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
 * Service-worker-safe read of the usage-data consent toggle. The background
 * sink uses this authoritative read to require both the wallet's setting and
 * the browser-level permission before sending usage data.
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
 * Crash reports are independent of the usage-data choice, but Firefox's optional
 * data-collection permission still applies, so only the browser's answer gates them.
 */
export function isCrashReportingEnabledAsync(): Promise<boolean> {
  return isDataCollectionPermitted();
}

/**
 * Whether the user has ever answered the telemetry prompt. Absence of the key
 * means "never asked", which is what drives the first-launch step — and which
 * still sends no usage data, since `isTelemetryEnabled()` reads false.
 */
export function hasTelemetryChoice(): boolean {
  try {
    return localStorage.getItem(TELEMETRY_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function enqueueMirroredChoice(key: string, defaultValue: boolean): Promise<void> {
  return enqueueSettingWrite(key, () => {
    const value = readSetting(key, defaultValue);
    if (value === null) throw new Error('unreadable setting');
    return getStorageProvider().set({ [key]: value });
  });
}

function enqueueMirrorMarker(attempt: number, mirrored: boolean): Promise<void> {
  if (attempt !== backgroundMirrorAttempt) return Promise.resolve();
  return enqueueSettingWrite(BG_SETTINGS_MIRRORED_KEY, () => {
    if (attempt !== backgroundMirrorAttempt) return Promise.resolve();
    return getStorageProvider().set({ [BG_SETTINGS_MIRRORED_KEY]: mirrored });
  });
}

async function copyBackgroundSettings(attempt: number): Promise<void> {
  try {
    await enqueueMirrorMarker(attempt, false);
    await enqueueMirroredChoice(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
    await enqueueMirroredChoice(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF);
    await enqueueMirroredChoice(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);
    await enqueueMirrorMarker(attempt, true);
  } catch {
    /* a refused clear or copy does not publish the marker */
  }
}

/**
 * Copy auto-consume, delegated proving, and telemetry from `localStorage` into the
 * platform KV mirror the service worker reads. An unreadable local store leaves an
 * established mirror unchanged. Otherwise the copy clears the marker, then writes
 * each choice from the local value at that write. Only the newest copy clears or
 * publishes the marker. Call from a frontend context (the popup) where `localStorage`
 * is available.
 */
export function mirrorBackgroundSettings(): void {
  const autoConsume = readSetting(AUTO_CONSUME_STORAGE_KEY, DEFAULT_AUTO_CONSUME);
  const delegateProof = readSetting(DELEGATE_PROOF_STORAGE_KEY, DEFAULT_DELEGATE_PROOF);
  const telemetry = readSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);
  if (autoConsume === null || delegateProof === null || telemetry === null) return;

  // The entry reads only decide whether to start. Each write reads again in its own turn.
  const attempt = ++backgroundMirrorAttempt;
  void copyBackgroundSettings(attempt);
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
 * Normalize a Guardian endpoint for storage: trim surrounding whitespace and
 * strip any trailing slashes. This is the form persisted and sent, not a
 * comparison: `sanitizeGuardianUrl(a) === sanitizeGuardianUrl(b)` still misses
 * two spellings of the same endpoint that differ in host case or an explicit
 * default port, and it does not tell a different path spelled with a different
 * case (a different endpoint) from one that only looks different. Compare
 * endpoints with `sameGuardianEndpoint`.
 */
export function sanitizeGuardianUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Are these two spellings the same Guardian endpoint? A stored endpoint may have been typed by a user or written by an
 * older build, and a built-in operator's is a literal in wallet config, so they can differ in host case, an explicit
 * default port or a trailing slash. `URL` lowercases only the scheme and host, the parts that are case-insensitive: a
 * blanket lowercase would also fold the path, and a look-alike endpoint differing from a built-in only in path case
 * would pass as that built-in. An unparseable value can't be a working endpoint; it compares as its trimmed,
 * lowercased text, so it still matches an identical spelling of itself.
 */
export function sameGuardianEndpoint(a: string, b: string): boolean {
  return canonicalGuardianEndpoint(a) === canonicalGuardianEndpoint(b);
}

/**
 * The one spelling of a Guardian endpoint that `sameGuardianEndpoint` compares, for keying state by endpoint. A
 * renamed built-in host (`RENAMED_GUARDIAN_ENDPOINTS`) canonicalizes to its current name, so both names are one
 * endpoint.
 */
export function canonicalGuardianEndpoint(raw: string): string {
  const spelling = canonicalSpelling(raw);
  const renamed = renamedEndpointsByCanonicalSpelling().get(spelling);
  return renamed ?? spelling;
}

let renamedByCanonicalSpelling: Map<string, string> | undefined;

function renamedEndpointsByCanonicalSpelling(): Map<string, string> {
  if (!renamedByCanonicalSpelling) {
    renamedByCanonicalSpelling = new Map(
      [...RENAMED_GUARDIAN_ENDPOINTS].map(([oldName, newName]) => [
        canonicalSpelling(oldName),
        canonicalSpelling(newName)
      ])
    );
  }
  return renamedByCanonicalSpelling;
}

function canonicalSpelling(raw: string): string {
  const trimmed = sanitizeGuardianUrl(raw);
  try {
    const url = new URL(trimmed);
    // `href`, not a template of the parts: `GuardianHttpClient` sends every request
    // to `${baseUrl}${path}`, so a query or fragment (even a bare `?` or `#`, which
    // `search` and `hash` report as '') moves the appended path out of the path,
    // and any userinfo makes `fetch` throw. A spelling carrying one is not the
    // working endpoint, and `href` keeps each of them distinct.
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return trimmed.toLowerCase();
  }
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
