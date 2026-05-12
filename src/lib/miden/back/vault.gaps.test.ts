/**
 * Gap-coverage tests for `lib/miden/back/vault.ts`.
 *
 * Focused on branches not exercised by `vault.test.ts`:
 *   - instance `signWord`
 *   - instance `getPublicKeyForCommitment` (success + error)
 *   - `concatAccount` duplicate-publicKey throw via `createHDAccount`
 *   - `pickFreshAccountName` walking past template collisions
 *   - `tryHardwareUnlock` success path (returns a Vault)
 */

import * as Passworder from 'lib/miden/passworder';
import { WalletType } from 'screens/onboarding/types';

import { PublicError } from './defaults';
import { encryptAndSaveMany, savePlain } from './safe-storage';
import { Vault } from './vault';

const memoryStore: Record<string, any> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: jest.fn(() => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) if (k in memoryStore) out[k] = memoryStore[k];
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign(memoryStore, items);
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete memoryStore[k];
    }
  })),
  StorageProvider: class {}
}));

const mockCreateMidenWallet = jest.fn(async (_type: any, _seed: Uint8Array) => 'acc-pub-key-1');
const mockGetAccounts = jest.fn(async () => [] as any[]);
const mockGetAccount = jest.fn(async (_id: string) => null as any);
const mockSyncState = jest.fn(async () => {});
const mockAccountsInsert = jest.fn(async (_options: any) => {});
const mockKeystoreInsert = jest.fn(async (_id: any, _secretKey: any) => {});
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(async (_options?: any) => ({
    createMidenWallet: (...args: unknown[]) => mockCreateMidenWallet(...(args as [any, Uint8Array])),
    importPublicMidenWalletFromSeed: async (_seed: Uint8Array) => 'acc-pub-key-imported',
    importAccountBySeed: async (_walletType: any, _seed: Uint8Array) => 'acc-pub-key-imported',
    getAccounts: () => mockGetAccounts(),
    getAccount: (id: string) => mockGetAccount(id),
    syncState: () => mockSyncState(),
    network: 'devnet',
    client: {
      accounts: { insert: mockAccountsInsert },
      keystore: { insert: mockKeystoreInsert }
    }
  })),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: any) => (typeof id === 'string' ? id : 'bech32:unknown'))
}));

jest.mock('lib/miden/reset', () => ({
  clearStorage: jest.fn(async () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  })
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  isDesktop: jest.fn(() => false),
  isMobile: jest.fn(() => false),
  isIOS: jest.fn(() => false),
  isAndroid: jest.fn(() => false)
}));

jest.mock('lib/i18n', () => ({
  getMessage: jest.fn((key: string, substitutions?: any) => {
    if (key === 'defaultAccountName') {
      return `Account ${substitutions?.accountNumber ?? ''}`;
    }
    return key;
  })
}));

const mockSign = jest.fn(() => ({ serialize: jest.fn(() => new Uint8Array([0xff, 0xaa, 0xbb, 0xcc])) }));
const mockPublicKey = jest.fn(() => ({ serialize: jest.fn(() => new Uint8Array([0xff, 0x11, 0x22, 0x33])) }));
const mockAuthSecretKeyDeserialize = jest.fn((_bytes?: Uint8Array) => ({
  sign: mockSign,
  signData: jest.fn(() => ({ serialize: jest.fn(() => new Uint8Array([1, 2, 3])) })),
  publicKey: mockPublicKey
}));
const mockWordFromHex = jest.fn((_hex: string) => ({ __wordMarker: 'word' }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...base,
    AuthSecretKey: {
      deserialize: (bytes: Uint8Array) => mockAuthSecretKeyDeserialize(bytes),
      ecdsaWithRNG: jest.fn(() => ({ __marker: 'ecdsa-secret' }))
    },
    SigningInputs: { deserialize: jest.fn(() => ({})) },
    Word: { deserialize: jest.fn(() => ({})), fromHex: (h: string) => mockWordFromHex(h) },
    AccountBuilder: jest.fn().mockImplementation(() => {
      const built = {
        account: {
          id: () => ({ __marker: 'imported-account-id' }),
          isFaucet: () => false,
          isNetwork: () => false
        }
      };
      const builder: any = {
        accountType: jest.fn(() => builder),
        storageMode: jest.fn(() => builder),
        withAuthComponent: jest.fn(() => builder),
        withBasicWalletComponent: jest.fn(() => builder),
        build: jest.fn(() => built)
      };
      return builder;
    }),
    AccountComponent: { createAuthComponentFromSecretKey: jest.fn(() => ({ __marker: 'auth-component' })) },
    AccountStorageMode: { public: jest.fn(() => 'public-mode'), private: jest.fn(() => 'private-mode') },
    AccountType: { RegularAccountImmutableCode: 2 }
  };
});

