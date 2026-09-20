import { WalletType } from 'screens/onboarding/types';

import {
  MalformedBackupFileError,
  UnsupportedBackupVersionError,
  importedAccountBackupFailure,
  parseDecryptedWalletFile,
  parseImportedAccountBackupFailure
} from './backup-file';

const hdAccount = {
  publicKey: 'miden-account-hd',
  name: 'HD account',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: 0,
  authScheme: 'ecdsa' as const
};

const importedAccount = {
  publicKey: 'miden-account-imported',
  name: 'Imported account',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: -1,
  authScheme: 'falcon' as const
};

const legacyPayload = {
  seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  midenClientDbContent: 'miden-db',
  walletDbContent: 'wallet-db',
  accounts: [hdAccount],
  omittedImportedAccountCount: 2
};

const importedBackup = {
  accountId: importedAccount.publicKey,
  publicKeyCommitment: '0xA1B2',
  authScheme: 'falcon' as const,
  secretKeyHex: '01020304'
};

const versionTwoPayload = {
  formatVersion: 2,
  seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  midenClientDbContent: 'miden-db',
  walletDbContent: 'wallet-db',
  accounts: [hdAccount, importedAccount],
  importedAccounts: [importedBackup]
};

describe('parseDecryptedWalletFile', () => {
  it('accepts a legacy payload and preserves its imported-account omission count', () => {
    expect(parseDecryptedWalletFile(legacyPayload)).toEqual(legacyPayload);
  });

  it('accepts a version 2 payload with imported-account backup material', () => {
    expect(parseDecryptedWalletFile(versionTwoPayload)).toEqual(versionTwoPayload);
  });

  it('rejects an unsupported future format version with a dedicated error', () => {
    expect(() => parseDecryptedWalletFile({ ...versionTwoPayload, formatVersion: 3 })).toThrow(
      UnsupportedBackupVersionError
    );
  });

  it.each([
    ['missing accounts', { ...legacyPayload, accounts: undefined }],
    ['non-array accounts', { ...legacyPayload, accounts: {} }],
    ['account missing a required field', { ...legacyPayload, accounts: [{ ...hdAccount, name: undefined }] }],
    ['account with an invalid wallet type', { ...legacyPayload, accounts: [{ ...hdAccount, type: 'invalid' }] }]
  ])('rejects %s', (_label, payload) => {
    expect(() => parseDecryptedWalletFile(payload)).toThrow(MalformedBackupFileError);
  });

  it.each([
    ['wallet account', { ...importedAccount, authScheme: 'unknown' }],
    ['imported backup entry', { ...importedBackup, authScheme: 'unknown' }]
  ])('rejects an invalid auth scheme on the %s', (_label, invalid) => {
    const payload =
      _label === 'wallet account'
        ? { ...versionTwoPayload, accounts: [hdAccount, invalid] }
        : { ...versionTwoPayload, importedAccounts: [invalid] };
    expect(() => parseDecryptedWalletFile(payload)).toThrow(MalformedBackupFileError);
  });

  it.each(['abc', 'not-hex', ''])('rejects malformed imported secret hex %p', secretKeyHex => {
    expect(() =>
      parseDecryptedWalletFile({
        ...versionTwoPayload,
        importedAccounts: [{ ...importedBackup, secretKeyHex }]
      })
    ).toThrow(MalformedBackupFileError);
  });

  it('rejects duplicate imported-account identifiers', () => {
    expect(() =>
      parseDecryptedWalletFile({
        ...versionTwoPayload,
        importedAccounts: [importedBackup, { ...importedBackup, publicKeyCommitment: 'c3d4', secretKeyHex: '0506' }]
      })
    ).toThrow(MalformedBackupFileError);
  });

  it('rejects duplicate imported-account commitments after normalization', () => {
    expect(() =>
      parseDecryptedWalletFile({
        ...versionTwoPayload,
        importedAccounts: [
          importedBackup,
          {
            ...importedBackup,
            accountId: 'miden-account-other',
            publicKeyCommitment: 'a1b2',
            secretKeyHex: '0506'
          }
        ]
      })
    ).toThrow(MalformedBackupFileError);
  });

  it('rejects one imported secret bound to multiple account ids', () => {
    expect(() =>
      parseDecryptedWalletFile({
        ...versionTwoPayload,
        importedAccounts: [
          importedBackup,
          {
            ...importedBackup,
            accountId: 'miden-account-other',
            publicKeyCommitment: 'c3d4'
          }
        ]
      })
    ).toThrow(MalformedBackupFileError);
  });

  // Everything below is about a payload that is not merely wrong in one field
  // but the wrong SHAPE. The reader runs on whatever survived decryption, so a
  // truncated or hand-edited file reaches it as a primitive, an array, or an
  // object whose `accounts` entries are not objects at all. Each of these must
  // end as MalformedBackupFileError before any database import starts — a
  // TypeError out of the parser would be reported to the user as a crash rather
  // than as the file being damaged.
  it.each([
    ['a primitive', 'not-an-object'],
    ['null', null],
    ['an array', [legacyPayload]]
  ])('rejects %s in place of the payload object', (_label, payload) => {
    expect(() => parseDecryptedWalletFile(payload)).toThrow(MalformedBackupFileError);
  });

  it.each([
    ['a primitive', 'miden-account-hd'],
    ['null', null],
    ['an array', [hdAccount]]
  ])('rejects %s in place of a wallet account', (_label, account) => {
    expect(() => parseDecryptedWalletFile({ ...legacyPayload, accounts: [account] })).toThrow(MalformedBackupFileError);
  });

  // `isHex` guards the two secret-bearing fields. A non-string reaches it from a
  // file whose JSON carried a number or an object there, and it has to be
  // refused as malformed rather than coerced on the way to the SDK.
  it.each([
    ['publicKeyCommitment', { publicKeyCommitment: 42 }],
    ['secretKeyHex', { secretKeyHex: { hex: '0102' } }]
  ])('rejects a non-string %s on an imported account', (_label, override) => {
    expect(() =>
      parseDecryptedWalletFile({
        ...versionTwoPayload,
        importedAccounts: [{ ...importedBackup, ...override }]
      })
    ).toThrow(MalformedBackupFileError);
  });

  // The v2 discriminator promises the imported-secret block is present and is a
  // list. Without this the `.map` below it would throw a TypeError instead.
  it.each([
    ['missing', undefined],
    ['not a list', { 0: importedBackup }]
  ])('rejects a version 2 payload whose importedAccounts is %s', (_label, importedAccounts) => {
    expect(() => parseDecryptedWalletFile({ ...versionTwoPayload, importedAccounts })).toThrow(
      MalformedBackupFileError
    );
  });

  // The legacy form may state how many imported accounts it left out, but that
  // count is read by the restore screen, so a negative or fractional one is
  // refused rather than displayed.
  it.each([
    ['negative', -1],
    ['fractional', 1.5]
  ])('rejects a legacy payload with a %s omitted-account count', (_label, omittedImportedAccountCount) => {
    expect(() => parseDecryptedWalletFile({ ...legacyPayload, omittedImportedAccountCount })).toThrow(
      MalformedBackupFileError
    );
  });
});

