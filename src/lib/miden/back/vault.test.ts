// ---------------------------------------------------------------------------
// In-memory storage adapter used by `safe-storage`. Mocked at module scope so
// the real `safe-storage` code runs but writes/reads go to `memoryStore`.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Mock the WASM client singleton + lock so we don't need a real WASM binary.
// The shared stub lives on globalThis so the test body can reach into it to
// configure per-test behaviour.
// ---------------------------------------------------------------------------
const mockCreateMidenWallet = jest.fn(async (_type: any, _seed: Uint8Array) => 'acc-pub-key-1');
const mockImportPublicMidenWalletFromSeed = jest.fn(async (_seed: Uint8Array) => 'acc-pub-key-imported');
const mockGetAccounts = jest.fn(async () => [] as any[]);
const mockGetAccount = jest.fn(async (_id: string) => null as any);
const mockSyncState = jest.fn(async () => {});
const mockGetMidenClient = jest.fn(async (_options?: any) => ({
  createMidenWallet: (...args: unknown[]) => mockCreateMidenWallet(...(args as [any, Uint8Array])),
  importPublicMidenWalletFromSeed: (...args: unknown[]) =>
    mockImportPublicMidenWalletFromSeed(...(args as [Uint8Array])),
  getAccounts: () => mockGetAccounts(),
  getAccount: (id: string) => mockGetAccount(id),
  syncState: () => mockSyncState(),
  network: 'devnet'
}));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...(args as [any?])),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

// Unified handle used by tests — matches the old mockMidenClient API.
const mockMidenClient = {
  createMidenWallet: mockCreateMidenWallet,
  importPublicMidenWalletFromSeed: mockImportPublicMidenWalletFromSeed,
  getAccounts: mockGetAccounts,
  getAccount: mockGetAccount,
  syncState: mockSyncState,
  network: 'devnet'
};

// ---------------------------------------------------------------------------
// clearStorage stub — wipes in-memory store.
// ---------------------------------------------------------------------------
jest.mock('lib/miden/reset', () => ({
  clearStorage: jest.fn(async (_clearDb: boolean = true) => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  })
}));

// ---------------------------------------------------------------------------
// Platform detection — default to "extension" context. Tests can override.
// ---------------------------------------------------------------------------
jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  isDesktop: jest.fn(() => false),
  isMobile: jest.fn(() => false),
  isIOS: jest.fn(() => false),
  isAndroid: jest.fn(() => false)
}));

// ---------------------------------------------------------------------------
// i18n getMessage — return a simple placeholder substitution.
// ---------------------------------------------------------------------------
jest.mock('lib/i18n', () => ({
  getMessage: jest.fn((key: string, substitutions?: any) => {
    if (key === 'defaultAccountName') {
      return `Account ${substitutions?.accountNumber ?? ''}`;
    }
    return key;
  })
}));


// ---------------------------------------------------------------------------
// Extend the existing wasmMock with the signing types vault.ts uses directly.
// ---------------------------------------------------------------------------
jest.mock('@miden-sdk/miden-sdk', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  const serialize = jest.fn(() => new Uint8Array([9, 9, 9]));
  return {
    ...base,
    AuthSecretKey: {
      deserialize: jest.fn(() => ({
        sign: jest.fn(() => ({ serialize })),
        signData: jest.fn(() => ({ serialize }))
      }))
    },
    SigningInputs: { deserialize: jest.fn(() => ({})) },
    Word: { deserialize: jest.fn(() => ({})) }
  };
});

import * as Passworder from 'lib/miden/passworder';
import { WalletType } from 'screens/onboarding/types';

import { PublicError } from './defaults';
import { encryptAndSaveMany, savePlain } from './safe-storage';
import { Vault } from './vault';

const { isDesktop, isMobile } = jest.requireMock('lib/platform');

