import { EncryptedPayload } from 'lib/miden/passworder';
import type { WalletAccount } from 'lib/shared/types';

export type DecryptedWalletFile = {
  seedPhrase: string;
  midenClientDbContent: string;
  walletDbContent: string;
  accounts: WalletAccount[];
  // Number of imported accounts (hdIndex < 0) the exporter stripped
  // from `accounts` because the file format doesn't carry raw private
  // keys. Surfaced on the import side so the restoring user isn't
  // silently surprised by missing accounts. Optional for backwards
  // compatibility with files produced before this field existed.
  omittedImportedAccountCount?: number;
};

export type EncryptedWalletFile = {
  dt: string;
  iv: string;
  salt: Uint8Array;
  encryptedPasswordCheck: EncryptedPayload;
};

// Use a constant string to quickly check that the enc/dec works i.e. the password is correct
// without needing to check the whole file
export const ENCRYPTED_WALLET_FILE_PASSWORD_CHECK = 'MidenIsAwesome';
