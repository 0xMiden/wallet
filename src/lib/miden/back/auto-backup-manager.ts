/**
 * Auto-backup manager — triggers cloud backup after state changes.
 *
 * Encryption key material is persisted in vault storage (encrypted with the
 * vault key). On each backup the key is read from the vault, used, and
 * discarded. No secret key material is held in module-level variables.
 *
 * Supports both password (PBKDF2) and passkey (WebAuthn PRF) encryption.
 */

import { createCloudBackupWithKey } from 'lib/miden/backup/backup-service';
import { refreshExtensionAccessToken } from 'lib/miden/backup/google-drive-auth';
import { GoogleDriveProvider } from 'lib/miden/backup/google-drive-provider';
import { deriveKeyBytes, generateSalt, importVaultKey } from 'lib/miden/passworder';
import { runWhenClientIdle } from 'lib/miden/sdk/miden-client';
import { BackupEncryptionMethod } from 'lib/passkey/types';
import { isExtension } from 'lib/platform';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import { AutoBackupEncryption, AutoBackupSettings, AutoBackupStatus } from 'lib/shared/types';

import * as Actions from './actions';
import { store, withUnlocked } from './store';

// ---- Module-level transient state (no secrets) ----

let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt = 0;
let needsGoogleReauth = false;
let isDirty = false;
let isBackingUp = false;
let isPaused = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let retryCount = 0;
let settingsUpdateInProgress = false;

const DEBOUNCE_MS = 10_000;
const PERIODIC_MS = 10 * 60_000; // 10 minutes
const MAX_RETRY_MS = 5 * 60_000;

// ---- Public API ----

export async function enableAutoBackup(
  encryption: AutoBackupEncryption,
  accessToken: string,
  expiresAt: number
): Promise<void> {
  let rawKeyBytes: Uint8Array;
  let settings: AutoBackupSettings;

  if (encryption.method === 'password') {
    const salt = generateSalt();
    rawKeyBytes = await deriveKeyBytes(encryption.backupPassword, salt);
    settings = {
      enabled: true,
      method: 'password',
      salt: u8ToB64(salt)
    };
  } else {
    rawKeyBytes = b64ToU8(encryption.keyMaterial);
    settings = {
      enabled: true,
      method: 'passkey',
      salt: encryption.prfSalt,
      credentialId: encryption.credentialId
    };
  }

  await withUnlocked(async ({ vault }) => {
    await vault.saveAutoBackupKey(rawKeyBytes);
  });
  rawKeyBytes.fill(0);

  cachedAccessToken = accessToken;
  cachedTokenExpiresAt = expiresAt;
  needsGoogleReauth = false;
  isPaused = false;
  lastError = null;
  retryCount = 0;

  settingsUpdateInProgress = true;
  try {
    await Actions.updateSettings({ autoBackup: settings });
  } finally {
    settingsUpdateInProgress = false;
  }

  isDirty = true;
  await backupIfDirty();
}

export async function disableAutoBackup(): Promise<void> {
  clearDebounceTimer();
  clearPeriodicTimer();

  await withUnlocked(async ({ vault }) => {
    await vault.clearAutoBackupKey();
  });

  cachedAccessToken = null;
  cachedTokenExpiresAt = 0;
  needsGoogleReauth = false;
  isDirty = false;
  isBackingUp = false;
  isPaused = false;
  lastError = null;
  retryCount = 0;

  settingsUpdateInProgress = true;
  try {
    await Actions.updateSettings({ autoBackup: undefined });
  } finally {
    settingsUpdateInProgress = false;
  }
}

export function markDirty(): void {
  if (isPaused || isBackingUp) return;

  const autoBackup = store.getState().settings?.autoBackup;
  if (!autoBackup?.enabled) return;

  isDirty = true;
  resetDebounceTimer();
}

export function onWalletLocked(): void {
  isPaused = true;
  clearDebounceTimer();
  clearPeriodicTimer();
}

export function onWalletUnlocked(): void {
  isPaused = false;
  startPeriodicTimer();
  if (isDirty) {
    resetDebounceTimer();
  }
}