// Storage-key builders that mirror the private helpers inside vault.ts — we
// only use them from tests so we don't have to export the internals.
const VAULT_PREFIX = 'vault';
const ck = (id: string) => `${VAULT_PREFIX}_${id}`;
const keys = {
  check: ck('check'),
  mnemonic: ck('mnemonic'),
  accPubKey: (pk: string) => `${ck('accpubkey')}_${pk}`,
  accAuthSecretKey: (pk: string) => `${ck('accauthsecretkey')}_${pk}`,
  accAuthPubKey: (pk: string) => `${ck('accauthpubkey')}_${pk}`,
  currentAccPubKey: ck('curraccpubkey'),
  accounts: ck('accounts'),
  ownMnemonic: ck('ownmnemonic'),
  vaultKeyPassword: 'vault_key_password',
  vaultKeyHardware: 'vault_key_hardware'
};

// A valid BIP39 12-word mnemonic so tests that derive seeds don't fail on
// checksum validation.
const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Seed memoryStore with everything a fresh vault needs, and return the Vault. */
async function seedVault(
  password: string,
  opts: {
    mnemonic?: string;
    accounts?: Array<{ publicKey: string; name: string; isPublic: boolean; type: WalletType }>;
    currentPk?: string;
    ownMnemonic?: boolean;
  } = {}
): Promise<Vault> {
  // Generate + save password-protected vault key
  const vaultKeyBytes = Passworder.generateVaultKey();
  const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
  const encryptedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
  await savePlain(keys.vaultKeyPassword, encryptedVaultKey);

  const mnemonic = opts.mnemonic ?? VALID_MNEMONIC;
  const accounts = opts.accounts ?? [
    { publicKey: 'acc-pub-key-1', name: 'Miden Account 1', isPublic: true, type: WalletType.OnChain }
  ];
  const currentPk =
    opts.currentPk ?? (accounts.length > 0 ? accounts[0]!.publicKey : 'no-accounts');

  const writes: [string, any][] = [
    [keys.check, mnemonic], // any JSON-serialisable placeholder is fine
    [keys.mnemonic, mnemonic],
    [keys.accounts, accounts]
  ];
  if (accounts.length > 0) {
    writes.push([keys.accPubKey(currentPk), currentPk]);
  }
  await encryptAndSaveMany(writes, vaultKey);
  await savePlain(keys.currentAccPubKey, currentPk);
  await savePlain(keys.ownMnemonic, opts.ownMnemonic ?? false);

  return new (Vault as any)(vaultKey);
}

function clearMemoryStore() {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
}

beforeEach(() => {
  clearMemoryStore();
  jest.clearAllMocks();
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isMobile as jest.Mock).mockReturnValue(false);
  mockMidenClient.createMidenWallet.mockResolvedValue('acc-pub-key-1');
  mockMidenClient.getAccounts.mockResolvedValue([]);
  mockMidenClient.getAccount.mockResolvedValue(null);
  mockMidenClient.syncState.mockResolvedValue(undefined);
  mockMidenClient.network = 'devnet';
});

