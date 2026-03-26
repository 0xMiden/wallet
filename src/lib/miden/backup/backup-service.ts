import { withUnlocked } from 'lib/miden/back/store';
import { deriveKey, encrypt, encryptBytes, generateKey, generateSalt } from 'lib/miden/passworder';
import { exportDb } from 'lib/miden/repo';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

import { CloudBackupContent, CloudProvider, EncryptedCloudBackup, serializeEncryptedBackup } from './types';

/**
 * Collect wallet data, encrypt it, and upload to the cloud provider.
 *
 * The WASM lock is held only during exportStore(). Encryption runs after
 * the lock is released to avoid blocking other SDK operations.
 */
export async function createCloudBackup(backupPassword: string, provider: CloudProvider): Promise<void> {
  // 1. Collect data
  const sdkStoreSnapshot = await withWasmClientLock(async () => {
    const client = await getMidenClient();
    return client.exportDb();
  });

  const [walletAccounts, walletSettings] = await withUnlocked(async ({ vault }) => {
    return Promise.all([vault.fetchAccounts(), vault.fetchSettings()]);
  });

  const transactionDbDump = await exportDb();

  // 2. Assemble backup content
  const content: CloudBackupContent = {
    createdAt: new Date().toISOString(),
    sdkStoreSnapshot: JSON.stringify(sdkStoreSnapshot),
    walletAccounts,
    walletSettings,
    transactionDbDump
  };

  // 3. Encrypt
  const contentBytes = new TextEncoder().encode(JSON.stringify(content));

  const salt = generateSalt();
  const passKey = await generateKey(backupPassword);
  const derivedKey = await deriveKey(passKey, salt);

  const passwordCheck = await encrypt(ENCRYPTED_WALLET_FILE_PASSWORD_CHECK, derivedKey);
  const passwordCheckBytes = new TextEncoder().encode(JSON.stringify(passwordCheck));
  const encryptedPasswordCheck = await encryptBytes(passwordCheckBytes, derivedKey);
  const encryptedPayload = await encryptBytes(contentBytes, derivedKey);

  // 4. Serialize and upload
  const backup: EncryptedCloudBackup = {
    salt,
    passwordCheck: encryptedPasswordCheck,
    payload: encryptedPayload
  };

  await provider.write(serializeEncryptedBackup(backup));
}