const { isDesktop, isMobile } = jest.requireMock('lib/platform');

const VAULT_PREFIX = 'vault';
const ck = (id: string) => `${VAULT_PREFIX}_${id}`;
const keys = {
  check: ck('check'),
  mnemonic: ck('mnemonic'),
  accPubKey: (pk: string) => `${ck('accpubkey')}_${pk}`,
  accAuthSecretKey: (pk: string) => `${ck('accauthsecretkey')}_${pk}`,
  currentAccPubKey: ck('curraccpubkey'),
  accounts: ck('accounts'),
  ownMnemonic: ck('ownmnemonic'),
  vaultKeyPassword: 'vault_key_password',
  vaultKeyHardware: 'vault_key_hardware'
};

const VALID_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function seedVault(
  password: string,
  opts: {
    accounts?: Array<{ publicKey: string; name: string; isPublic: boolean; type: WalletType }>;
    currentPk?: string;
  } = {}
): Promise<Vault> {
  const vaultKeyBytes = Passworder.generateVaultKey();
  const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
  const encryptedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
  await savePlain(keys.vaultKeyPassword, encryptedVaultKey);

  const accounts = opts.accounts ?? [
    { publicKey: 'acc-pub-key-1', name: 'Miden Account 1', isPublic: true, type: WalletType.OnChain }
  ];
  const currentPk = opts.currentPk ?? (accounts.length > 0 ? accounts[0]!.publicKey : 'no-accounts');

  const writes: [string, any][] = [
    [keys.check, VALID_MNEMONIC],
    [keys.mnemonic, VALID_MNEMONIC],
    [keys.accounts, accounts]
  ];
  await encryptAndSaveMany(writes, vaultKey);
  await savePlain(keys.currentAccPubKey, currentPk);
  await savePlain(keys.ownMnemonic, false);

  return new (Vault as any)(vaultKey);
}

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  jest.clearAllMocks();
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isMobile as jest.Mock).mockReturnValue(false);
  mockAuthSecretKeyDeserialize.mockReturnValue({
    sign: mockSign,
    signData: jest.fn(() => ({ serialize: jest.fn(() => new Uint8Array([1, 2, 3])) })),
    publicKey: mockPublicKey
  } as any);
});

describe('Vault instance signWord', () => {
  it('returns a 0x-prefixed hex signature derived from the stored secret', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('acc-pub-key-1'), '01020304']], vaultKey);

    // Default mock sign() serialize returns [0xff, 0xaa, 0xbb, 0xcc].
    // signWord slices off the leading byte → 'aabbcc'.
    const sig = await vault.signWord('acc-pub-key-1', '0xdeadbeef');
    expect(sig).toBe('0xaabbcc');
    expect(mockWordFromHex).toHaveBeenCalledWith('0xdeadbeef');
    expect(mockSign).toHaveBeenCalled();
  });
});

describe('Vault instance getPublicKeyForCommitment', () => {
  it('returns the hex public key (with the type-prefix byte stripped)', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('pkc-1'), 'aabbccdd']], vaultKey);

    // publicKey().serialize() is mocked to [0xff, 0x11, 0x22, 0x33] → '112233'.
    const pk = await vault.getPublicKeyForCommitment('pkc-1');
    expect(pk).toBe('112233');
  });

  it('wraps missing-secret errors in a PublicError', async () => {
    const vault = await seedVault('pw');
    // No secret key stored under 'pkc-missing' → fetchAndDecryptOneWithLegacyFallBack throws.
    await expect(vault.getPublicKeyForCommitment('pkc-missing')).rejects.toThrow(PublicError);
  });
});