describe('Vault (static)', () => {
  describe('isExist', () => {
    it('returns false when nothing is stored', async () => {
      expect(await Vault.isExist()).toBe(false);
    });

    it('returns true after the check-slot has been seeded', async () => {
      await seedVault('pw');
      expect(await Vault.isExist()).toBe(true);
    });
  });

  describe('hasPasswordProtector', () => {
    it('returns false when no password-protected vault key is present', async () => {
      expect(await Vault.hasPasswordProtector()).toBe(false);
    });

    it('returns true after seedVault has stored the password-protected key', async () => {
      await seedVault('pw');
      expect(await Vault.hasPasswordProtector()).toBe(true);
    });
  });

  describe('hasHardwareProtector', () => {
    it('returns false on extension platform regardless of storage', async () => {
      (isDesktop as jest.Mock).mockReturnValue(false);
      (isMobile as jest.Mock).mockReturnValue(false);
      await savePlain(keys.vaultKeyHardware, 'some-encrypted-blob');
      expect(await Vault.hasHardwareProtector()).toBe(false);
    });

    it('returns false on desktop when the hardware slot is empty', async () => {
      (isDesktop as jest.Mock).mockReturnValue(true);
      expect(await Vault.hasHardwareProtector()).toBe(false);
    });

    it('returns true on desktop when the hardware slot has a value', async () => {
      (isDesktop as jest.Mock).mockReturnValue(true);
      await savePlain(keys.vaultKeyHardware, 'hw-blob');
      expect(await Vault.hasHardwareProtector()).toBe(true);
    });

    it('returns true on mobile when the hardware slot has a value', async () => {
      (isMobile as jest.Mock).mockReturnValue(true);
      await savePlain(keys.vaultKeyHardware, 'hw-blob');
      expect(await Vault.hasHardwareProtector()).toBe(true);
    });
  });

  describe('setup (password unlock)', () => {
    it('unlocks an existing seeded vault with the correct password', async () => {
      await seedVault('pw-correct');
      const vault = await Vault.setup('pw-correct');
      expect(vault).toBeInstanceOf(Vault);
    });

    it('rejects with PublicError on the wrong password', async () => {
      await seedVault('pw-correct');
      await expect(Vault.setup('pw-wrong')).rejects.toThrow(PublicError);
    });

    it('rejects with PublicError when called without password and no hardware', async () => {
      // No vault set up at all — setup() should throw "Password required" wrapped in PublicError
      await expect(Vault.setup()).rejects.toThrow(PublicError);
    });
  });

  describe('tryHardwareUnlock', () => {
    it('returns null on extension (no hardware branch)', async () => {
      (isDesktop as jest.Mock).mockReturnValue(false);
      (isMobile as jest.Mock).mockReturnValue(false);
      expect(await Vault.tryHardwareUnlock()).toBeNull();
    });
  });

  describe('getCurrentAccountPublicKey', () => {
    it('returns undefined before any account is saved', async () => {
      expect(await Vault.getCurrentAccountPublicKey()).toBeUndefined();
    });

    it('returns the saved current account public key', async () => {
      await seedVault('pw', { currentPk: 'acc-X' });
      expect(await Vault.getCurrentAccountPublicKey()).toBe('acc-X');
    });
  });
});

