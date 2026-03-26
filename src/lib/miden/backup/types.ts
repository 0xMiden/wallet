import { WalletAccount, WalletSettings } from 'lib/shared/types';

// ---- Backup Content (decrypted payload, no seed phrase) ----

export interface CloudBackupContent {
  /** ISO 8601 timestamp of backup creation */
  createdAt: string;
  /** SDK store snapshot from client.exportStore(), JSON-stringified */
  sdkStoreSnapshot: string;
  /** Wallet account metadata (names, types, HD indices) */
  walletAccounts: WalletAccount[];
  /** Wallet settings including contacts */
  walletSettings: WalletSettings;
  /** Dexie transaction DB dump as JSON string */
  transactionDbDump: string;
}

// ---- Encrypted Backup (binary wire format) ----
//
// The encrypted backup is a single Uint8Array with the layout:
//   [salt: 32 bytes]
//   [passwordCheck length: 4 bytes (uint32 big-endian)]
//   [passwordCheck: N bytes (iv 16 + ciphertext)]
//   [payload: remaining bytes (iv 16 + ciphertext)]
//
// Both passwordCheck and payload are raw AES-GCM output: first 16 bytes
// are the IV, the rest is ciphertext.

export interface EncryptedCloudBackup {
  /** PBKDF2 salt (32 bytes) */
  salt: Uint8Array<ArrayBuffer>;
  /** Encrypted password verification token (iv + ciphertext) */
  passwordCheck: Uint8Array<ArrayBuffer>;
  /** Encrypted backup payload (iv + ciphertext) */
  payload: Uint8Array<ArrayBuffer>;
}

/** Serialize an EncryptedCloudBackup to a single Uint8Array for storage */
export function serializeEncryptedBackup(backup: EncryptedCloudBackup): Uint8Array {
  const checkLen = backup.passwordCheck.byteLength;
  const totalLen = 32 + 4 + checkLen + backup.payload.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;

  out.set(backup.salt, offset);
  offset += 32;

  new DataView(out.buffer).setUint32(offset, checkLen, false);
  offset += 4;

  out.set(backup.passwordCheck, offset);
  offset += checkLen;

  out.set(backup.payload, offset);

  return out;
}

/** Deserialize a Uint8Array back into an EncryptedCloudBackup */
export function deserializeEncryptedBackup(data: Uint8Array): EncryptedCloudBackup {
  let offset = 0;

  const salt = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const checkLen = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;

  const passwordCheck = new Uint8Array(data.subarray(offset, offset + checkLen));
  offset += checkLen;

  const payload = new Uint8Array(data.subarray(offset));

  return { salt, passwordCheck, payload };
}

// ---- Cloud Provider Interface ----

export interface CloudAuthState {
  isAuthenticated: boolean;
  displayName?: string;
  email?: string;
  provider: string;
}

/**
 * Abstract cloud storage provider for wallet backups.
 *
 * There is always exactly one backup per provider — a write overwrites any
 * existing backup, and read returns that single backup. Implementations do
 * not need to support multiple backup files or versioning.
 *
 * The data passed to write/read is a raw Uint8Array (the serialized
 * EncryptedCloudBackup). Use serializeEncryptedBackup/deserializeEncryptedBackup
 * to convert between the struct and bytes.
 */
export interface CloudProvider {
  /** Provider identifier (e.g. 'google-drive', 'icloud') */
  readonly providerId: string;
  /** Display name for UI */
  readonly displayName: string;

  /** Initiate authentication (may open OAuth popup/redirect) */
  authenticate(): Promise<CloudAuthState>;
  /** Check current auth state without prompting */
  getAuthState(): Promise<CloudAuthState>;
  /** Sign out */
  signOut(): Promise<void>;

  /** Upload a backup as raw bytes, replacing any existing one */
  write(data: Uint8Array): Promise<void>;
  /** Download the backup as raw bytes. Returns null if no backup exists. */
  read(): Promise<Uint8Array | null>;
  /** Delete the backup if one exists */
  delete(): Promise<void>;
  /** Check whether a backup exists */
  exists(): Promise<boolean>;
}