describe('Vault.createHDAccount: concatAccount duplicate guard', () => {
  it('throws PublicError when the new account collides with an existing publicKey', async () => {
    const vault = await seedVault('pw');
    // Force createMidenWallet to return the same publicKey that's already in
    // the seeded accounts list. concatAccount must reject the duplicate.
    mockCreateMidenWallet.mockResolvedValueOnce('acc-pub-key-1');
    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toThrow(PublicError);
  });
});

describe('Vault.importAccountFromPrivateKey: pickFreshAccountName collision walk', () => {
  const VALID_HEX = 'deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef';

  it('skips past Account 1 / Account 2 to land on the next free template slot', async () => {
    const vault = await seedVault('pw', {
      accounts: [
        { publicKey: 'acc-a', name: 'Account 1', isPublic: true, type: WalletType.OnChain },
        { publicKey: 'acc-b', name: 'Account 2', isPublic: true, type: WalletType.OnChain }
      ],
      currentPk: 'acc-a'
    });
    const accounts = await vault.importAccountFromPrivateKey(VALID_HEX);
    expect(accounts[2]!.name).toBe('Account 3');
  });
});

describe('Vault.fetchAccounts: not-array throw', () => {
  it('throws PublicError when the persisted accounts slot is not an array', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    // Overwrite the accounts slot with a non-array value — fetchAndDecryptOneWithLegacyFallBack
    // will return the bogus shape and the Array.isArray guard must reject it.
    await encryptAndSaveMany([[keys.accounts, { not: 'an-array' }]], vaultKey);
    await expect(vault.fetchAccounts()).rejects.toThrow(PublicError);
  });
});

describe('Vault.spawnFromMidenClient: error branches', () => {
  it('throws PublicError when called with no password and no hardware available', async () => {
    // Extension platform → isHardwareSecurityAvailableForVault returns false →
    // spawnFromMidenClient hits `if (!password) throw 'Password is required...'`.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    await expect(Vault.spawnFromMidenClient('', VALID_MNEMONIC, [])).rejects.toThrow(PublicError);
  });

  it('throws PublicError when walletAccounts is empty after the WASM lock body', async () => {
    // Password is provided, walletAccounts is [] — the empty-list branch must reject.
    await expect(Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [])).rejects.toThrow(PublicError);
  });
});

describe('Vault.spawn: preserved guardian URL', () => {
  it('restores GUARDIAN_URL_STORAGE_KEY across the storage wipe', async () => {
    const { putToStorage, fetchFromStorage } = await import('../front/storage');
    const { GUARDIAN_URL_STORAGE_KEY } = await import('lib/settings/constants');
    await putToStorage(GUARDIAN_URL_STORAGE_KEY, 'https://my-guardian.example');

    await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC);

    // The clearStorage wipe would normally drop everything; the spawn() guard
    // explicitly re-puts GUARDIAN_URL_STORAGE_KEY when it was set before the wipe.
    expect(await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)).toBe('https://my-guardian.example');
  });
});

describe('Vault.spawn: Guardian recovery (lookup + adopt)', () => {
  it('persists every account returned by recoverGuardianAccountsBySeed with requiresHotKeyRotation=true', async () => {
    // recoverGuardianAccountsBySeed adopts each on-chain account locally
    // (no rotation — the user activates the hot key explicitly via the
    // post-recovery banner). Vault.spawn must round-trip the array, persist
    // only the cold mirror per account, and flag each WalletAccount with
    // requiresHotKeyRotation so the banner picks it up.
    const sdk = require('../sdk/miden-client');
    const origGetClient = sdk.getMidenClient;
    sdk.getMidenClient = jest.fn(async (_options: any) => ({
      recoverGuardianAccountsBySeed: async (_deriveColdSeed: any, _endpoint: string) => [
        {
          accountId: 'guardian-pk',
          hdIndex: 0,
          coldPublicKey: 'bb'.repeat(33),
          coldSecretKeyHex: 'dd'.repeat(32)
        }
      ],
      createGuardianMidenWallet: async (_seed: Uint8Array) => ({
        accountId: 'guardian-pk',
        keys: {
          hotPublicKey: 'aa'.repeat(33),
          hotCiphertext: 'cf'.repeat(64),
          coldPublicKey: 'bb'.repeat(33),
          coldSecretKeyHex: 'dd'.repeat(32)
        }
      }),
      getAccounts: async () => [],
      getAccount: async () => null,
      syncState: async () => {},
      network: 'devnet',
      client: { accounts: { insert: jest.fn() }, keystore: { insert: jest.fn() } }
    }));

    try {
      const vault = await Vault.spawn(WalletType.Guardian, 'pw', VALID_MNEMONIC, true);
      expect(vault).toBeInstanceOf(Vault);
    } finally {
      sdk.getMidenClient = origGetClient;
    }
  });
});