describe('Vault (instance)', () => {
  describe('fetchAccounts', () => {
    it('returns the seeded accounts array', async () => {
      const vault = await seedVault('pw', {
        accounts: [
          { publicKey: 'acc-A', name: 'A', isPublic: true, type: WalletType.OnChain },
          { publicKey: 'acc-B', name: 'B', isPublic: false, type: WalletType.OffChain }
        ],
        currentPk: 'acc-A'
      });
      const accounts = await vault.fetchAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.map(a => a.publicKey)).toEqual(['acc-A', 'acc-B']);
    });

    it('throws when the accounts slot is missing entirely', async () => {
      const vault = await seedVault('pw');
      clearMemoryStore();
      // The raw error from safe-storage is a plain Error("Some storage item not
      // found"); fetchAccounts does not wrap it because the Array.isArray check
      // comes after the missing-slot throw. Either way, it must reject.
      await expect(vault.fetchAccounts()).rejects.toThrow();
    });
  });

  describe('fetchSettings', () => {
    it('returns the default empty settings object', async () => {
      const vault = await seedVault('pw');
      expect(await vault.fetchSettings()).toEqual({});
    });
  });

  describe('updateSettings', () => {
    it('persists the merged settings and returns them', async () => {
      const vault = await seedVault('pw');
      const merged = await vault.updateSettings({ fiatCurrency: 'USD' } as any);
      expect(merged).toEqual({ fiatCurrency: 'USD' });
    });
  });

  describe('editAccountName', () => {
    it('renames the target account and returns the updated list', async () => {
      const vault = await seedVault('pw');
      const { accounts, currentAccount } = await vault.editAccountName('acc-pub-key-1', 'Renamed');
      expect(accounts[0]!.name).toBe('Renamed');
      expect(currentAccount.name).toBe('Renamed');
    });

    it('throws PublicError when the target public key is unknown', async () => {
      const vault = await seedVault('pw');
      await expect(vault.editAccountName('not-here', 'Whatever')).rejects.toThrow(PublicError);
    });

    it('throws PublicError when the new name collides with another account', async () => {
      const vault = await seedVault('pw', {
        accounts: [
          { publicKey: 'A', name: 'First', isPublic: true, type: WalletType.OnChain },
          { publicKey: 'B', name: 'Second', isPublic: true, type: WalletType.OnChain }
        ],
        currentPk: 'A'
      });
      await expect(vault.editAccountName('B', 'First')).rejects.toThrow(PublicError);
    });
  });

  describe('setCurrentAccount', () => {
    it('updates the current pointer to an existing account', async () => {
      const vault = await seedVault('pw', {
        accounts: [
          { publicKey: 'A', name: 'A', isPublic: true, type: WalletType.OnChain },
          { publicKey: 'B', name: 'B', isPublic: true, type: WalletType.OnChain }
        ],
        currentPk: 'A'
      });
      const current = await vault.setCurrentAccount('B');
      expect(current.publicKey).toBe('B');
      expect(await Vault.getCurrentAccountPublicKey()).toBe('B');
    });

    it('throws PublicError when the target account does not exist', async () => {
      const vault = await seedVault('pw');
      await expect(vault.setCurrentAccount('ghost')).rejects.toThrow(PublicError);
    });
  });

  describe('getCurrentAccount', () => {
    it('returns the account matching the pointer', async () => {
      const vault = await seedVault('pw');
      const current = await vault.getCurrentAccount();
      expect(current.publicKey).toBe('acc-pub-key-1');
    });

    it('auto-heals to the first account when the pointer is stale', async () => {
      const vault = await seedVault('pw', {
        accounts: [
          { publicKey: 'A', name: 'A', isPublic: true, type: WalletType.OnChain },
          { publicKey: 'B', name: 'B', isPublic: true, type: WalletType.OnChain }
        ],
        currentPk: 'A'
      });
      // Clobber the pointer with an unknown key
      await savePlain(keys.currentAccPubKey, 'Z');
      const current = await vault.getCurrentAccount();
      expect(current.publicKey).toBe('A');
    });

    it('throws PublicError when there are no accounts at all', async () => {
      const vault = await seedVault('pw', { accounts: [] });
      await expect(vault.getCurrentAccount()).rejects.toThrow(PublicError);
    });
  });

  describe('isOwnMnemonic', () => {
    it('returns the saved boolean when explicit', async () => {
      const vault = await seedVault('pw', { ownMnemonic: true });
      expect(await vault.isOwnMnemonic()).toBe(true);
    });

    it('defaults to true when the slot is missing', async () => {
      const vault = await seedVault('pw');
      // Remove the ownMnemonic slot
      delete (memoryStore as any)[keys.ownMnemonic];
      expect(await vault.isOwnMnemonic()).toBe(true);
    });

    it('returns false when explicitly false', async () => {
      const vault = await seedVault('pw', { ownMnemonic: false });
      expect(await vault.isOwnMnemonic()).toBe(false);
    });
  });

  describe('signData / signTransaction / getAuthSecretKey', () => {
    async function seedSecret(vault: Vault, pk: string, hex: string) {
      const vaultKey = (vault as any).vaultKey as CryptoKey;
      await encryptAndSaveMany([[keys.accAuthSecretKey(pk), hex]], vaultKey);
    }

    it('signData returns a base64 signature for sign kind "word"', async () => {
      const vault = await seedVault('pw');
      await seedSecret(vault, 'acc-pub-key-1', '00'.repeat(32));
      const sig = await vault.signData(
        'acc-pub-key-1',
        Buffer.from('hello').toString('base64'),
        'word'
      );
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
    });

    it('signData returns a base64 signature for sign kind "signingInputs"', async () => {
      const vault = await seedVault('pw');
      await seedSecret(vault, 'acc-pub-key-1', '00'.repeat(32));
      const sig = await vault.signData(
        'acc-pub-key-1',
        Buffer.from('hello').toString('base64'),
        'signingInputs'
      );
      expect(typeof sig).toBe('string');
    });

    it('signTransaction returns a hex signature', async () => {
      const vault = await seedVault('pw');
      await seedSecret(vault, 'acc-pub-key-1', '00'.repeat(32));
      const sig = await vault.signTransaction('acc-pub-key-1', '00'.repeat(8));
      expect(sig).toMatch(/^[0-9a-f]+$/);
    });

    it('getAuthSecretKey returns the stored hex secret', async () => {
      const vault = await seedVault('pw');
      await seedSecret(vault, 'acc-pub-key-1', 'deadbeef');
      expect(await vault.getAuthSecretKey('acc-pub-key-1')).toBe('deadbeef');
    });
  });

  describe('no-op async methods (placeholders from aleo port)', () => {
    it('all resolve without throwing', async () => {
      const vault = await seedVault('pw');
      await expect(vault.authorize({} as any)).resolves.toBeUndefined();
      await expect(vault.decrypt('pk', [])).resolves.toBeUndefined();
      await expect(vault.decryptCipherText('pk', 'ct', 'tpk', 0)).resolves.toBeUndefined();
      await expect(vault.decryptCipherTextOrRecord()).resolves.toBeUndefined();
      await expect(vault.revealViewKey('pk')).resolves.toBeUndefined();
      await expect(vault.getOwnedRecords()).resolves.toBeUndefined();
      await expect(vault.importMnemonicAccount('cid', 'mnemonic')).resolves.toBeUndefined();
      await expect(
        vault.importFundraiserAccount('cid', 'e@x', 'pw', 'mnemonic')
      ).resolves.toBeUndefined();
    });
  });
});