// The export encodes which account blocked the backup into the error message,
// because that is the only detail that survives the intercom boundary, and the
// screen turns it back into a localized string. Both halves are asserted here:
// the class-only assertions elsewhere cannot fail if this encoding breaks.
describe('imported-account backup failure code', () => {
  it('round-trips the account name', () => {
    expect(parseImportedAccountBackupFailure(importedAccountBackupFailure('Imported account'))).toBe(
      'Imported account'
    );
  });

  it('round-trips a name containing the separator', () => {
    // Parsing slices at the first separator rather than splitting on it, so a
    // name carrying a colon survives whole.
    expect(parseImportedAccountBackupFailure(importedAccountBackupFailure('a:b:c'))).toBe('a:b:c');
  });

  it('answers null for a message that is not this failure', () => {
    expect(parseImportedAccountBackupFailure('Failed to prepare encrypted wallet backup')).toBeNull();
  });
});

describe('seed phrase contract', () => {
  const withSeed = (seedPhrase: string) => ({ ...versionTwoPayload, seedPhrase });

  it('rejects a phrase that is not twelve words', () => {
    expect(() => parseDecryptedWalletFile(withSeed('abandon abandon abandon'))).toThrow(MalformedBackupFileError);
  });

  it('rejects no phrase when an account still needs one', () => {
    // An HD account's key is re-derived from the seed and is not carried in the
    // file, so this pairing describes a wallet that cannot be restored.
    expect(() => parseDecryptedWalletFile({ ...versionTwoPayload, seedPhrase: '' })).toThrow(MalformedBackupFileError);
  });

  it('accepts no phrase when every account is imported', () => {
    // Local seed-phrase removal deletes the stored mnemonic; such a wallet can
    // still back up its imported secrets, and this is that file.
    const importedOnly = { ...versionTwoPayload, seedPhrase: '', accounts: [importedAccount] };
    expect(parseDecryptedWalletFile(importedOnly).seedPhrase).toBe('');
  });
});
