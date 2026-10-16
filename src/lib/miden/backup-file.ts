import type { ImportedAccountBackup, KeyDerivation, WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

// This module parses the plaintext produced only after authenticated
// decryption. It still treats every field as hostile because a valid envelope
// can contain a file created by another wallet version or manually supplied
// data. Structural validation belongs here so neither database importer sees
// unchecked strings.
//
// The parser deliberately does not deserialize SDK secrets or account IDs.
// Those checks require the restored Miden database and run inside the WASM
// client lock. Keeping that boundary here prevents parsing a file from mutating
// the active client or vault.
export const CURRENT_BACKUP_FORMAT_VERSION = 2 as const;

// A backend failure reaches the frontend as message text only, so the one
// failure the user can act on travels as a stable code plus the account name.
// The screen localizes it; the message itself is never rendered.
export const IMPORTED_ACCOUNT_BACKUP_FAILED_CODE = 'imported-account-backup-failed';

// The vault's own contract for a seed phrase. It lives here, in the leaf module,
// so the parser and the exporter check the same thing the reveal path does: the
// old exporter read the seed THROUGH revealMnemonic, so this pattern gated every
// file ever written, and reading the stored value directly dropped that guard.
export const MNEMONIC_PATTERN = /^(\b\w+\b\s?){12}$/;

export const importedAccountBackupFailure = (accountName: string) =>
  `${IMPORTED_ACCOUNT_BACKUP_FAILED_CODE}:${accountName}`;

export const parseImportedAccountBackupFailure = (message: string): string | null =>
  message.startsWith(`${IMPORTED_ACCOUNT_BACKUP_FAILED_CODE}:`)
    ? message.slice(IMPORTED_ACCOUNT_BACKUP_FAILED_CODE.length + 1)
    : null;

export type DecryptedWalletFile = {
  formatVersion: typeof CURRENT_BACKUP_FORMAT_VERSION;
  // The network the file was written on. Absent from older files, which are
  // placed by their genesis alone; a string, as a name this wallet does not
  // know is another network, not a damaged file.
  network?: string;
  seedPhrase: string;
  midenClientDbContent: string;
  walletDbContent: string;
  accounts: WalletAccount[];
  importedAccounts: ImportedAccountBackup[];
};

export class MalformedBackupFileError extends Error {
  constructor() {
    // Never echo untrusted fields because a malformed field can contain a key.
    super('The encrypted wallet file is malformed.');
    this.name = 'MalformedBackupFileError';
  }
}

export class UnsupportedBackupVersionError extends Error {
  constructor() {
    super('This encrypted wallet file was created by a newer wallet version.');
    this.name = 'UnsupportedBackupVersionError';
  }
}

export class WrongNetworkBackupError extends Error {
  constructor() {
    super('This encrypted wallet file belongs to another network.');
    this.name = 'WrongNetworkBackupError';
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAuthScheme = (value: unknown): value is ImportedAccountBackup['authScheme'] =>
  value === 'falcon' || value === 'ecdsa';

const isKeyDerivation = (value: unknown): value is KeyDerivation => value === 'v1';

const isWalletType = (value: unknown): value is WalletType =>
  value === WalletType.OffChain || value === WalletType.OnChain || value === WalletType.Guardian;

const isHex = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const body = value.startsWith('0x') ? value.slice(2) : value;
  // Match the private-key import cap before secret bytes reach the SDK.
  return body.length > 0 && body.length <= 32_768 && body.length % 2 === 0 && /^[0-9a-f]+$/i.test(body);
};

// Exported so the EXPORT can hold itself to the same contract the reader applies.
// The two are separate schemas over one object, and a record that fails here would
// produce a file this wallet decrypts and then refuses as invalid or damaged.
export const isWalletAccount = (value: unknown): value is WalletAccount => {
  if (!isRecord(value)) return false;
  // Optional account metadata is intentionally preserved. The required fields
  // establish the record shape, while feature-specific readers validate their
  // own optional values just as they do for records loaded from Dexie.
  return (
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.isPublic === 'boolean' &&
    isWalletType(value.type) &&
    Number.isSafeInteger(value.hdIndex) &&
    isAuthScheme(value.authScheme) &&
    (value.keyDerivation === undefined || isKeyDerivation(value.keyDerivation))
  );
};

/**
 * A Guardian account the wallet did not derive from its recovery phrase (hdIndex < 0;
 * today that is onboarding's key import, `Vault.spawnFromHotKey`). An encrypted wallet
 * file leaves its record and keys out: its SDK row still travels in the database dump
 * and the restore skips it, so the account is not restored from the file. The user
 * restores it from its everyday and EVM keys instead: no phrase derives them, and a
 * Guardian's keys never travel in a file (the account-file export refuses them too).
 * The exporter and the export screen both read this, so the file and the screen cannot
 * disagree about which accounts it restores.
 */
export const isExcludedFromWalletFile = (account: Pick<WalletAccount, 'type' | 'hdIndex'>): boolean =>
  account.type === WalletType.Guardian && account.hdIndex < 0;

const parseImportedAccount = (value: unknown): ImportedAccountBackup => {
  if (
    !isRecord(value) ||
    typeof value.accountId !== 'string' ||
    value.accountId.length === 0 ||
    !isHex(value.publicKeyCommitment) ||
    !isAuthScheme(value.authScheme) ||
    !isHex(value.secretKeyHex)
  ) {
    throw new MalformedBackupFileError();
  }
  return value as unknown as ImportedAccountBackup;
};

const requireCommonPayload = (value: Record<string, unknown>): WalletAccount[] => {
  if (
    typeof value.seedPhrase !== 'string' ||
    // A phrase that is present has to be a real one. No phrase at all is legal,
    // because local seed-phrase removal deletes the stored mnemonic and such a
    // wallet can still back up its imported secrets; the pairing rule below is
    // what keeps that case honest.
    (value.seedPhrase !== '' && !MNEMONIC_PATTERN.test(value.seedPhrase)) ||
    (value.network !== undefined && typeof value.network !== 'string') ||
    typeof value.midenClientDbContent !== 'string' ||
    typeof value.walletDbContent !== 'string' ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every(isWalletAccount) ||
    // No phrase is legal only when no account needs one: an HD account's key is
    // re-derived from the seed and is not carried in the file, so this pairing
    // describes a wallet that cannot be restored. Checked after the narrowing
    // above, which is what makes `accounts` typed here.
    (value.seedPhrase === '' && value.accounts.some(account => account.hdIndex >= 0))
  ) {
    throw new MalformedBackupFileError();
  }
  return value.accounts;
};

export const normalizeBackupHex = (value: string): string =>
  (value.startsWith('0x') ? value.slice(2) : value).toLowerCase();

export function parseDecryptedWalletFile(value: unknown): DecryptedWalletFile {
  if (!isRecord(value)) throw new MalformedBackupFileError();

  // An unversioned file predates version 2; `UnsupportedBackupVersionError` would call it newer.
  if (value.formatVersion === undefined) throw new MalformedBackupFileError();

  if (value.formatVersion !== CURRENT_BACKUP_FORMAT_VERSION) {
    // Unknown versions fail before any database import, and before the shape
    // checks: a newer format may change the records those checks judge.
    // Forward compatibility must be explicit because new versions may
    // strengthen secret bindings.
    throw new UnsupportedBackupVersionError();
  }
  requireCommonPayload(value);
  if (!Array.isArray(value.importedAccounts)) throw new MalformedBackupFileError();

  const importedAccounts = value.importedAccounts.map(parseImportedAccount);
  const accountIds = new Set<string>();
  const commitments = new Set<string>();
  const secrets = new Set<string>();
  for (const account of importedAccounts) {
    // Commitments are hex values, so prefix and case differences cannot make
    // the same signer appear unique within a backup.
    const commitment = normalizeBackupHex(account.publicKeyCommitment);
    const secret = normalizeBackupHex(account.secretKeyHex);
    if (accountIds.has(account.accountId) || commitments.has(commitment) || secrets.has(secret)) {
      throw new MalformedBackupFileError();
    }
    accountIds.add(account.accountId);
    commitments.add(commitment);
    secrets.add(secret);
  }

  return value as DecryptedWalletFile;
}

/** Refuses a file recorded on another network. One written before the network was recorded passes. */
export const assertBackupNetwork = (file: DecryptedWalletFile, effectiveNetwork: string): void => {
  if (file.network !== undefined && file.network !== effectiveNetwork) throw new WrongNetworkBackupError();
};

/**
 * The genesis block header in an SDK store dump (`exportStore` format: one list
 * of rows per table, binary fields as tagged base64), as the bytes the import
 * would write over the active store's own genesis.
 *
 * A dump without exactly one genesis row is malformed: every client build
 * writes genesis into an empty store and the SDK never prunes block 0, so no
 * backup this wallet wrote lacks one.
 */
export function backupGenesisHeader(midenClientDbContent: string): Uint8Array {
  let dump: unknown;
  try {
    dump = JSON.parse(midenClientDbContent);
    // The SDK's importer also accepts a dump encoded twice, so it is read the same way here.
    if (typeof dump === 'string') dump = JSON.parse(dump);
  } catch {
    throw new MalformedBackupFileError();
  }
  const rows: unknown[] = isRecord(dump) && Array.isArray(dump.blockHeaders) ? dump.blockHeaders : [];
  const genesisRows = rows.filter(row => isRecord(row) && row.blockNum === 0);
  const genesisRow = genesisRows.length === 1 ? genesisRows[0] : undefined;
  const header = isRecord(genesisRow) ? genesisRow.header : undefined;
  if (!isRecord(header) || header.__type !== 'Uint8Array' || typeof header.data !== 'string') {
    throw new MalformedBackupFileError();
  }
  try {
    // Decoded with `atob`, as the SDK's importer decodes it.
    return Uint8Array.from(atob(header.data), character => character.charCodeAt(0));
  } catch {
    throw new MalformedBackupFileError();
  }
}

/** Refuses a backup whose genesis header is not the active store's: its dump is of another chain. */
export const assertSameGenesis = (fileGenesis: Uint8Array, activeGenesis: Uint8Array): void => {
  if (fileGenesis.length !== activeGenesis.length || fileGenesis.some((byte, index) => byte !== activeGenesis[index])) {
    throw new WrongNetworkBackupError();
  }
};
