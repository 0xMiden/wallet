import { withUnlocked } from 'lib/miden/back/store';
import { deriveKey, encrypt, encryptBytes, generateKey, generateSalt, importVaultKey } from 'lib/miden/passworder';
import { exportDb } from 'lib/miden/repo';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { BackupEncryptionMethod } from 'lib/passkey/types';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

import { CloudBackupContent, CloudProvider, EncryptedCloudBackup, serializeEncryptedBackup } from './types';

export interface PasswordBackupArgs {
  type: 'password';
  backupPassword: string;
}

export interface PasskeyBackupArgs {
  type: 'passkey';
  /** 32-byte AES key derived from WebAuthn PRF on the frontend */
  keyMaterial: Uint8Array;
  /** WebAuthn credential ID (stored in backup header for restore) */
  credentialId: Uint8Array;
  /** HKDF salt used during PRF derivation */
  prfSalt: Uint8Array;
}

export type BackupEncryptionArgs = PasswordBackupArgs | PasskeyBackupArgs;

/**
 * Collect wallet data, encrypt, and upload via the given provider.
 * Runs entirely on the backend.
 */
export async function createCloudBackup(args: BackupEncryptionArgs, provider: CloudProvider): Promise<void> {
  // 1. Collect data
  const content = await collectBackupContent();

  // 2. Derive encryption key based on method
  let encryptionKey: CryptoKey;
  let method: BackupEncryptionMethod;
  let salt: Uint8Array;
  let credentialId: Uint8Array;

  if (args.type === 'password') {
    salt = generateSalt();
    const passKey = await generateKey(args.backupPassword);
    encryptionKey = await deriveKey(passKey, salt);
    method = BackupEncryptionMethod.Password;
    credentialId = new Uint8Array(0);
  } else {
    salt = args.prfSalt;
    encryptionKey = await importVaultKey(args.keyMaterial);
    method = BackupEncryptionMethod.Passkey;
    credentialId = args.credentialId;
  }

  // 3. Encrypt and upload
  const backup = await encryptBackup(content, encryptionKey, method, salt, credentialId);
  await provider.write(serializeEncryptedBackup(backup));
}

async function collectBackupContent(): Promise<CloudBackupContent> {
  const sdkStoreSnapshot = await withWasmClientLock(async () => {
    const client = await getMidenClient();
    return client.exportDb();
  });
  console.log('Exported SDK store snapshot:', sdkStoreSnapshot);
  const [walletAccounts, walletSettings] = await withUnlocked(async ({ vault }) => {
    return Promise.all([vault.fetchAccounts(), vault.fetchSettings()]);
  });

  const transactionDbDump = await exportDb();

  return {
    createdAt: new Date().toISOString(),
    sdkStoreSnapshot: JSON.stringify(sdkStoreSnapshot),
    walletAccounts,
    walletSettings,
    transactionDbDump
  };
}

async function encryptBackup(
  content: CloudBackupContent,
  encryptionKey: CryptoKey,
  method: BackupEncryptionMethod,
  salt: Uint8Array,
  credentialId: Uint8Array
): Promise<EncryptedCloudBackup> {
  const contentBytes = new TextEncoder().encode(JSON.stringify(content));

  const passwordCheck = await encrypt(ENCRYPTED_WALLET_FILE_PASSWORD_CHECK, encryptionKey);
  const passwordCheckBytes = new TextEncoder().encode(JSON.stringify(passwordCheck));
  const encryptedPasswordCheck = await encryptBytes(passwordCheckBytes, encryptionKey);
  const encryptedPayload = await encryptBytes(contentBytes, encryptionKey);

  return {
    method,
    credentialId: credentialId as Uint8Array<ArrayBuffer>,
    salt: salt as Uint8Array<ArrayBuffer>,
    passwordCheck: encryptedPasswordCheck,
    payload: encryptedPayload
  };
}