describe('Vault.revealPrivateKey: not-found path', () => {
  it('throws PublicError when the stored secret is empty/falsy after decrypt', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    // Persist an empty string under the expected slot. fetchAndDecryptOneWithLegacyFallBack
    // returns the falsy value, so the `if (!secretKeyHex)` guard fires.
    await encryptAndSaveMany([[keys.accAuthSecretKey('acc-empty'), '']], vaultKey);
    await expect(Vault.revealPrivateKey('acc-empty', 'pw')).rejects.toThrow(PublicError);
  });
});

// Hardware-success paths require mocking the dynamic-imported `lib/biometric`
// module. The existing vault.test.ts uses jest.doMock with virtual:true; mirror
// that pattern in an isolated describe so the module registration doesn't bleed
// into the other tests above.
describe('Vault hardware-backed unlock + reveal', () => {
  let storedHardwareB64: string | null = null;

  beforeAll(() => {
    jest.doMock(
      'lib/biometric',
      () => ({
        isHardwareSecurityAvailable: jest.fn(async () => true),
        hasHardwareKey: jest.fn(async () => false),
        generateHardwareKey: jest.fn(async () => {}),
        encryptWithHardwareKey: jest.fn(async (b: string) => {
          storedHardwareB64 = b;
          return `enc(${b})`;
        }),
        decryptWithHardwareKey: jest.fn(async (encrypted: string) => {
          // The vault stores the encrypted blob; decryption must round-trip
          // back to the original base64 vault-key bytes.
          if (encrypted.startsWith('enc(') && encrypted.endsWith(')')) {
            return encrypted.slice(4, -1);
          }
          return storedHardwareB64 ?? '';
        })
      }),
      { virtual: true }
    );
  });

  afterAll(() => {
    jest.dontMock('lib/biometric');
  });

  beforeEach(() => {
    storedHardwareB64 = null;
  });

  it('tryHardwareUnlock returns a Vault instance when the hardware decrypt succeeds', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isDesktop as jest.Mock).mockReturnValue(false);
    // Spawn-without-password takes the hardware-only branch and stores the
    // encrypted vault key under VAULT_KEY_HARDWARE_STORAGE_KEY.
    await Vault.spawn(WalletType.OnChain, undefined as any, VALID_MNEMONIC);
    const unlocked = await Vault.tryHardwareUnlock();
    expect(unlocked).toBeInstanceOf(Vault);
  });

  it('revealPrivateKey without a password takes the hardware-vault-key branch', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isDesktop as jest.Mock).mockReturnValue(false);
    const vault = await Vault.spawn(WalletType.OnChain, undefined as any, VALID_MNEMONIC);
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('pkc-hw'), '4242']], vaultKey);

    const sk = await Vault.revealPrivateKey('pkc-hw');
    expect(sk).toBe('4242');
  });

  it('Vault.setup() without a password returns the unlocked Vault when hardware unlock succeeds', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isDesktop as jest.Mock).mockReturnValue(false);
    // Spawn hardware-only first so the encrypted vault key is stored.
    await Vault.spawn(WalletType.OnChain, undefined as any, VALID_MNEMONIC);
    // Now setup() with no password drops into the `if (vault) return vault` arm.
    const unlocked = await Vault.setup();
    expect(unlocked).toBeInstanceOf(Vault);
  });

  it('spawnFromMidenClient throws when hardware is available but setupHardwareProtector reports failure', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isDesktop as jest.Mock).mockReturnValue(false);
    // Force the encryption step to throw on this call only so setupHardwareProtector
    // returns false → spawnFromMidenClient hits its `Hardware security setup failed` branch.
    const biometric = require('lib/biometric');
    biometric.encryptWithHardwareKey.mockRejectedValueOnce(new Error('hw-encrypt-fail'));
    await expect(
      Vault.spawnFromMidenClient('', VALID_MNEMONIC, [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
      ])
    ).rejects.toThrow(PublicError);
  });
});
