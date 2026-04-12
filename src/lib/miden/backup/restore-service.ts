import { BackupEncryptionMethod } from 'lib/passkey/types';
import { decrypt, decryptBytes, deriveKey, generateKey, importVaultKey } from 'lib/miden/passworder';
import { importDb } from 'lib/miden/repo';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { CloudBackupProbeResult } from 'lib/shared/types';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

import { CloudBackupContent, CloudProvider, deserializeEncryptedBackup } from './types';

export interface PasswordRestoreArgs {
  type: 'password';
  backupPassword: string;
}

export interface PasskeyRestoreArgs {
  type: 'passkey';
  /** 32-byte AES key derived from WebAuthn PRF on the frontend */
  keyMaterial: Uint8Array;
}

export type RestoreEncryptionArgs = PasswordRestoreArgs | PasskeyRestoreArgs;

/**
 * Download backup header to determine encryption method without decrypting.
 * Returns null encryptionMethod if no backup exists.
 */
export async function probeCloudBackup(provider: CloudProvider): Promise<CloudBackupProbeResult> {
  const raw = await provider.read();
  if (!raw) {
    return { encryptionMethod: null };
  }

  const { method, credentialId, salt } = deserializeEncryptedBackup(raw);

  if (method === BackupEncryptionMethod.Passkey) {
    return {
      encryptionMethod: 'passkey',
      credentialId: btoa(String.fromCharCode(...credentialId)),
      prfSalt: btoa(String.fromCharCode(...salt))
    };
  }

  return { encryptionMethod: 'password' };
}

/**
 * Download backup from provider, decrypt, and import into the wallet.
 * Runs entirely on the backend.
 *
 * @throws If no backup exists, the key is wrong, or import fails.
 */
export async function restoreCloudBackup(
  args: RestoreEncryptionArgs,
  provider: CloudProvider
): Promise<CloudBackupContent> {
  // 1. Download
  const raw = await provider.read();
  if (!raw) {
    throw new Error('No backup found');
  }

  const { salt, passwordCheck, payload } = deserializeEncryptedBackup(raw);

  // 2. Derive or import key
  let decryptionKey: CryptoKey;
  if (args.type === 'password') {
    const passKey = await generateKey(args.backupPassword);
    decryptionKey = await deriveKey(passKey, salt);
  } else {
    decryptionKey = await importVaultKey(args.keyMaterial);
  }

  // 3. Validate key (fast fail)
  try {
    const checkBytes = await decryptBytes(passwordCheck, decryptionKey);
    const checkPayload = JSON.parse(new TextDecoder().decode(checkBytes));
    const checkValue = await decrypt(checkPayload, decryptionKey);
    if (checkValue !== ENCRYPTED_WALLET_FILE_PASSWORD_CHECK) {
      throw new Error('Wrong key');
    }
  } catch {
    throw new Error(args.type === 'password' ? 'Wrong password' : 'Wrong passkey or corrupted backup');
  }

  // 4. Decrypt payload
  const contentBytes = await decryptBytes(payload, decryptionKey);
  const content: CloudBackupContent = JSON.parse(new TextDecoder().decode(contentBytes));

  // 5. Import SDK store
  await withWasmClientLock(async () => {
    const client = await getMidenClient();
    const snapshot = JSON.parse(content.sdkStoreSnapshot);
    await client.importDb(snapshot);
  });

  // 6. Import transaction DB
  await importDb(content.transactionDbDump);

  return content;
}

/**
 * Restore from a cloud backup using a pre-derived CryptoKey.
 * Used by the sync canonicalization flow (auto-backup key is already in vault).
 *
 * @throws If no backup exists, the key is wrong, or import fails.
 */
export async function restoreCloudBackupWithKey(
  encryptionKey: CryptoKey,
  provider: CloudProvider
): Promise<CloudBackupContent> {
  const raw = await provider.read();
  if (!raw) {
    throw new Error('No backup found');
  }

  const { passwordCheck, payload } = deserializeEncryptedBackup(raw);

  try {
    const checkBytes = await decryptBytes(passwordCheck, encryptionKey);
    const checkPayload = JSON.parse(new TextDecoder().decode(checkBytes));
    const checkValue = await decrypt(checkPayload, encryptionKey);
    if (checkValue !== ENCRYPTED_WALLET_FILE_PASSWORD_CHECK) {
      throw new Error('Wrong key');
    }
  } catch {
    throw new Error('Backup decryption failed — key mismatch or corrupted backup');
  }

  const contentBytes = await decryptBytes(payload, encryptionKey);
  const content: CloudBackupContent = JSON.parse(new TextDecoder().decode(contentBytes));

  await withWasmClientLock(async () => {
    const client = await getMidenClient();
    const snapshot = JSON.parse(content.sdkStoreSnapshot);
    await client.importDb(snapshot);
  });

  await importDb(content.transactionDbDump);

  return content;
}
