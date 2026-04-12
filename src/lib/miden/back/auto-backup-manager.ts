/**
 * Auto-backup manager — triggers cloud backup after explicit events
 * (transaction completion, account creation, settings change).
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
let isBackingUp = false;
let isPaused = false;
let lastError: string | null = null;
let settingsUpdateInProgress = false;

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

  settingsUpdateInProgress = true;
  try {
    await Actions.updateSettings({ autoBackup: settings });
  } finally {
    settingsUpdateInProgress = false;
  }

  // Run an initial backup immediately
  await doBackup();
}

export async function disableAutoBackup(): Promise<void> {
  await withUnlocked(async ({ vault }) => {
    await vault.clearAutoBackupKey();
  });

  cachedAccessToken = null;
  cachedTokenExpiresAt = 0;
  needsGoogleReauth = false;
  isBackingUp = false;
  isPaused = false;
  lastError = null;

  settingsUpdateInProgress = true;
  try {
    await Actions.updateSettings({ autoBackup: undefined });
  } finally {
    settingsUpdateInProgress = false;
  }
}

/**
 * Trigger a backup. Call this after transaction completion, account creation,
 * or settings changes. Safe to call frequently — concurrent calls are ignored.
 */
export async function triggerBackup(): Promise<void> {
  if (isPaused || isBackingUp) return;

  const autoBackup = store.getState().settings?.autoBackup;
  if (!autoBackup?.enabled) return;

  await doBackup();
}

export function onWalletLocked(): void {
  isPaused = true;
}

export function onWalletUnlocked(): void {
  isPaused = false;
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

/**
 * Returns the access token and encryption key needed for backup restore
 * during sync canonicalization. Returns null if auto-backup is not enabled
 * or credentials are unavailable.
 */
export async function getBackupCredentials(): Promise<{
  accessToken: string;
  encryptionKey: CryptoKey;
} | null> {
  const autoBackup = store.getState().settings?.autoBackup;
  if (!autoBackup?.enabled) return null;

  const tokenOk = await refreshTokenIfNeeded();
  if (!tokenOk || !cachedAccessToken) return null;

  try {
    const keyBytes = await withUnlocked(async ({ vault }) => vault.getAutoBackupKey());
    if (!keyBytes) return null;
    const encryptionKey = await importVaultKey(keyBytes);
    keyBytes.fill(0);
    return { accessToken: cachedAccessToken, encryptionKey };
  } catch {
    return null;
  }
}

// ---- Internal ----

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

async function doBackup(): Promise<void> {
  if (isBackingUp || isPaused) return;

  const autoBackup = store.getState().settings?.autoBackup;
  if (!autoBackup?.enabled) return;

  isBackingUp = true;

  try {
    const tokenOk = await refreshTokenIfNeeded();
    if (!tokenOk) {
      lastError = 'Google authentication expired. Please re-authenticate.';
      return;
    }

    const keyBytes = await withUnlocked(async ({ vault }) => vault.getAutoBackupKey());
    if (!keyBytes) {
      lastError = 'Auto-backup key not found in vault';
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

    lastError = null;

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
  } finally {
    isBackingUp = false;
  }
}
