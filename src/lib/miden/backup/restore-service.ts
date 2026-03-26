import { decrypt, decryptBytes, deriveKey, generateKey } from 'lib/miden/passworder';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

import { CloudBackupContent, CloudProvider, deserializeEncryptedBackup } from './types';

/**
 * Download and decrypt a cloud backup, returning the parsed content.
 *
 * The caller is responsible for importing the data into the SDK store,
 * Dexie DB, and Vault (similar to the existing ImportWalletFile flow).
 *
 * @throws If no backup exists, the password is wrong, or the format version is unsupported.
 */
export async function restoreFromCloudBackup(
  backupPassword: string,
  provider: CloudProvider
): Promise<CloudBackupContent> {
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

  return content;
}
