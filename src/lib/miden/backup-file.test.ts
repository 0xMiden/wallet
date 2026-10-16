import { WalletType } from 'screens/onboarding/types';

import {
  MalformedBackupFileError,
  UnsupportedBackupVersionError,
  WrongNetworkBackupError,
  assertBackupNetwork,
  assertSameGenesis,
  backupGenesisHeader,
  importedAccountBackupFailure,
  isExcludedFromWalletFile,
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

const unversionedPayload = {
  seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  midenClientDbContent: 'miden-db',
  walletDbContent: 'wallet-db',
  accounts: [hdAccount]
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
  it('rejects an unversioned payload with the malformed-file error', () => {
    expect(() => parseDecryptedWalletFile(unversionedPayload)).toThrow(MalformedBackupFileError);
  });

  it('accepts a version 2 payload with imported-account backup material', () => {
    expect(parseDecryptedWalletFile(versionTwoPayload)).toEqual(versionTwoPayload);
  });

  it('rejects an unsupported future format version with a dedicated error', () => {
    expect(() => parseDecryptedWalletFile({ ...versionTwoPayload, formatVersion: 3 })).toThrow(
      UnsupportedBackupVersionError
    );
  });

  it('reports a future format version before judging its account records', () => {
    const withoutScheme = {
      publicKey: 'miden-account-no-scheme',
      name: 'No scheme',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0
    };
    expect(() =>
      parseDecryptedWalletFile({ ...versionTwoPayload, formatVersion: 3, accounts: [withoutScheme] })
    ).toThrow(UnsupportedBackupVersionError);
  });

  it.each([
    ['missing accounts', { ...versionTwoPayload, accounts: undefined }],
    ['non-array accounts', { ...versionTwoPayload, accounts: {} }],
    ['account missing a required field', { ...versionTwoPayload, accounts: [{ ...hdAccount, name: undefined }] }],
    ['account with an invalid wallet type', { ...versionTwoPayload, accounts: [{ ...hdAccount, type: 'invalid' }] }]
  ])('rejects %s', (_label, payload) => {
    expect(() => parseDecryptedWalletFile(payload)).toThrow(MalformedBackupFileError);
  });

  it.each(['v1', undefined])('accepts a wallet account whose keyDerivation is %p', keyDerivation => {
    const parsed = parseDecryptedWalletFile({ ...versionTwoPayload, accounts: [{ ...hdAccount, keyDerivation }] });
    expect(parsed.accounts[0]!.keyDerivation).toBe(keyDerivation);
  });

  it.each(['legacy', 'v2'])('rejects a wallet account with an unknown keyDerivation %p', keyDerivation => {
    expect(() =>
      parseDecryptedWalletFile({ ...versionTwoPayload, accounts: [{ ...hdAccount, keyDerivation }] })
    ).toThrow(MalformedBackupFileError);
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

  it('rejects a wallet account with no authScheme', () => {
    const withoutScheme = {
      publicKey: 'miden-account-no-scheme',
      name: 'No scheme',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 1
    };
    expect(() =>
      parseDecryptedWalletFile({ ...versionTwoPayload, accounts: [hdAccount, importedAccount, withoutScheme] })
    ).toThrow(MalformedBackupFileError);
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
    ['an array', [versionTwoPayload]]
  ])('rejects %s in place of the payload object', (_label, payload) => {
    expect(() => parseDecryptedWalletFile(payload)).toThrow(MalformedBackupFileError);
  });

  it.each([
    ['a primitive', 'miden-account-hd'],
    ['null', null],
    ['an array', [hdAccount]]
  ])('rejects %s in place of a wallet account', (_label, account) => {
    expect(() => parseDecryptedWalletFile({ ...versionTwoPayload, accounts: [account] })).toThrow(
      MalformedBackupFileError
    );
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

  it('keeps the network a file records', () => {
    expect(parseDecryptedWalletFile({ ...versionTwoPayload, network: 'mainnet' }).network).toBe('mainnet');
  });

  it.each<[string, unknown]>([
    ['a number', 1],
    ['null', null]
  ])('rejects a recorded network that is %s', (_label, network) => {
    expect(() => parseDecryptedWalletFile({ ...versionTwoPayload, network })).toThrow(MalformedBackupFileError);
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

describe('isExcludedFromWalletFile (#1114)', () => {
  it.each([
    { label: 'a Guardian account imported from its keys', type: WalletType.Guardian, hdIndex: -1, excluded: true },
    { label: 'a seed-derived Guardian account', type: WalletType.Guardian, hdIndex: 0, excluded: false },
    { label: 'an imported private-key account', type: WalletType.OnChain, hdIndex: -1, excluded: false },
    { label: 'a seed-derived on-chain account', type: WalletType.OnChain, hdIndex: 0, excluded: false }
  ])('$label is excluded: $excluded (#1114)', ({ type, hdIndex, excluded }) => {
    expect(isExcludedFromWalletFile({ type, hdIndex })).toBe(excluded);
  });
});

// A store dump as the SDK's `exportStore` writes it: one list of rows per table,
// binary fields as tagged base64. Only the block header table matters here.
const storeDump = (blockHeaders: unknown[]) => JSON.stringify({ accountCodes: [], blockHeaders, settings: [] });

const headerRow = (blockNum: number, bytes: number[]) => ({
  blockNum,
  header: { __type: 'Uint8Array', data: Buffer.from(bytes).toString('base64') },
  hasClientNotes: 'false'
});

describe('backupGenesisHeader', () => {
  it('reads the genesis header bytes the import would write', () => {
    const dump = storeDump([headerRow(7, [9, 9]), headerRow(0, [1, 2, 3])]);
    expect(backupGenesisHeader(dump)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reads a dump encoded twice, which the SDK importer also accepts', () => {
    expect(backupGenesisHeader(JSON.stringify(storeDump([headerRow(0, [4])])))).toEqual(new Uint8Array([4]));
  });

  it.each<[string, string]>([
    ['is not JSON', 'miden-db'],
    ['is not an object', '42'],
    ['has no block header table', JSON.stringify({ accountCodes: [] })],
    ['has no genesis row', storeDump([headerRow(7, [9])])],
    ['has two genesis rows', storeDump([headerRow(0, [1]), headerRow(0, [2])])],
    ['stores the genesis header untagged', storeDump([{ blockNum: 0, header: 'AQID', hasClientNotes: 'false' }])],
    [
      'tags the genesis header as another type',
      storeDump([{ blockNum: 0, header: { __type: 'Blob', data: 'AQID' }, hasClientNotes: 'false' }])
    ],
    [
      'carries a genesis header that is not base64',
      storeDump([{ blockNum: 0, header: { __type: 'Uint8Array', data: '%%' }, hasClientNotes: 'false' }])
    ]
  ])('refuses a dump that %s as malformed', (_label, dump) => {
    expect(() => backupGenesisHeader(dump)).toThrow(MalformedBackupFileError);
  });
});

describe('assertBackupNetwork', () => {
  const file = parseDecryptedWalletFile(versionTwoPayload);

  it('passes a file recorded on the effective network', () => {
    expect(() => assertBackupNetwork({ ...file, network: 'testnet' }, 'testnet')).not.toThrow();
  });

  it('passes a file written before the network was recorded', () => {
    expect(() => assertBackupNetwork(file, 'mainnet')).not.toThrow();
  });

  it.each(['mainnet', 'a-network-this-wallet-does-not-know'])('refuses a file recorded on %p', network => {
    expect(() => assertBackupNetwork({ ...file, network }, 'testnet')).toThrow(WrongNetworkBackupError);
  });
});

describe('assertSameGenesis', () => {
  it('passes the same genesis header', () => {
    expect(() => assertSameGenesis(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it.each<[string, number[]]>([
    ['one byte differs', [1, 2, 4]],
    ['it is a prefix of the active one', [1, 2]],
    ['it is longer than the active one', [1, 2, 3, 4]]
  ])('refuses a file genesis where %s', (_label, bytes) => {
    expect(() => assertSameGenesis(new Uint8Array(bytes), new Uint8Array([1, 2, 3]))).toThrow(WrongNetworkBackupError);
  });
});
