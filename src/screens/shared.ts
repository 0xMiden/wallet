import { EncryptedPayload } from 'lib/miden/passworder';

export type { DecryptedWalletFile } from 'lib/miden/backup-file';

export type EncryptedWalletFile = {
  dt: string;
  iv: string;
  salt: Uint8Array;
  encryptedPasswordCheck: EncryptedPayload;
};

// Use a constant string to quickly check that the enc/dec works i.e. the password is correct
// without needing to check the whole file
export const ENCRYPTED_WALLET_FILE_PASSWORD_CHECK = 'MidenIsAwesome';