export function isInternalSettingsUpdate(): boolean {
  return settingsUpdateInProgress;
}

export function getStatus(): AutoBackupStatus {
  const autoBackup = store.getState().settings?.autoBackup;

  return {
    enabled: autoBackup?.enabled ?? false,
    lastBackupAt: autoBackup?.lastBackupAt ?? null,
    lastError,
    method: autoBackup?.method ?? null,
    needsGoogleReauth
  };
}

// ---- Internal ----

function startPeriodicTimer(): void {
  clearPeriodicTimer();
  periodicTimer = setInterval(() => {
    markDirty();
  }, PERIODIC_MS);
}

function clearPeriodicTimer(): void {
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

function clearDebounceTimer(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function resetDebounceTimer(): void {
  clearDebounceTimer();
  debounceTimer = setTimeout(() => {
    backupIfDirty().catch(err => console.warn('[AutoBackup] Backup error:', err));
  }, DEBOUNCE_MS);
}

async function refreshTokenIfNeeded(): Promise<boolean> {
  if (cachedAccessToken && Date.now() < cachedTokenExpiresAt) return true;

  if (isExtension()) {
    const refreshed = await refreshExtensionAccessToken();
    if (refreshed) {
      cachedAccessToken = refreshed.accessToken;
      cachedTokenExpiresAt = refreshed.expiresAt;
      needsGoogleReauth = false;
      return true;
    }
  } else {
    try {
      const { getGoogleAuthToken } = await import('lib/miden/backup/google-drive-auth');
      const result = await getGoogleAuthToken();
      cachedAccessToken = result.accessToken;
      cachedTokenExpiresAt = result.expiresAt;
      needsGoogleReauth = false;
      return true;
    } catch {
      // fall through
    }
  }

  needsGoogleReauth = true;
  return false;
}

async function backupIfDirty(): Promise<void> {
  if (!isDirty || isBackingUp || isPaused) return;

  const autoBackup = store.getState().settings?.autoBackup;
  if (!autoBackup?.enabled) {
    isDirty = false;
    return;
  }

  isBackingUp = true;

  try {
    const tokenOk = await refreshTokenIfNeeded();
    if (!tokenOk) {
      lastError = 'Google authentication expired. Please re-authenticate.';
      scheduleRetry();
      return;
    }

    const keyBytes = await withUnlocked(async ({ vault }) => vault.getAutoBackupKey());
    if (!keyBytes) {
      lastError = 'Auto-backup key not found in vault';
      isDirty = false;
      return;
    }

    const encryptionKey = await importVaultKey(keyBytes);
    keyBytes.fill(0);

    const method = autoBackup.method === 'password' ? BackupEncryptionMethod.Password : BackupEncryptionMethod.Passkey;
    const salt = autoBackup.salt ? b64ToU8(autoBackup.salt) : new Uint8Array(32);
    const credentialId = autoBackup.credentialId ? b64ToU8(autoBackup.credentialId) : new Uint8Array(0);
    const provider = new GoogleDriveProvider(cachedAccessToken!);

    await new Promise<void>((resolve, reject) => {
      runWhenClientIdle(async () => {
        try {
          await createCloudBackupWithKey(encryptionKey, method, salt, credentialId, provider);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    isDirty = false;
    lastError = null;
    retryCount = 0;

    settingsUpdateInProgress = true;
    try {
      await Actions.updateSettings({
        autoBackup: { ...autoBackup, lastBackupAt: new Date().toISOString() }
      });
    } finally {
      settingsUpdateInProgress = false;
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn('[AutoBackup] Backup failed:', lastError);
    scheduleRetry();
  } finally {
    isBackingUp = false;
  }
}

function scheduleRetry(): void {
  retryCount++;
  const delay = Math.min(DEBOUNCE_MS * Math.pow(2, retryCount - 1), MAX_RETRY_MS);
  clearDebounceTimer();
  debounceTimer = setTimeout(() => {
    backupIfDirty().catch(err => console.warn('[AutoBackup] Retry error:', err));
  }, delay);
}
