import { WalletType } from 'screens/onboarding/types';

import { MalformedBackupFileError, UnsupportedBackupVersionError, parseDecryptedWalletFile } from './backup-file';

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
  seedPhrase: 'seed words',
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
  seedPhrase: 'seed words',
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
});