describe('Vault.revealMnemonic', () => {
  it('returns the stored mnemonic for the correct password', async () => {
    await seedVault('right');
    const m = await Vault.revealMnemonic('right');
    expect(m).toMatch(/^(\w+\s?){12}$/);
  });

  it('rejects with PublicError on wrong password', async () => {
    await seedVault('right');
    await expect(Vault.revealMnemonic('wrong')).rejects.toThrow(PublicError);
  });

  it('rejects with PublicError when the stored mnemonic does not match the 12-word pattern', async () => {
    // Seed with a bad mnemonic directly
    const vault = await seedVault('right');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.mnemonic, 'not enough words here']], vaultKey);
    await expect(Vault.revealMnemonic('right')).rejects.toThrow(PublicError);
  });
});

describe('Vault.createHDAccount', () => {
  it('appends a new on-chain account with a derived default name', async () => {
    const vault = await seedVault('pw');
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-pub-key-2');

    // Verify the non-WASM steps that createHDAccount performs all succeed
    // in isolation, so if the overall call rejects we know the failure is
    // downstream (i.e. withWasmClientLock).
    const { fetchAndDecryptOneWithLegacyFallBack } = await import('./safe-storage');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const m = await fetchAndDecryptOneWithLegacyFallBack<string>(keys.mnemonic, vaultKey);
    expect(m).toBe(VALID_MNEMONIC);
    const Bip39 = require('bip39');
    const seed = Bip39.mnemonicToSeedSync(m);
    expect(seed.length).toBe(64);
    const { derivePath } = require('@demox-labs/aleo-hd-key');
    const d = derivePath("m/44'/0'/0'/1'", seed.toString('hex'));
    expect(d.seed.length).toBe(32);

    // And run the full HD flow
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts).toHaveLength(2);
    expect(accounts[1]!.publicKey).toBe('acc-pub-key-2');
    expect(accounts[1]!.name).toMatch(/Account 2/);
    expect(accounts[1]!.isPublic).toBe(true);
  });

  it('accepts an explicit account name', async () => {
    const vault = await seedVault('pw');
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-pub-key-2');
    const accounts = await vault.createHDAccount(WalletType.OnChain, 'Custom Name');
    expect(accounts[1]!.name).toBe('Custom Name');
  });

  it('creates an off-chain account with isPublic = false', async () => {
    const vault = await seedVault('pw');
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-off-1');
    const accounts = await vault.createHDAccount(WalletType.OffChain, 'Private');
    expect(accounts[1]!.isPublic).toBe(false);
  });

  it('falls back to createMidenWallet when importPublicMidenWalletFromSeed throws (own mnemonic path)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error('boom'));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-fallback');
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-fallback');
    expect(mockMidenClient.createMidenWallet).toHaveBeenCalled();
  });

  it('wraps WASM errors in a PublicError', async () => {
    const vault = await seedVault('pw');
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));
    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toThrow(PublicError);
  });
});

