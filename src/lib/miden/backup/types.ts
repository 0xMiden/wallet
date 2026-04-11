import { BackupEncryptionMethod } from 'lib/passkey/types';
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
// Layout:
//   [method:       1 byte ]  — 0x01 = password, 0x02 = passkey
//   [credIdLen:    2 bytes]  — uint16 big-endian (0 for password)
//   [credId:       N bytes]  — WebAuthn credential ID (empty for password)
//   [salt:        32 bytes]  — PBKDF2 salt (password) or HKDF salt (passkey)
//   [checkLen:     4 bytes]  — uint32 big-endian
//   [check:        N bytes]  — encrypted verification token (iv 16 + ciphertext)
//   [payload:      rest    ] — encrypted backup payload (iv 16 + ciphertext)

export interface EncryptedCloudBackup {
  /** How the encryption key was derived */
  method: BackupEncryptionMethod;
  /** WebAuthn credential ID (empty for password-based backups) */
  credentialId: Uint8Array<ArrayBuffer>;
  /** PBKDF2 salt (password) or HKDF salt (passkey) — always 32 bytes */
  salt: Uint8Array<ArrayBuffer>;
  /** Encrypted verification token (iv + ciphertext) */
  passwordCheck: Uint8Array<ArrayBuffer>;
  /** Encrypted backup payload (iv + ciphertext) */
  payload: Uint8Array<ArrayBuffer>;
}

/** Serialize an EncryptedCloudBackup to a single Uint8Array for storage */
export function serializeEncryptedBackup(backup: EncryptedCloudBackup): Uint8Array {
  const credIdLen = backup.credentialId.byteLength;
  const checkLen = backup.passwordCheck.byteLength;
  const totalLen = 1 + 2 + credIdLen + 32 + 4 + checkLen + backup.payload.byteLength;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  let offset = 0;

  // method
  out[offset] = backup.method;
  offset += 1;

  // credentialId length + data
  view.setUint16(offset, credIdLen, false);
  offset += 2;
  if (credIdLen > 0) {
    out.set(backup.credentialId, offset);
    offset += credIdLen;
  }

  // salt
  out.set(backup.salt, offset);
  offset += 32;

  // passwordCheck length + data
  view.setUint32(offset, checkLen, false);
  offset += 4;
  out.set(backup.passwordCheck, offset);
  offset += checkLen;

  // payload
  out.set(backup.payload, offset);

  return out;
}

/** Deserialize a Uint8Array back into an EncryptedCloudBackup */
export function deserializeEncryptedBackup(data: Uint8Array): EncryptedCloudBackup {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // method
  const method = data[offset] as BackupEncryptionMethod;
  offset += 1;

  // credentialId
  const credIdLen = view.getUint16(offset, false);
  offset += 2;
  const credentialId = new Uint8Array(data.subarray(offset, offset + credIdLen));
  offset += credIdLen;

  // salt
  const salt = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  // passwordCheck
  const checkLen = view.getUint32(offset, false);
  offset += 4;
  const passwordCheck = new Uint8Array(data.subarray(offset, offset + checkLen));
  offset += checkLen;

  // payload
  const payload = new Uint8Array(data.subarray(offset));

  return { method, credentialId, salt, passwordCheck, payload };
}

// ---- Cloud Provider Interface ----

export interface CloudAuthState {
  isAuthenticated: boolean;
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
