import { decrypt, decryptBytes, deriveKey, generateKey } from 'lib/miden/passworder';
import { importDb } from 'lib/miden/repo';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

import { CloudBackupContent, CloudProvider, deserializeEncryptedBackup } from './types';

/**
 * Download backup from provider, decrypt, and import into the wallet.
 * Runs entirely on the backend.
 *
 * @throws If no backup exists, the password is wrong, or import fails.
 */
export async function restoreCloudBackup(backupPassword: string, provider: CloudProvider): Promise<CloudBackupContent> {
  // 1. Download
  const raw = await provider.read();
  if (!raw) {
    throw new Error('No backup found');
  }

  const { salt, passwordCheck, payload } = deserializeEncryptedBackup(raw);

  // 2. Derive key
  const passKey = await generateKey(backupPassword);
  const derivedKey = await deriveKey(passKey, salt);

  // 3. Validate password (fast fail)
  try {
    const checkBytes = await decryptBytes(passwordCheck, derivedKey);
    const checkPayload = JSON.parse(new TextDecoder().decode(checkBytes));
    const checkValue = await decrypt(checkPayload, derivedKey);
    if (checkValue !== ENCRYPTED_WALLET_FILE_PASSWORD_CHECK) {
      throw new Error('Wrong password');
    }
  } catch {
    throw new Error('Wrong password');
  }

  // 4. Decrypt payload
  const contentBytes = await decryptBytes(payload, derivedKey);
  const content: CloudBackupContent = JSON.parse(new TextDecoder().decode(contentBytes));

  // 5. Import SDK store
  await withWasmClientLock(async () => {
    const client = await getMidenClient();
    const snapshot = JSON.parse(content.sdkStoreSnapshot);
    console.log('[Restore] Importing SDK store snapshot:', snapshot);
    await client.importDb(snapshot);
  });

  // 6. Import transaction DB
  await importDb(content.transactionDbDump);

  return content;
}