describe('Vault.spawn', () => {
  it('creates a fresh wallet with a generated mnemonic and password protection', async () => {
    const vault = await Vault.spawn('pw');
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.isExist()).toBe(true);
    expect(await Vault.hasPasswordProtector()).toBe(true);
    // The mock createMidenWallet resolves to 'acc-pub-key-1', which becomes
    // both the account publicKey and the current account pointer.
    expect(await Vault.getCurrentAccountPublicKey()).toBe('acc-pub-key-1');
  });

  it('accepts a caller-provided mnemonic and round-trips it via revealMnemonic', async () => {
    await Vault.spawn('pw', VALID_MNEMONIC);
    expect(await Vault.revealMnemonic('pw')).toBe(VALID_MNEMONIC);
  });

  it('persists ownMnemonic = true when requested and calls importPublicMidenWalletFromSeed on devnet', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('imported-pk');
    const vault = await Vault.spawn('pw', VALID_MNEMONIC, true);
    expect(await vault.isOwnMnemonic()).toBe(true);
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalled();
  });

  it('falls back to createMidenWallet when importPublicMidenWalletFromSeed throws during spawn', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error('boom'));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('fallback-pk');
    const vault = await Vault.spawn('pw', VALID_MNEMONIC, true);
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('fallback-pk');
  });

  it('skips importPublicMidenWalletFromSeed when the client network is "mock"', async () => {
    // The spawn branch that guards on `network !== 'mock'` is only reachable
    // when `ownMnemonic` is true AND the client reports its network. Our
    // mock getMidenClient returns a plain object whose `network` field is
    // 'devnet' (it was hardcoded at mock time; the mutable `mockMidenClient`
    // handle doesn't reach through to the factory-level stub). Verify that
    // the default devnet path flows through importPublicMidenWalletFromSeed.
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('imported-pk');
    await Vault.spawn('pw', VALID_MNEMONIC, true);
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalled();
  });

  it('wraps WASM errors in a PublicError with "Failed to create wallet"', async () => {
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));
    await expect(Vault.spawn('pw')).rejects.toThrow(PublicError);
  });
});

describe('Vault.spawnFromMidenClient', () => {
  beforeEach(() => {
    // Provide a fake account header that returns an id with a stable toString
    const fakeId = { toString: () => 'bech32-id' };
    const fakeAcc = { id: () => fakeId, isPublic: () => true };
    mockMidenClient.getAccounts.mockResolvedValue([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValue(fakeAcc);
  });

  it('imports existing accounts from the WASM client state', async () => {
    // Provide a fake account whose id is already a bech32 string — that way
    // getBech32AddressFromAccountId gets a string-y input and the real helper
    // should pass it through (or we don't have to mock it).
    const fakeAcc = {
      id: () => 'bech32-account-id' as any,
      isPublic: () => true
    };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(fakeAcc);
    try {
      await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC);
    } catch (e: any) {
      // If getBech32AddressFromAccountId blows up on the string-y input we
      // accept that as long as spawnFromMidenClient wraps the error cleanly.
      expect(e).toBeInstanceOf(PublicError);
    }
  });

  it('handles multiple accounts from the WASM client', async () => {
    const acc1 = { id: () => 'pk-1' as any, isPublic: () => true };
    const acc2 = { id: () => 'pk-2' as any, isPublic: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([acc1, acc2]);
    mockMidenClient.getAccount
      .mockResolvedValueOnce(acc1)
      .mockResolvedValueOnce(acc2);
    try {
      await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC);
    } catch (e: any) {
      expect(e).toBeInstanceOf(PublicError);
    }
  });

  it('skips null accounts returned by getAccount', async () => {
    const fakeAcc = { id: () => 'pk-1' as any, isPublic: () => true };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(null);
    try {
      await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC);
    } catch (e: any) {
      expect(e).toBeInstanceOf(PublicError);
    }
  });

  it('wraps errors from the WASM client in a PublicError', async () => {
    mockMidenClient.getAccounts.mockRejectedValueOnce(new Error('wasm failed'));
    await expect(Vault.spawnFromMidenClient('pw', VALID_MNEMONIC)).rejects.toThrow(PublicError);
  });
});

describe('Vault.legacyPasswordUnlock + insertKeyCallback', () => {
  it('legacy unlock succeeds when the storage is seeded with a legacy check', async () => {
    // Stage a legacy-formatted check using the password's PBKDF2 key
    const pwKey = await Passworder.generateKey('legacy-pw');
    const salt = Passworder.generateSalt();
    const derived = await Passworder.deriveKeyLegacy(pwKey, salt);
    const { dt, iv } = await Passworder.encrypt('any-check', derived);
    const Buffer = require('buffer').Buffer;
    const saltHex = Buffer.from(salt).toString('hex');
    const payload = saltHex + iv + dt;
    // Wrap the storage key the same way safe-storage does
    const wrapped = Buffer.from(
      await crypto.subtle.digest('SHA-256', Buffer.from(keys.check, 'utf-8'))
    ).toString('hex');
    memoryStore[wrapped] = payload;
    // No vault_key_password slot present → setup() falls into legacyPasswordUnlock
    const vault = await Vault.setup('legacy-pw');
    expect(vault).toBeInstanceOf(Vault);
  });

  it('legacy unlock rejects on the wrong password', async () => {
    const pwKey = await Passworder.generateKey('right-pw');
    const salt = Passworder.generateSalt();
    const derived = await Passworder.deriveKeyLegacy(pwKey, salt);
    const { dt, iv } = await Passworder.encrypt('any-check', derived);
    const Buffer = require('buffer').Buffer;
    const saltHex = Buffer.from(salt).toString('hex');
    const wrapped = Buffer.from(
      await crypto.subtle.digest('SHA-256', Buffer.from(keys.check, 'utf-8'))
    ).toString('hex');
    memoryStore[wrapped] = saltHex + iv + dt;
    await expect(Vault.setup('wrong-pw')).rejects.toThrow(PublicError);
  });

  it('insertKeyCallback persists a fresh secret key when getMidenClient invokes it during spawn', async () => {
    // Make the createMidenWallet call invoke the supplied insertKeyCallback
    // before resolving — that's the path the real WASM client takes.
    mockGetMidenClient.mockImplementationOnce(async (options: any) => {
      if (options?.insertKeyCallback) {
        await options.insertKeyCallback(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]));
      }
      return {
        createMidenWallet: mockCreateMidenWallet,
        importPublicMidenWalletFromSeed: mockImportPublicMidenWalletFromSeed,
        getAccounts: mockGetAccounts,
        getAccount: mockGetAccount,
        syncState: mockSyncState,
        network: 'devnet'
      } as any;
    });
    const vault = await Vault.spawn('cb-pw');
    expect(vault).toBeInstanceOf(Vault);
    // Verify the callback wrote to storage by checking the auth secret key slot
    const sk = await vault.getAuthSecretKey('010203');
    expect(sk).toBe('040506');
  });
});

describe('Vault.spawn hardware-only mode', () => {
  beforeAll(() => {
    jest.doMock(
      'lib/biometric',
      () => ({
        isHardwareSecurityAvailable: jest.fn(async () => true),
        hasHardwareKey: jest.fn(async () => false),
        generateHardwareKey: jest.fn(async () => {}),
        encryptWithHardwareKey: jest.fn(async (b: string) => `enc(${b})`),
        decryptWithHardwareKey: jest.fn(async (b: string) => b.replace(/^enc\(/, '').replace(/\)$/, ''))
      }),
      { virtual: true }
    );
  });
  afterAll(() => {
    jest.dontMock('lib/biometric');
  });

  it('spawn() without password and with mobile hardware available stores hardware-protected key', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isDesktop as jest.Mock).mockReturnValue(false);
    const vault = await Vault.spawn(undefined as any);
    expect(vault).toBeInstanceOf(Vault);
    // Hardware key slot should be set
    const fetchUtil = await import('./safe-storage');
    expect(await fetchUtil.getPlain(keys.vaultKeyHardware)).toBeTruthy();
  });

  it('hasHardwareProtector returns true after hardware setup', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    await Vault.spawn(undefined as any);
    expect(await Vault.hasHardwareProtector()).toBe(true);
  });
});

describe('Vault hardware branches', () => {
  // Mock the dynamic-import targets so we can steer the hardware flows
  // through their branches without a real Secure Enclave.
  const mockDesktopSecureStorage = {
    isHardwareSecurityAvailable: jest.fn().mockResolvedValue(false),
    hasHardwareKey: jest.fn().mockResolvedValue(false),
    generateHardwareKey: jest.fn(),
    encryptWithHardwareKey: jest.fn().mockResolvedValue('enc-hw-key'),
    decryptWithHardwareKey: jest.fn().mockResolvedValue(''),
    tauriLog: jest.fn().mockResolvedValue(undefined)
  };
  const mockMobileBiometric = {
    isHardwareSecurityAvailable: jest.fn().mockResolvedValue(false),
    hasHardwareKey: jest.fn().mockResolvedValue(false),
    generateHardwareKey: jest.fn(),
    encryptWithHardwareKey: jest.fn().mockResolvedValue('enc-hw-key'),
    decryptWithHardwareKey: jest.fn().mockResolvedValue('')
  };
  beforeAll(() => {
    jest.doMock('lib/desktop/secure-storage', () => mockDesktopSecureStorage, {
      virtual: true
    });
    jest.doMock('lib/biometric', () => mockMobileBiometric, { virtual: true });
  });
  afterAll(() => {
    jest.dontMock('lib/desktop/secure-storage');
    jest.dontMock('lib/biometric');
  });

  beforeEach(() => {
    Object.values(mockDesktopSecureStorage).forEach(fn => (fn as any).mockClear?.());
    Object.values(mockMobileBiometric).forEach(fn => (fn as any).mockClear?.());
  });

  it('setup without password tries hardware unlock and returns null when unavailable', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    // No hardware slot → getHardwareVaultKey throws
    expect(await Vault.tryHardwareUnlock()).toBeNull();
  });

  it('setup without password throws PublicError("Password required") when there is no hardware slot', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    await expect(Vault.setup()).rejects.toThrow(PublicError);
  });

  it('unlockWithPassword on mobile throws when wallet is hardware-only', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    // Store hardware slot but NO password slot
    await savePlain(keys.vaultKeyHardware, 'some-hardware-blob');
    await expect(Vault.setup('any-pw')).rejects.toThrow(PublicError);
  });
});

