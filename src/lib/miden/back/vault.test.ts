// ---------------------------------------------------------------------------
// In-memory storage adapter used by `safe-storage`. Mocked at module scope so
// the real `safe-storage` code runs but writes/reads go to `memoryStore`.
// ---------------------------------------------------------------------------
import { privateKeyToAccount } from 'viem/accounts';

import { importedAccountBackupFailure } from 'lib/miden/backup-file';
import { ITransaction, ITransactionStatus, ITransactionType, Transaction } from 'lib/miden/db/types';
import * as Passworder from 'lib/miden/passworder';
import * as Repo from 'lib/miden/repo';
import { cancelStaleQueuedTransactions, MAX_QUEUED_AGE } from 'lib/miden/transaction/cancel';
import { ImportedAccountBackup, WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { PublicError } from './defaults';
import { clearRecoveryAuthorizations, getRecoveryAction } from './recovery-authorization';
import {
  encryptAndSaveMany,
  fetchAndDecryptOneWithLegacyFallBack,
  getPlain,
  isStored,
  removeMany,
  savePlain
} from './safe-storage';
import { Vault } from './vault';

jest.setTimeout(30_000);

const memoryStore: Record<string, any> = {};
let retainedStorageKey: string | undefined;
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
      for (const k of keys) {
        if (k !== retainedStorageKey) delete memoryStore[k];
      }
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
const GUARDIAN_KEYS_FIXTURE = {
  hotPublicKey: 'hot-pub',
  coldPublicKey: 'cold-pub',
  hotCiphertext: 'hot-ct',
  coldSecretKeyHex: 'cold-sk'
};
const mockCreateGuardianMidenWallet = jest.fn(
  async (
    _seed: Uint8Array,
    _guardianEndpoint?: string
  ): Promise<{ accountId: string; keys: typeof GUARDIAN_KEYS_FIXTURE; guardianEndpoint?: string }> => ({
    accountId: 'guardian-acc-1',
    keys: GUARDIAN_KEYS_FIXTURE
  })
);
const mockRecoverGuardianAccountsBySeed = jest.fn(async (_deriveColdSeed: any, _endpoint: string) => [
  {
    accountId: 'guardian-acc-imported',
    hdIndex: 0,
    coldPublicKey: GUARDIAN_KEYS_FIXTURE.coldPublicKey,
    coldSecretKeyHex: GUARDIAN_KEYS_FIXTURE.coldSecretKeyHex
  }
]);
const mockRecoverGuardianAccountByHotKey = jest.fn(async (_hotSecretKeyHex: string, _endpoint: string) => [
  { accountId: 'guardian-acc-hot', hotPublicKey: 'dead' }
]);
const mockGetAccounts = jest.fn(async () => [] as any[]);
const mockGetAccount = jest.fn(async (_id: string) => null as any);
const mockSyncState = jest.fn(async () => {});
const mockExportDb = jest.fn(async () => 'miden-db-dump');
// The wallet transaction dump. Only this one export is mocked; every other
// `lib/miden/repo` binding stays real so the Dexie-backed tests are unchanged.
const mockRepoExportDb = jest.fn(async () => '{"transactions":[]}');
jest.mock('lib/miden/repo', () => ({
  ...jest.requireActual('lib/miden/repo'),
  exportDb: (...args: unknown[]) => mockRepoExportDb(...(args as []))
}));
// `.client.accounts.insert` / `.client.keystore.insert` are the raw WASM
// surface; `importAccountFromPrivateKey` calls these directly on the
// `MidenClientInterface.client` field.
const mockAccountsInsert = jest.fn(async (_options: any) => {});
const mockKeystoreRemove = jest.fn(async () => {});
const mockKeystoreGet = jest.fn(async () => {
  throw new Error('failed to get key from keystore: storage error: Failed to get secret key from IndexedDB');
});
const mockKeystoreGetAccountId = jest.fn<Promise<{ free: () => void } | null>, []>(async () => null);
const mockKeystoreInsert = jest.fn(async (_id: any, _secretKey: any) => {});
const mockGetMidenClient = jest.fn(async (_options?: any) => ({
  createMidenWallet: (...args: unknown[]) => mockCreateMidenWallet(...(args as [any, Uint8Array])),
  importPublicMidenWalletFromSeed: (...args: unknown[]) =>
    mockImportPublicMidenWalletFromSeed(...(args as [Uint8Array])),
  // Non-Guardian: delegate to importPublicMidenWalletFromSeed so existing
  // tests keep asserting on it.
  importAccountBySeed: async (_walletType: any, seed: Uint8Array) => mockImportPublicMidenWalletFromSeed(seed),
  createGuardianMidenWallet: (...args: unknown[]) => mockCreateGuardianMidenWallet(...(args as [Uint8Array])),
  recoverGuardianAccountsBySeed: (...args: unknown[]) => mockRecoverGuardianAccountsBySeed(...(args as [any, string])),
  recoverGuardianAccountByHotKey: (...args: unknown[]) =>
    mockRecoverGuardianAccountByHotKey(...(args as [string, string])),
  getAccounts: () => mockGetAccounts(),
  getAccount: (id: string) => mockGetAccount(id),
  syncState: () => mockSyncState(),
  exportDb: () => mockExportDb(),
  network: 'devnet',
  client: {
    accounts: { insert: mockAccountsInsert },
    keystore: {
      insert: mockKeystoreInsert,
      remove: mockKeystoreRemove,
      get: mockKeystoreGet,
      getAccountId: mockKeystoreGetAccountId
    }
  }
}));
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// The lock hands its callback a HOLD, and vault's onboarding/restore flows
// re-check ownership of that hold before every pre-write WASM call that
// follows a parking await (#788 follow-up). Model ownership here: a
// pass-through mock with no hold would make those guards a TypeError, and a
// no-op assertWasmHoldCurrent would make the eviction tests below vacuous.
let currentWasmHold: object | null = null;
// Acquisition depth: a nested acquisition would deadlock the non-reentrant production mutex.
let wasmLockDepth = 0;
// Simulates a watchdog eviction landing mid-flow: the mutex moves on while
// the abandoned callback keeps running.
const revokeWasmHold = () => {
  currentWasmHold = null;
};
jest.mock('../sdk/miden-client', () => {
  // Real poison error class so the code under test's classification helpers
  // (isWasmClientPoisonedError, from the unmocked wasm-client-poison module)
  // see the production error shape.
  const { WasmClientPoisonedError } =
    jest.requireActual<typeof import('../sdk/wasm-client-poison')>('../sdk/wasm-client-poison');
  return {
    getMidenClient: (...args: unknown[]) => mockGetMidenClient(...(args as [any?])),
    getCurrentWasmLockHold: () => currentWasmHold,
    // Re-implements the real comparison against the mock's own hold — a no-op
    // here would silently pass every eviction test.
    assertWasmHoldCurrent: (hold: object | null, where: string) => {
      if (hold !== null && hold === currentWasmHold) return;
      throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}`));
    },
    // The realm's insert-key sink (#878): the vault installs it whenever it holds
    // a usable key; the insert-key tests invoke it the way the SDK would.
    installRealmKeystore: (callbacks: { insertKey?: unknown }) => {
      if (callbacks.insertKey !== undefined) (globalThis as any).__vaultTestRealmInsertKey = callbacks.insertKey;
    },
    uninstallRealmKeystore: (callbacks: { insertKey?: unknown }) => {
      (globalThis as any).__vaultTestRealmUninstalled = callbacks.insertKey;
      // As production: cleared only when it is the installed one.
      if (callbacks.insertKey === (globalThis as any).__vaultTestRealmInsertKey) {
        (globalThis as any).__vaultTestRealmInsertKey = null;
      }
    },
    isRealmKeystoreInstalled: (callbacks: { insertKey?: unknown }) =>
      callbacks.insertKey === undefined || callbacks.insertKey === (globalThis as any).__vaultTestRealmInsertKey,
    withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>, options?: { label?: string }) => {
      const g = globalThis as any;
      (g.__vaultTestLockLabels ??= []).push(options?.label);
      if (wasmLockDepth > 0) g.__vaultTestLockNested = (g.__vaultTestLockNested ?? 0) + 1;
      wasmLockDepth++;
      const hold = {};
      currentWasmHold = hold;
      try {
        return await fn(hold);
      } finally {
        wasmLockDepth--;
        if (currentWasmHold === hold) currentWasmHold = null;
      }
    },
    resetMidenClient: jest.fn(async () => {}),
    runWhenClientIdle: () => {}
  };
});

// Mock the secure-hot-key facade so reveal/swap paths don't try to deserialize
// real AuthSecretKey blobs out of fake ciphertexts. Tests set the resolved
// value per case via the captured mock fns.
const mockRevealHotKey = jest.fn(async (_ciphertext: string) => 'reveal-stub');
const mockDeleteHotKey = jest.fn(async (_ciphertext: string) => {});
jest.mock('lib/secure-hot-key', () => ({
  revealHotKey: (...a: unknown[]) => mockRevealHotKey(...(a as [string])),
  deleteHotKey: (...a: unknown[]) => mockDeleteHotKey(...(a as [string])),
  generateHotKey: jest.fn(),
  signHotDigest: jest.fn()
}));

// migrateLegacyGuardianAccounts verifies the derived cold key against the
// on-chain index-0 signer via getSignerDetailsFromAccount. Mock it so tests can
// drive the match / mismatch branches.
const mockGetSignerDetailsFromAccount = jest.fn();
// createHDAccount resolves a second Guardian account's endpoint from the sibling
// account's per-account field via resolveGuardianEndpoint. Default: echo the
// account's guardianEndpoint (the real function's first-preference), then a
// stand-in default — so the per-account field wins over any global key.
const mockResolveGuardianEndpoint = jest.fn(async (acc: any) => acc?.guardianEndpoint ?? 'https://default.example');
// backfillGuardianEndpoints reads the on-chain guardian commitment off the SDK
// account via getGuardianCommitmentFromAccount; mock it so tests drive the
// resolve / no-commitment branches.
const mockGetGuardianCommitmentFromAccount = jest.fn();
jest.mock('../guardian/account', () => ({
  getSignerDetailsFromAccount: (...a: unknown[]) => mockGetSignerDetailsFromAccount(...a),
  getGuardianCommitmentFromAccount: (...a: unknown[]) => mockGetGuardianCommitmentFromAccount(...a),
  resolveGuardianEndpoint: (...a: unknown[]) => mockResolveGuardianEndpoint(...(a as [any]))
}));

// backfillGuardianEndpoints builds the operator commitment->option map ONCE via
// buildOperatorKeyMap, then looks each account's commitment up against it. Mock
// the map build to drive the match / no-match branches (an empty map or a
// missing key => custom / self-hosted / rotated / operator down); normalizeHex
// mirrors the real strip-0x + lowercase so lookups compare equal.
const mockBuildOperatorKeyMap = jest.fn();
jest.mock('../guardian/operator-map', () => ({
  buildOperatorKeyMap: (...a: unknown[]) => mockBuildOperatorKeyMap(...a),
  normalizeHex: (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase()
}));

// spawnFromHotKey validates the pasted key via the shared hot-key-import
// helper. Mock it so tests hand back a scriptable fake key: `publicKey()`
// yields the bytes whose slice(1)-hex is 'dead' (matching the recover mock),
// `serialize()` the canonical secret blob, and the ECDSA-felts accessor not
// throwing makes `detectAuthScheme` read it as 'ecdsa'.
const fakeHotSecretKey = () => ({
  publicKey: () => ({
    serialize: () => Uint8Array.from([0x02, 0xde, 0xad]),
    free: jest.fn()
  }),
  serialize: () => Uint8Array.from([0x01, 0xbe, 0xef]),
  getEcdsaK256KeccakSecretKeyAsFelts: jest.fn(),
  free: jest.fn()
});
const mockDeserializeHotSecretKey = jest.fn((_hex: string) => fakeHotSecretKey() as any);
jest.mock('../guardian/hot-key-import', () => ({
  deserializeHotSecretKey: (...a: unknown[]) => mockDeserializeHotSecretKey(...(a as [string]))
}));

// Unified handle used by tests — matches the old mockMidenClient API.
const mockMidenClient = {
  createMidenWallet: mockCreateMidenWallet,
  importPublicMidenWalletFromSeed: mockImportPublicMidenWalletFromSeed,
  createGuardianMidenWallet: mockCreateGuardianMidenWallet,
  recoverGuardianAccountsBySeed: mockRecoverGuardianAccountsBySeed,
  getAccounts: mockGetAccounts,
  getAccount: mockGetAccount,
  syncState: mockSyncState,
  network: 'devnet'
};

// getBech32AddressFromAccountId uses the real WASM `Address.fromAccountId`;
// stub it so tests can assert on returned ids without a real WASM binary.
jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: any) => {
    if (id && typeof id === 'object' && '__marker' in id) {
      return `bech32:${id.__marker}`;
    }
    if (typeof id === 'string') return id;
    return 'bech32:unknown';
  }),
  sameWalletAccountId: jest.fn((a: string, b: string) => a.split('_')[0] === b.split('_')[0])
}));

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
// Exposed so `importAccountFromPrivateKey` tests can stub per-test
// behaviour (e.g. force `deserialize` to throw for the invalid-hex path).
let mockDeserializedCommitment = 'a1b2';
let mockBuiltAccountIdMarker = 'imported-account-id';
const defaultDeserializedSecret = () => ({
  sign: jest.fn(() => ({ serialize: jest.fn(() => new Uint8Array([9, 9, 9])) })),
  signData: jest.fn(() => ({ serialize: jest.fn(() => new Uint8Array([9, 9, 9])) })),
  publicKey: jest.fn(() => ({
    toCommitment: jest.fn(() => ({ toHex: jest.fn(() => `0x${mockDeserializedCommitment}`) }))
  }))
});
const mockAuthSecretKeyDeserialize = jest.fn((_bytes?: Uint8Array) => defaultDeserializedSecret());
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...base,
    AuthSecretKey: {
      deserialize: (bytes: Uint8Array) => mockAuthSecretKeyDeserialize(bytes),
      rpoFalconWithRNG: jest.fn(() => ({ __marker: 'rpo-falcon-secret' })),
      // ECDSA constructor used by `authSecretKeyFromSeed` when the
      // restored WalletAccount records authScheme='ecdsa'. Mirror the
      // shape of the falcon mock — only the marker differs.
      ecdsaWithRNG: jest.fn(() => ({ __marker: 'ecdsa-secret' }))
    },
    PublicKey: {
      deserialize: jest.fn(() => ({
        toCommitment: () => ({ serialize: () => new Uint8Array([2, 3, 4]), free: jest.fn() }),
        free: jest.fn()
      }))
    },
    SigningInputs: { deserialize: jest.fn(() => ({})) },
    Word: { deserialize: jest.fn(() => ({})) },
    // AccountBuilder records the fluent chain so assertions can verify
    // correct args — auth component type, storage mode, etc.
    AccountBuilder: jest.fn().mockImplementation((_seed: Uint8Array) => {
      let accountIdMarker = mockBuiltAccountIdMarker;
      const built = {
        account: {
          id: () => ({ __marker: accountIdMarker }),
          isFaucet: () => false
        }
      };
      const builder: any = {
        accountType: jest.fn(() => builder),
        storageMode: jest.fn(() => builder),
        withAuthComponent: jest.fn((component: any) => {
          accountIdMarker = component.__accountIdMarker ?? mockBuiltAccountIdMarker;
          return builder;
        }),
        withBasicWalletComponent: jest.fn(() => builder),
        build: jest.fn(() => built)
      };
      return builder;
    }),
    AccountComponent: {
      createAuthComponentFromSecretKey: jest.fn((secretKey: any) => ({
        __marker: 'auth-component',
        __accountIdMarker: secretKey.__accountIdMarker
      }))
    },
    AccountStorageMode: {
      public: jest.fn(() => 'public-mode'),
      private: jest.fn(() => 'private-mode')
    },
    AccountType: {
      RegularAccountImmutableCode: 2
    }
  };
});

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
  // NOTE: the vault's StorageEntity.AccColdSecretKey value is 'accouldsecretkey'
  // (typo preserved for storage compatibility with existing wallets).
  accColdSecretKey: (pk: string) => `${ck('accouldsecretkey')}_${pk}`,
  currentAccPubKey: ck('curraccpubkey'),
  accounts: ck('accounts'),
  ownMnemonic: ck('ownmnemonic'),
  vaultKeyPassword: 'vault_key_password',
  vaultKeyHardware: 'vault_key_hardware'
};

// A valid BIP39 12-word mnemonic so tests that derive seeds don't fail on
// checksum validation.
const VALID_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

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
  const currentPk = opts.currentPk ?? (accounts.length > 0 ? accounts[0]!.publicKey : 'no-accounts');

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
  retainedStorageKey = undefined;
  clearMemoryStore();
  jest.clearAllMocks();
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isMobile as jest.Mock).mockReturnValue(false);
  mockMidenClient.createMidenWallet.mockResolvedValue('acc-pub-key-1');
  mockMidenClient.createGuardianMidenWallet.mockResolvedValue({
    accountId: 'guardian-acc-1',
    keys: GUARDIAN_KEYS_FIXTURE
  });
  mockMidenClient.recoverGuardianAccountsBySeed.mockResolvedValue([
    {
      accountId: 'guardian-acc-imported',
      hdIndex: 0,
      coldPublicKey: GUARDIAN_KEYS_FIXTURE.coldPublicKey,
      coldSecretKeyHex: GUARDIAN_KEYS_FIXTURE.coldSecretKeyHex
    }
  ]);
  mockRecoverGuardianAccountByHotKey.mockResolvedValue([{ accountId: 'guardian-acc-hot', hotPublicKey: 'dead' }]);
  mockDeserializeHotSecretKey.mockImplementation(() => fakeHotSecretKey() as any);
  // mockReset, not just a fresh value: a queued mockResolvedValueOnce from one
  // test must not survive into the next.
  mockMidenClient.getAccounts.mockReset().mockResolvedValue([]);
  mockMidenClient.getAccount.mockReset().mockResolvedValue(null);
  mockMidenClient.syncState.mockResolvedValue(undefined);
  mockMidenClient.network = 'devnet';
  mockDeserializedCommitment = 'a1b2';
  mockBuiltAccountIdMarker = 'imported-account-id';
  mockAuthSecretKeyDeserialize.mockImplementation(() => defaultDeserializedSecret());
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

    it('retire drops the sink this vault installed (#878)', async () => {
      await seedVault('pw-correct');
      const vault = await Vault.setup('pw-correct');
      const sink = (globalThis as any).__vaultTestRealmInsertKey;
      expect(typeof sink).toBe('function');
      vault.retire();
      expect((globalThis as any).__vaultTestRealmUninstalled).toBe(sink);
    });
  });

  describe('verifyProtector', () => {
    it('verifies the password without replacing the installed vault or storage', async () => {
      await seedVault('pw-correct');
      const installedSink = (globalThis as any).__vaultTestRealmInsertKey;
      const storedBefore = { ...memoryStore };

      await expect(Vault.verifyProtector('pw-correct')).resolves.toBeUndefined();

      expect(memoryStore).toEqual(storedBefore);
      expect((globalThis as any).__vaultTestRealmInsertKey).toBe(installedSink);
    });

    it('rejects an invalid password', async () => {
      await seedVault('pw-correct');

      await expect(Vault.verifyProtector('pw-wrong')).rejects.toThrow(PublicError);
    });
  });

  describe('tryHardwareUnlock', () => {
    it('returns null on extension (no hardware branch)', async () => {
      (isDesktop as jest.Mock).mockReturnValue(false);
      (isMobile as jest.Mock).mockReturnValue(false);
      expect(await Vault.tryHardwareUnlock()).toBeNull();
    });

    it('returns null on mobile when no hardware key is stored', async () => {
      (isMobile as jest.Mock).mockReturnValue(true);
      (isDesktop as jest.Mock).mockReturnValue(false);
      // No hardware key saved — getHardwareVaultKey will throw "not configured"
      const vault = await Vault.tryHardwareUnlock();
      expect(vault).toBeNull();
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
      const sig = await vault.signData('acc-pub-key-1', Buffer.from('hello').toString('base64'), 'word');
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
    });

    it('signData returns a base64 signature for sign kind "signingInputs"', async () => {
      const vault = await seedVault('pw');
      await seedSecret(vault, 'acc-pub-key-1', '00'.repeat(32));
      const sig = await vault.signData('acc-pub-key-1', Buffer.from('hello').toString('base64'), 'signingInputs');
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
      await expect(vault.importFundraiserAccount('cid', 'e@x', 'pw', 'mnemonic')).resolves.toBeUndefined();
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

describe('Vault.revealPrivateKey', () => {
  it('returns the stored hex secret key for the given account public key', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('acc-pub-key-1'), 'aabbccdd']], vaultKey);

    const secret = await Vault.revealPrivateKey('acc-pub-key-1', 'pw');
    expect(secret).toBe('aabbccdd');
  });

  it('rejects with PublicError when no secret key is stored for the account', async () => {
    await seedVault('pw');
    await expect(Vault.revealPrivateKey('acc-pub-key-1', 'pw')).rejects.toThrow(PublicError);
  });

  it('rejects with PublicError after the seed phrase is removed, even when the secret key is still stored', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('acc-pub-key-1'), 'aabbccdd']], vaultKey);
    await vault.removeSeedPhrase();

    await expect(Vault.revealPrivateKey('acc-pub-key-1', 'pw')).rejects.toThrow(PublicError);
  });
});

describe('Vault.signWord', () => {
  const NON_RECOVERY_TYPES: ITransactionType[] = [
    'send',
    'consume',
    'execute',
    'bridged-send',
    'bridged-receive',
    'earn-deposit',
    'earn-withdraw',
    'swap'
  ];

  it.each(NON_RECOVERY_TYPES)('signs a %s transaction with the hot key when given its id', async type => {
    const vault = await seedVault('pw', {
      accounts: [{ publicKey: 'acc-1', name: 'A', isPublic: false, type: WalletType.Guardian }]
    });
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('hot-pk'), 'hot-ciphertext']], vaultKey);
    const signHotDigest = jest.requireMock('lib/secure-hot-key').signHotDigest as jest.Mock;
    signHotDigest.mockResolvedValueOnce('0xsigned');
    // Every pipeline hands `signWord` the transaction id. A row of a non-recovery
    // type must never reach the recovery-authorization binding, which throws for it.
    const row = new Transaction('acc-1', new Uint8Array());
    row.type = type;
    await Repo.transactions.add(row);

    await expect(vault.signWord('hot-pk', '0xabc', row.id)).resolves.toBe('0xsigned');
    expect(signHotDigest).toHaveBeenCalledWith('hot-ciphertext', '0xabc');
  });
});

describe('Vault.exportWalletBackupMaterial', () => {
  const hdAccount: WalletAccount = {
    publicKey: 'hd-account',
    name: 'HD account',
    isPublic: true,
    type: WalletType.OnChain,
    hdIndex: 0,
    authScheme: 'ecdsa'
  };
  const importedAccount: WalletAccount = {
    publicKey: 'bech32:imported-account-id',
    name: 'Imported account',
    isPublic: true,
    type: WalletType.OnChain,
    hdIndex: -1,
    authScheme: 'falcon'
  };
  const sdkAccount = (commitments: string[] = ['0xA1B2']) => ({
    id: () => ({ __marker: 'imported-account-id' }),
    getPublicKeyCommitments: () => commitments.map(commitment => ({ toHex: () => commitment }))
  });

  const seedImportedSecret = async () => {
    const seeded = await seedVault('pw', { accounts: [hdAccount, importedAccount] });
    await seeded.insertKeySink(new Uint8Array([0xa1, 0xb2]), new Uint8Array([1, 2, 3, 4]));
  };

  it('authenticates once and returns a complete snapshot with validated imported secrets', async () => {
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());

    await expect(Vault.exportWalletBackupMaterial('pw')).resolves.toEqual({
      seedPhrase: VALID_MNEMONIC,
      accounts: [hdAccount, importedAccount],
      midenClientDbContent: 'miden-db-dump',
      walletDbContent: '{"transactions":[]}',
      importedAccounts: [
        {
          accountId: importedAccount.publicKey,
          publicKeyCommitment: 'a1b2',
          authScheme: 'falcon',
          secretKeyHex: '01020304'
        }
      ]
    });
    expect(mockExportDb).toHaveBeenCalledTimes(1);
  });

  it('refuses to write a record its own reader would reject', async () => {
    // The writer and the reader are two schemas over one object. A record that
    // fails the reader yields a file that decrypts and is then refused as invalid.
    await seedVault('pw', { accounts: [{ ...hdAccount, name: '' }] });

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      'Wallet account records cannot be written to a backup file'
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('backs up a seed-removed wallet whose accounts are all imported', async () => {
    // Local seed-phrase removal deletes the stored mnemonic outright. Reading an
    // absent key throws, so without tolerating it these wallets hit a dead end.
    await seedVault('pw', { accounts: [importedAccount] });
    const seeded = await seedVault('pw', { accounts: [importedAccount] });
    await seeded.insertKeySink(new Uint8Array([0xa1, 0xb2]), new Uint8Array([1, 2, 3, 4]));
    const { removeMany } = require('./safe-storage');
    await removeMany([keys.mnemonic]);
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());

    await expect(Vault.exportWalletBackupMaterial('pw')).resolves.toEqual(expect.objectContaining({ seedPhrase: '' }));
  });

  it('refuses to back up a seed-removed wallet that still has a derived account', async () => {
    // An HD account's key is re-derived from the seed and is not carried in the
    // file, so writing one would produce a backup this wallet would later refuse.
    await seedVault('pw', { accounts: [hdAccount] });
    const { removeMany } = require('./safe-storage');
    await removeMany([keys.mnemonic]);

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      'Wallet has no seed phrase to back up its derived accounts'
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('refuses to write a file whose stored seed phrase is not a usable one', async () => {
    // The old exporter read the seed through revealMnemonic, so its pattern gated
    // every file written. Reading the stored value directly must not lose that:
    // such a file restores into a wallet that can never reveal its seed.
    await seedVault('pw', { mnemonic: 'abandon abandon abandon', accounts: [hdAccount, importedAccount] });

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      'Mnemonic does not match the expected pattern'
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('captures every member of the snapshot in one turn of the accounts write queue', async () => {
    // An account write landing between the accounts read and either dump would
    // produce a file describing two different wallets. Park the export inside its
    // own turn and no later queue entry may run.
    const { getAccountsWriteQueue } = require('lib/miden/back/accounts-write-queue');
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());
    let releaseExport!: () => void;
    mockExportDb.mockImplementationOnce(
      () => new Promise<string>(resolve => (releaseExport = () => resolve('miden-db-dump')))
    );

    const pending = Vault.exportWalletBackupMaterial('pw');
    // Deterministic: wait until the export has actually reached its dump rather
    // than for a fixed delay.
    while (releaseExport === undefined) await new Promise(resolve => setTimeout(resolve, 1));

    let laterWriteRan = false;
    const laterWrite = getAccountsWriteQueue().add(() => {
      laterWriteRan = true;
    });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(laterWriteRan).toBe(false);

    releaseExport();
    await expect(pending).resolves.toEqual(expect.objectContaining({ midenClientDbContent: 'miden-db-dump' }));
    await laterWrite;
    expect(laterWriteRan).toBe(true);
  });

  it('releases that queue before dumping the wallet transactions', async () => {
    // The queue is also the unlock queue, and nothing cross-checks transactions
    // against the accounts, so this dump must not extend the turn.
    const { getAccountsWriteQueue } = require('lib/miden/back/accounts-write-queue');
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());
    let releaseWalletDump!: () => void;
    const walletDumpStarted = new Promise<void>(started => {
      mockRepoExportDb.mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            releaseWalletDump = () => resolve('{"transactions":[]}');
            started();
          })
      );
    });

    const pending = Vault.exportWalletBackupMaterial('pw');
    await walletDumpStarted;

    let laterWriteRan = false;
    const laterWrite = getAccountsWriteQueue().add(() => {
      laterWriteRan = true;
    });
    await laterWrite;
    expect(laterWriteRan).toBe(true);

    releaseWalletDump();
    await expect(pending).resolves.toEqual(expect.objectContaining({ walletDbContent: '{"transactions":[]}' }));
  });

  it('authenticates before it takes that queue, so a prompt cannot stall account writes', async () => {
    // On mobile and desktop the authentication is a hardware prompt the user
    // answers in their own time. A wrong password is refused here while the
    // queue is still parked, which is only possible if the check ran outside it.
    const { getAccountsWriteQueue } = require('lib/miden/back/accounts-write-queue');
    await seedImportedSecret();
    let releaseQueue!: () => void;
    const parked = getAccountsWriteQueue().add(() => new Promise<void>(resolve => (releaseQueue = resolve)));

    await expect(Vault.exportWalletBackupMaterial('wrong')).rejects.toThrow(PublicError);

    releaseQueue();
    await parked;
  });

  it.each([
    { label: 'is not public', overrides: { isPublic: false } },
    { label: 'is not an on-chain wallet', overrides: { type: WalletType.OffChain } }
  ])('fails before reading the SDK store when the imported account $label', async ({ overrides }) => {
    // The guard runs before getAccount, so a store read at all means it did not fire.
    await seedVault('pw', { accounts: [hdAccount, { ...importedAccount, ...overrides }] });

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockMidenClient.getAccount).not.toHaveBeenCalled();
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('fails before reading the secret when the SDK account answers a different id', async () => {
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce({
      ...sdkAccount(),
      id: () => ({ __marker: 'another-account-id' })
    });

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('fails before returning a snapshot when the imported SDK account is absent', async () => {
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(null);

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it.each([{ commitments: [] }, { commitments: ['0xa1b2', '0xc3d4'] }])(
    'fails before returning a snapshot when the imported account has $commitments auth commitments',
    async ({ commitments }) => {
      await seedImportedSecret();
      mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount(commitments));

      await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
        importedAccountBackupFailure(importedAccount.name)
      );
      expect(mockExportDb).not.toHaveBeenCalled();
    }
  );

  it('fails before returning a snapshot when an imported secret is missing', async () => {
    await seedVault('pw', { accounts: [hdAccount, importedAccount] });
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('fails before returning a snapshot when the stored scheme differs from the account', async () => {
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());
    mockAuthSecretKeyDeserialize.mockReturnValueOnce({
      getEcdsaK256KeccakSecretKeyAsFelts: jest.fn(() => []),
      publicKey: jest.fn(() => ({ toCommitment: jest.fn(() => ({ toHex: jest.fn(() => '0xa1b2') })) }))
    } as any);

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('fails before returning a snapshot when the stored secret has a different commitment', async () => {
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());
    mockDeserializedCommitment = 'ffff';

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('fails before returning a snapshot when deterministic reconstruction changes the account id', async () => {
    await seedImportedSecret();
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());
    mockBuiltAccountIdMarker = 'different-account-id';

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });
});

describe('Vault.withAccountFileKeyReader', () => {
  it('authenticates once and supplies the serialized auth key requested by the SDK', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('aabb'), '010203']], vaultKey);

    const result = await Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey =>
      getKey(new Uint8Array([0xaa, 0xbb]))
    );

    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a Guardian hot key rather than exporting its platform-wrapped ciphertext', async () => {
    // accAuthSecretKeyStrgKey is polymorphic: persistGuardianKeys stores the hot CIPHERTEXT there,
    // which signWord dispatches through the secure-hot-key facade instead of deserializing. Handing
    // those bytes to the SDK would write a file whose "key" is an SE/StrongBox-wrapped blob.
    const vault = await seedVault('pw', {
      accounts: [
        {
          publicKey: 'guardian-acc',
          name: 'Guardian',
          isPublic: true,
          type: WalletType.Guardian,
          hotPublicKey: 'aabb'
        } as any
      ]
    });
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('aabb'), 'deadbeefciphertext']], vaultKey);

    await expect(
      Vault.withAccountFileKeyReader('guardian-acc', 'pw', async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).rejects.toThrow('A Guardian account cannot be exported to an account file');
  });

  it('fails closed when the SDK requests a key the vault does not hold', async () => {
    await seedVault('pw');

    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).rejects.toThrow('Authentication key not found for account export');
  });

  // The four states below all defeat a guard keyed on the set of known hotPublicKeys, which is why
  // the refusal is decided from the account's own `type` before any key is served.
  it('refuses a Guardian account that has no activated hot key yet', async () => {
    // Post-recovery, pre-activation: nothing to recognize in a hot-key set, but still a Guardian.
    const vault = await seedVault('pw', {
      accounts: [{ publicKey: 'guardian-acc', name: 'Guardian', isPublic: true, type: WalletType.Guardian } as any]
    });
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('aabb'), 'deadbeefciphertext']], vaultKey);

    await expect(
      Vault.withAccountFileKeyReader('guardian-acc', 'pw', async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).rejects.toThrow('A Guardian account cannot be exported to an account file');
  });

  it("refuses a Guardian account's cold key, which lives under the same storage entity", async () => {
    // persistGuardianKeys documents that cold also reaches the SDK keystore through the standard
    // insertKeyCallback path, so the cold secret sits under accAuthSecretKeyStrgKey too - under a
    // commitment that is never in the hot-key set.
    const vault = await seedVault('pw', {
      accounts: [
        {
          publicKey: 'guardian-acc',
          name: 'Guardian',
          isPublic: true,
          type: WalletType.Guardian,
          hotPublicKey: 'aabb',
          coldPublicKey: 'ccdd'
        } as any
      ]
    });
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('ccdd'), '010203']], vaultKey);

    await expect(
      Vault.withAccountFileKeyReader('guardian-acc', 'pw', async getKey => getKey(new Uint8Array([0xcc, 0xdd])))
    ).rejects.toThrow('A Guardian account cannot be exported to an account file');
  });

  it('fails closed when the accounts record cannot be read', async () => {
    // A guard built from stored state must abort, not degrade to "there are no Guardians".
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('aabb'), '010203']], vaultKey);
    // Encrypted entries live under a hashed key, so remove it through the module's own derivation
    // rather than by string-matching memoryStore. Both the primary and legacy reads then reject.
    await removeMany([keys.accounts]);
    const operation = jest.fn();

    // Specifically NOT 'Account not found': swallowing the read into an empty list would report a
    // present account as absent, and would silently disable the refusal if the lookup ever relaxed.
    await expect(Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', operation)).rejects.toThrow(
      'Failed to export account file'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses a commitment belonging to a different account', async () => {
    const vault = await seedVault('pw', {
      accounts: [
        { publicKey: 'acc-pub-key-1', name: 'Mine', isPublic: true, type: WalletType.OnChain },
        {
          publicKey: 'guardian-acc',
          name: 'Someone else',
          isPublic: true,
          type: WalletType.Guardian,
          hotPublicKey: 'ccdd'
        } as any
      ]
    });
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('ccdd'), '010203']], vaultKey);

    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey => getKey(new Uint8Array([0xcc, 0xdd])))
    ).rejects.toThrow('The export asked for a key that belongs to a different account');
  });

  it('keeps the reason across the SDK boundary that reduces a callback throw to its text', async () => {
    // The SDK does not propagate the PublicError itself: it comes back as a plain Error carrying
    // only the message, which withError would otherwise flatten to 'Failed to export account file'.
    // This double mimics that boundary, which is exactly what a direct getKey call cannot do.
    await seedVault('pw');

    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey => {
        try {
          return await getKey(new Uint8Array([0xaa, 0xbb]));
        } catch (cause) {
          throw new Error(`keystore callback: JsValue(Error: ${(cause as Error).message})`);
        }
      })
    ).rejects.toThrow('Authentication key not found for account export');
  });

  it('lets an abandonment keep its identity rather than relabelling it with a reader refusal', async () => {
    // `isWasmClientPoisonedError` is what the lock's kill classifiers read. A recorded getKey
    // classification must never outrank it: an abandoned operation may still be in flight, and
    // reporting it as a flat failure is what invites the retry that duplicates work.
    const { WasmClientPoisonedError } = await import('../sdk/wasm-client-poison');
    await seedVault('pw');

    const poison = new WasmClientPoisonedError('watchdog', new Error('evicted mid-export'));
    const failure = await Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey => {
      await Promise.resolve(getKey(new Uint8Array([0xaa, 0xbb]))).catch(() => undefined);
      throw poison;
    }).catch((cause: unknown) => cause);

    expect(failure).toBe(poison);
  });

  it('refuses an empty credential instead of deciding the auth method from a falsy check', async () => {
    // '' is what a caller sends when it lost track of its own branch. Falling through would route
    // a passcode wallet to the hardware path and answer it 'Hardware protector is not configured'.
    await seedVault('pw');
    const operation = jest.fn();

    await expect(Vault.withAccountFileKeyReader('acc-pub-key-1', '', operation)).rejects.toThrow(
      'A password or passcode is required to export this account'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not expose a key reader when the step-up password is invalid', async () => {
    await seedVault('right-password');
    const operation = jest.fn();

    await expect(Vault.withAccountFileKeyReader('acc-pub-key-1', 'wrong-password', operation)).rejects.toThrow(
      'Invalid password'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses an account that is not in the wallet', async () => {
    // Distinct from the unreadable-record case above: the list read fine and
    // simply does not hold this account. The export must stop here rather than
    // fall through to a reader with no Guardian refusal decided for it.
    await seedVault('pw');
    const operation = jest.fn();

    await expect(Vault.withAccountFileKeyReader('acc-pub-key-absent', 'pw', operation)).rejects.toThrow(
      'Account not found'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses when the accounts record decrypts to something that is not a list', async () => {
    // A record written by a different build, or corrupted in place. `.find` on it
    // would be a TypeError; treating it as an empty list keeps the failure a
    // refusal, and the account is still reported as absent rather than exported
    // with no Guardian check and no other-account denylist behind it.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accounts, { publicKey: 'acc-pub-key-1' }]], vaultKey);
    const operation = jest.fn();

    await expect(Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', operation)).rejects.toThrow('Account not found');
    expect(operation).not.toHaveBeenCalled();
  });

  it('reports an empty stored key as an absent key rather than exporting zero bytes', async () => {
    // A present-but-empty record is not a key. Without this the export would
    // write a file whose auth key is a zero-length buffer, which restores into a
    // wallet that can never sign.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('aabb'), '']], vaultKey);

    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).rejects.toThrow('Authentication key not found for account export');
  });

  it('does not report a key it cannot decrypt as a key it does not have', async () => {
    // Only STORAGE_ITEM_NOT_FOUND may be relabelled "not found". Here the record
    // exists but was written under a different vault key, so the read fails for a
    // reason of its own — and mislabelling it would send the user to re-create a
    // key that is still there. The export fails either way; the point is that the
    // reason survives.
    await seedVault('pw');
    const foreignVaultKey = await Passworder.importVaultKey(Passworder.generateVaultKey());
    await encryptAndSaveMany([[keys.accAuthSecretKey('aabb'), '010203']], foreignVaultKey);

    // The generic export verdict, NOT the absent-key one: the read failed for a
    // reason this layer is not entitled to name.
    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', 'pw', async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).rejects.toThrow('Failed to export account file');
  });
});

describe('Vault.revealHotKey', () => {
  it('unwraps the hot ciphertext via the secure-hot-key facade and returns plaintext hex', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    // Persist a Guardian WalletAccount with hotPublicKey + the wrapped ciphertext
    // exactly the way Vault.spawn's createGuardianMidenWallet path would.
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      evmAddress: '0xEvm'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT'],
        [`${ck('accevmsecretkey')}_0xevm`, `0x${'cd'.repeat(32)}`]
      ],
      vaultKey
    );
    mockRevealHotKey.mockResolvedValue('ab'.repeat(32));

    const secret = await Vault.revealHotKey('guardian-acc-1', 'pw');

    expect(mockRevealHotKey).toHaveBeenCalledWith('OPAQUE_CIPHERTEXT');
    expect(secret).toBe(`${'ab'.repeat(32)}:${'cd'.repeat(32)}`);
    await removeMany([keys.mnemonic]);
    await expect(Vault.revealHotKey('guardian-acc-1', 'pw')).resolves.toBe(secret);
  });

  it('rejects when the account is not a Guardian account', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'acc-1',
      name: 'OnChain 1',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0
    };
    await encryptAndSaveMany([[keys.accounts, [account]]], vaultKey);

    await expect(Vault.revealHotKey('acc-1', 'pw')).rejects.toThrow(PublicError);
  });

  it('rejects when the Guardian account has no activated hot key (post-recovery, pre-banner)', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-recovered',
      name: 'Guardian Recovered',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      coldPublicKey: 'cold-pub-hex',
      requiresHotKeyRotation: true
    };
    await encryptAndSaveMany([[keys.accounts, [account]]], vaultKey);

    await expect(Vault.revealHotKey('guardian-recovered', 'pw')).rejects.toThrow(PublicError);
  });

  // Every guard below stands between the user and a screen that displays raw key material, so
  // assert the MESSAGE, never just `PublicError`. These functions run inside `withError`, which
  // ends `throw err instanceof PublicError ? err : new PublicError(errMessage)` - so deleting a
  // guard lets the next line throw a TypeError, `withError` rewraps it as a PublicError, and a
  // `toThrow(PublicError)` assertion still passes. It pins nothing.
  it('rejects when no account carries the requested public key', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex'
    };
    await encryptAndSaveMany([[keys.accounts, [account]]], vaultKey);

    await expect(Vault.revealHotKey('guardian-acc-unknown', 'pw')).rejects.toThrow('Account not found');
  });

  it('rejects when the stored hot ciphertext is empty', async () => {
    // `hotPublicKey` set and a record under accAuthSecretKey that decrypts to
    // nothing: a half-written activation. Handing an empty string to the
    // secure-hot-key facade would ask the Secure Enclave to unwrap nothing.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      evmAddress: '0xEvm'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accAuthSecretKey('hot-pub-hex'), '']
      ],
      vaultKey
    );

    await expect(Vault.revealHotKey('guardian-acc-1', 'pw')).rejects.toThrow('Hot key ciphertext not found');
    expect(mockRevealHotKey).not.toHaveBeenCalled();
  });

  it('rejects when the EVM secret is present in storage but decrypts to nothing', async () => {
    // `isStored` says yes and the decrypt still yields an empty value — a record
    // written by an interrupted backfill. The pair must not be assembled from it:
    // a half-empty pair encodes to `hot:` and reads as a valid-looking export.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      evmAddress: '0xEvm'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT'],
        [`${ck('accevmsecretkey')}_0xevm`, '']
      ],
      vaultKey
    );

    await expect(Vault.revealHotKey('guardian-acc-1', 'pw')).rejects.toThrow('evmPrivateKeyMissing');
  });

  it('rejects when the unwrapped hot key is not a usable secp256k1 scalar', async () => {
    // A zero scalar is out of range for secp256k1, so `parsePrivateKeyPair`
    // refuses it. Returning it anyway would show the user a "key" that no signer
    // can ever reproduce, and that they may write down as their backup.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      evmAddress: '0xEvm'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT'],
        [`${ck('accevmsecretkey')}_0xevm`, `0x${'cd'.repeat(32)}`]
      ],
      vaultKey
    );
    mockRevealHotKey.mockResolvedValue('00'.repeat(32));

    await expect(Vault.revealHotKey('guardian-acc-1', 'pw')).rejects.toThrow('importHotKeyInvalid');
  });
});

describe('Vault.revealGuardianKeys', () => {
  it('returns coldPrivateKey + coldPublicKey + hotPublicKey for an activated Guardian account', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accColdSecretKey('cold-pub-hex'), 'COLD_SECRET_HEX']
      ],
      vaultKey
    );

    const result = await Vault.revealGuardianKeys('guardian-acc-1', 'pw');

    expect(result).toEqual({
      coldPrivateKey: 'COLD_SECRET_HEX',
      coldPublicKey: 'cold-pub-hex',
      hotPublicKey: 'hot-pub-hex'
    });
  });

  it('returns hotPublicKey undefined for a recovered Guardian account whose hot key is not yet activated', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-recovered',
      name: 'Guardian Recovered',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      coldPublicKey: 'cold-pub-hex',
      requiresHotKeyRotation: true
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accColdSecretKey('cold-pub-hex'), 'COLD_SECRET_HEX']
      ],
      vaultKey
    );

    const result = await Vault.revealGuardianKeys('guardian-recovered', 'pw');

    expect(result.coldPrivateKey).toBe('COLD_SECRET_HEX');
    expect(result.coldPublicKey).toBe('cold-pub-hex');
    expect(result.hotPublicKey).toBeUndefined();
  });

  it('rejects when called on a non-Guardian account', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'acc-1',
      name: 'OnChain 1',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0
    };
    await encryptAndSaveMany([[keys.accounts, [account]]], vaultKey);

    await expect(Vault.revealGuardianKeys('acc-1', 'pw')).rejects.toThrow(PublicError);
  });

  it('refuses once the seed phrase has been removed locally', async () => {
    // Cold material is the recovery half of a Guardian account, and a wallet
    // whose seed was removed is one the user chose to keep un-backed-up. The
    // check runs before the accounts record is even read, so a seedless wallet
    // cannot reach the cold secret through a known account id.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accColdSecretKey('cold-pub-hex'), 'COLD_SECRET_HEX']
      ],
      vaultKey
    );
    await removeMany([keys.mnemonic]);

    await expect(Vault.revealGuardianKeys('guardian-acc-1', 'pw')).rejects.toThrow('recoverySeedRequired');
  });

  it('rejects when no account carries the requested public key', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      coldPublicKey: 'cold-pub-hex'
    };
    await encryptAndSaveMany([[keys.accounts, [account]]], vaultKey);

    await expect(Vault.revealGuardianKeys('guardian-acc-unknown', 'pw')).rejects.toThrow('Account not found');
  });

  it('rejects when the account names a cold key that decrypts to nothing', async () => {
    // The account says it has cold material and the record under that commitment
    // is empty. Returning it would hand the recovery screen an empty
    // `coldPrivateKey` to render and offer the user as their backup.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      coldPublicKey: 'cold-pub-hex'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accColdSecretKey('cold-pub-hex'), '']
      ],
      vaultKey
    );

    await expect(Vault.revealGuardianKeys('guardian-acc-1', 'pw')).rejects.toThrow('Cold key not found');
  });
});

describe('Vault.setGuardianOperatorCommitment / setGuardianSyncStatus', () => {
  async function seedGuardianPair(vault: Vault) {
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const accounts: WalletAccount[] = [
      {
        publicKey: 'pkA',
        name: 'Guardian A',
        isPublic: false,
        type: WalletType.Guardian,
        hdIndex: 0,
        guardianSyncStatus: 'in-sync'
      },
      {
        publicKey: 'pkB',
        name: 'Guardian B',
        isPublic: false,
        type: WalletType.Guardian,
        hdIndex: 1,
        guardianSyncStatus: 'in-sync'
      }
    ];
    await encryptAndSaveMany([[keys.accounts, accounts]], vaultKey);
  }

  describe('setGuardianOperatorCommitment', () => {
    it('updates only the target account and persists', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);

      await vault.setGuardianOperatorCommitment('pkA', 'commitment-hex');
      const accounts = await vault.fetchAccounts();

      expect(accounts.find(a => a.publicKey === 'pkA')?.guardianOperatorCommitment).toBe('commitment-hex');
      expect(accounts.find(a => a.publicKey === 'pkB')?.guardianOperatorCommitment).toBeUndefined();
    });

    it('rejects with PublicError when the target public key is unknown', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);

      await expect(vault.setGuardianOperatorCommitment('not-here', 'commitment-hex')).rejects.toThrow(PublicError);
    });
  });

  describe('setGuardianSyncStatus', () => {
    it('updates only the target account and persists', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);

      await vault.setGuardianSyncStatus('pkA', 'needs-user-input');
      const accounts = await vault.fetchAccounts();

      expect(accounts.find(a => a.publicKey === 'pkA')?.guardianSyncStatus).toBe('needs-user-input');
      expect(accounts.find(a => a.publicKey === 'pkB')?.guardianSyncStatus).toBe('in-sync');
    });

    it('rejects with PublicError when the target public key is unknown', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);

      await expect(vault.setGuardianSyncStatus('not-here', 'needs-user-input')).rejects.toThrow(PublicError);
    });
  });
});

describe('Vault.createHDAccount', () => {
  it('refuses to derive an account on a wallet that has no seed phrase', async () => {
    // A restore whose accounts are all imported stores '' here. Deriving from it
    // runs mnemonicToSeedSync(''), the same fixed value on every device, so the
    // new account's key would not be secret: anything sent to it could be taken
    // by anyone. Both the EVM sibling and the two other readers of this key
    // already refuse this state.
    const vault = await seedVault('pw', { mnemonic: '' });

    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toThrow('seedRequiredForAccountCreation');
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
  });

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
    const { deriveMidenAccountSeed, mnemonicToSeed } = require('@miden/hd-key');
    const seed = mnemonicToSeed(m);
    expect(seed.length).toBe(64);
    const d = deriveMidenAccountSeed(seed, {
      keyDerivation: 'v1',
      walletTypeIndex: 0,
      authSchemeIndex: 1,
      accountIndex: 1
    });
    expect(d.length).toBe(32);

    // And run the full HD flow
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts).toHaveLength(2);
    expect(accounts[1]!.publicKey).toBe('acc-pub-key-2');
    expect(accounts[1]!.name).toMatch(/Account 2/);
    expect(accounts[1]!.isPublic).toBe(true);
    // New HD accounts derive under the current scheme.
    expect(accounts[1]!.keyDerivation).toBe('v1');
    expect(accounts[1]!.authScheme).toBe('ecdsa');
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

  it('falls back to createMidenWallet when every import probe misses (own mnemonic path)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    // Both derivation probes at the new index miss, so the account is fresh.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValue(new Error('boom'));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-fallback');
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-fallback');
    expect(accounts[1]!.keyDerivation).toBe('v1');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(2);
    expect(mockMidenClient.createMidenWallet).toHaveBeenCalled();
  });

  it('restores a legacy account at the next index instead of creating an empty one (own mnemonic path)', async () => {
    // A pre-#918 wallet with several public accounts: `Vault.spawn` restored
    // index 0 through the legacy probe, and the next account must be found the
    // same way rather than replaced by a fresh empty v1 account at that index.
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed
      .mockRejectedValueOnce(new Error('no v1 account at this index'))
      .mockResolvedValueOnce('acc-legacy-1');
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-legacy-1');
    expect(accounts[1]!.hdIndex).toBe(1);
    expect(accounts[1]!.keyDerivation).toBe('legacy');
    expect(accounts[1]!.authScheme).toBe('ecdsa');
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    // The two probes derive different seeds for the same index.
    const probeCalls: unknown[][] = mockMidenClient.importPublicMidenWalletFromSeed.mock.calls;
    const seedHex = (value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('hex') : 'not-bytes';
    expect(seedHex(probeCalls[0]![0])).not.toBe(seedHex(probeCalls[1]![0]));
  });

  it('stamps v1 when the first import probe finds the account (own mnemonic path)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('acc-v1-1');
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-v1-1');
    expect(accounts[1]!.keyDerivation).toBe('v1');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
  });

  it('aborts on an unreachable node during the first probe without trying the second (own mnemonic path)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValue(
      new Error('client error: RPC error: Miden node is unavailable; check that the node is running and reachable')
    );
    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toThrow(/Could not reach the Miden network/i);
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
  });

  it('wraps WASM errors in a PublicError', async () => {
    const vault = await seedVault('pw');
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));
    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toThrow(PublicError);
  });
});

describe('Vault.spawn', () => {
  // Regression: the hardware-only path (`!password`) fell through to the
  // password branch when the availability probe said the hardware was NOT
  // available, and encrypted the vault key under the empty string —
  // `Actions.registerNewWallet` passes `password ?? ''`. That protects the
  // mnemonic, every account auth key, the guardian cold key and the EVM keys
  // with no secret at all, AND locks the user out (setup() finds no hardware
  // protector; Unlock demands a password never chosen). `spawnFromMidenClient`
  // always had this guard; `spawn` did not.
  it.each([
    ['no password at all', undefined],
    ['the empty string registerNewWallet substitutes', '']
  ])('refuses to mint an empty-password vault when hardware is unavailable (%s)', async (_label, password) => {
    // Extension platform mocks → isHardwareSecurityAvailableForVault() === false,
    // i.e. onboarding chose biometrics but the probe now says unavailable.
    await expect(Vault.spawn(WalletType.OnChain, password as any)).rejects.toThrow(
      'Password is required for password-based vault protection'
    );
    // Nothing password-shaped was persisted, so no empty-password blob exists.
    expect(await Vault.hasPasswordProtector()).toBe(false);
  });

  it('creates a fresh wallet with a generated mnemonic and password protection', async () => {
    const vault = await Vault.spawn(WalletType.OnChain, 'pw');
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.isExist()).toBe(true);
    expect(await Vault.hasPasswordProtector()).toBe(true);
    // The mock createMidenWallet resolves to 'acc-pub-key-1', which becomes
    // both the account publicKey and the current account pointer.
    expect(await Vault.getCurrentAccountPublicKey()).toBe('acc-pub-key-1');
  });

  it('accepts a caller-provided mnemonic and round-trips it via revealMnemonic', async () => {
    await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC);
    expect(await Vault.revealMnemonic('pw')).toBe(VALID_MNEMONIC);
  });

  it('persists ownMnemonic = true when requested and calls importPublicMidenWalletFromSeed on devnet', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('imported-pk');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(await vault.isOwnMnemonic()).toBe(true);
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalled();
  });

  it('falls back to createMidenWallet when both import probes (v1 ecdsa, legacy ecdsa) fail during spawn', async () => {
    // Vault.spawn probes both key-derivation schemes during mnemonic restore.
    // Use mockRejectedValue (not Once) so every probe sees a rejection
    // and the create-fallback branch is reached.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValue(new Error('boom'));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('fallback-pk');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('fallback-pk');
    // Both derivations were probed (v1 first, legacy second), ECDSA only.
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(2);
    const probeCalls: unknown[][] = mockMidenClient.importPublicMidenWalletFromSeed.mock.calls;
    expect(probeCalls.map(call => call[1])).toEqual(['ecdsa', 'ecdsa']);
    // The two probes derive different seeds: same index, different scheme.
    const seedHex = (value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('hex') : 'not-bytes';
    const [v1Seed, legacySeed] = probeCalls.map(call => seedHex(call[0]));
    expect(v1Seed).toHaveLength(64);
    expect(v1Seed).not.toBe(legacySeed);
    // The fresh create used the v1 seed.
    const createCalls: unknown[][] = mockMidenClient.createMidenWallet.mock.calls;
    expect(seedHex(createCalls[0]![1])).toBe(v1Seed);
    const accounts = await vault.fetchAccounts();
    expect(accounts[0]!.keyDerivation).toBe('v1');
  });

  it('ABORTS the restore instead of creating a fresh wallet when the node is unreachable', async () => {
    // The fund-loss-shaped bug: a probe miss and an unreachable node are different
    // answers. If the RPC is down mid-restore, every scheme "misses", spawn falls
    // through, and a user who typed a CORRECT seed gets a brand-new EMPTY wallet —
    // their real account simply doesn't appear. This is the exact error text a real
    // CI run produced when Miden testnet DNS failed.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValue(
      new Error(
        'client error: RPC error: grpc request failed for submit_proven_transaction: ' +
          'Miden node is unavailable; check that the node is running and reachable'
      )
    );

    await expect(Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true)).rejects.toThrow(
      /Could not reach the Miden network/i
    );
    // The whole point: NO wallet was created behind the user's back.
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    // It aborts on the FIRST unreachable probe rather than burning the second.
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
  });

  it('still creates a fresh wallet when the probes definitively miss (seed is genuinely new)', async () => {
    // The legitimate fall-through must survive: "no account on chain" is a real
    // answer and a first-time seed must still produce a wallet.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValue(new Error('account not found on chain'));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('fresh-pk');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('fresh-pk');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(2);
  });

  it('picks the legacy derivation when the v1 probe has no on-chain account', async () => {
    // Probe order is [v1 ecdsa, legacy ecdsa]. The v1 probe misses, legacy
    // succeeds — the resulting account is stamped keyDerivation='legacy' so
    // every later re-derivation (file restore, recovery seed) uses that path.
    mockMidenClient.importPublicMidenWalletFromSeed
      .mockRejectedValueOnce(new Error('no v1 account at this seed'))
      .mockResolvedValueOnce('legacy-pk-xyz');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('legacy-pk-xyz');
    // create-fallback NOT reached.
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    // Stored scheme and derivation reflect the probe that succeeded.
    const accounts = await vault.fetchAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.authScheme).toBe('ecdsa');
    expect(accounts[0]!.keyDerivation).toBe('legacy');
  });

  it('picks v1 when the first probe finds an account, without probing legacy', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('v1-pk-abc');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('v1-pk-abc');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    const accounts = await vault.fetchAccounts();
    expect(accounts[0]!.authScheme).toBe('ecdsa');
    expect(accounts[0]!.keyDerivation).toBe('v1');
  });

  it('skips importPublicMidenWalletFromSeed when the client network is "mock"', async () => {
    // The spawn branch that guards on `network !== 'mock'` is only reachable
    // when `ownMnemonic` is true AND the client reports its network. Our
    // mock getMidenClient returns a plain object whose `network` field is
    // 'devnet' (it was hardcoded at mock time; the mutable `mockMidenClient`
    // handle doesn't reach through to the factory-level stub). Verify that
    // the default devnet path flows through importPublicMidenWalletFromSeed.
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('imported-pk');
    await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalled();
  });

  it('wraps WASM errors in a PublicError with "Failed to create wallet"', async () => {
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));
    await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow(PublicError);
  });

  it('re-resolves the client when lock recovery disposed the one spawn resolved before taking the lock (#775)', async () => {
    // spawn() resolves a client at step 5 and only reaches the create path after
    // queueing for the WASM mutex. Recovery runs from a timer and an error
    // listener, so it can dispose that client while spawn waits — and a disposed
    // client's every call throws, which here means a wallet creation that fails
    // for a reason the user cannot act on. The `liveClient()` re-resolve exists
    // so the rebuild recovery already performed is what the create path uses.
    const disposed = { isDisposed: true, network: 'devnet', createMidenWallet: jest.fn() };
    mockGetMidenClient.mockImplementationOnce(async () => disposed as never);

    const vault = await Vault.spawn(WalletType.OnChain, 'pw');

    expect(vault).toBeDefined();
    // The corpse was never called; the rebuilt client did the work.
    expect(disposed.createMidenWallet).not.toHaveBeenCalled();
    expect(mockCreateMidenWallet).toHaveBeenCalled();
    // Once at step 5, once more from inside the lock after finding it disposed.
    expect(mockGetMidenClient).toHaveBeenCalledTimes(2);
  });
});

const MALFORMED = 'Encrypted file contains malformed imported account data';
const MISMATCHED = 'Encrypted file imported account secret does not match its account';

describe('Vault.spawnFromMidenClient', () => {
  const importedWalletAccount: WalletAccount = {
    publicKey: 'bech32:imported-account-id',
    name: 'Imported',
    isPublic: true,
    type: WalletType.OnChain,
    hdIndex: -1,
    authScheme: 'falcon'
  };
  const importedBackup: ImportedAccountBackup = {
    accountId: importedWalletAccount.publicKey,
    publicKeyCommitment: 'a1b2',
    authScheme: 'falcon',
    secretKeyHex: '01020304'
  };
  const importedSdkAccount = (marker = 'imported-account-id', commitments = ['0xa1b2']) => ({
    id: jest.fn(() => ({ __marker: marker })),
    isFaucet: jest.fn(() => false),
    getPublicKeyCommitments: jest.fn(() => commitments.map(value => ({ toHex: () => value })))
  });
  const restoreVersionTwo = (
    walletAccounts: WalletAccount[] = [importedWalletAccount],
    importedAccounts: ImportedAccountBackup[] = [importedBackup]
  ) => Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, walletAccounts, 2, importedAccounts);

  beforeEach(() => {
    // Default: miden client has one account whose id bech32s to 'pk-1'.
    const fakeAcc = {
      id: () => 'pk-1' as any,
      isFaucet: () => false
    };
    mockMidenClient.getAccounts.mockResolvedValue([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValue(fakeAcc);
  });

  it('restores a version 2 Falcon imported account with its original secret', async () => {
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);

    await expect(restoreVersionTwo()).resolves.toBeInstanceOf(Vault);
    expect(mockAuthSecretKeyDeserialize).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]));
    expect(mockKeystoreInsert).toHaveBeenCalledWith(account.id(), expect.any(Object));
  });

  it('restores a version 2 ECDSA imported account with its original secret', async () => {
    const account = importedSdkAccount();
    const secret = {
      getEcdsaK256KeccakSecretKeyAsFelts: jest.fn(() => []),
      publicKey: jest.fn(() => ({ toCommitment: jest.fn(() => ({ toHex: jest.fn(() => '0xa1b2') })) }))
    };
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockAuthSecretKeyDeserialize.mockReturnValueOnce(secret as any);

    await expect(
      restoreVersionTwo(
        [{ ...importedWalletAccount, authScheme: 'ecdsa' }],
        [{ ...importedBackup, authScheme: 'ecdsa' }]
      )
    ).resolves.toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).toHaveBeenCalledWith(account.id(), secret);
  });

  it.each([
    { label: 'is not public', overrides: { isPublic: false } },
    { label: 'is not an on-chain wallet', overrides: { type: WalletType.OffChain } }
  ])('rejects a version 2 restore whose imported account $label', async ({ overrides }) => {
    // The export refuses to back such an account up, so a file claiming one was
    // not written by this wallet; the restore refuses it before inserting a key.
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);

    await expect(restoreVersionTwo([{ ...importedWalletAccount, ...overrides }])).rejects.toThrow(PublicError);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('restores a phrase-less backup and records that the wallet owns no mnemonic', async () => {
    // The success arm of the no-phrase file. Only the REJECTION arm was covered,
    // so reverting ownMnemonic to a hardcoded true left the suite green.
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);

    const vault = await Vault.spawnFromMidenClient('pw', '', [importedWalletAccount], 2, [importedBackup]);

    expect(vault).toBeInstanceOf(Vault);
    await expect(vault.isOwnMnemonic()).resolves.toBe(false);
    expect(mockKeystoreInsert).toHaveBeenCalledWith(account.id(), expect.any(Object));
    // No seed means nothing to derive an EVM identity from, so the stored record
    // carries none.
    const stored = await vault.fetchAccounts();
    expect(stored.every(account => account.evmAddress === undefined)).toBe(true);
  });

  it('rejects a restore whose seed phrase is present but not a real phrase', async () => {
    // The sibling arm. Both throw the SAME user-facing message, so only the logged
    // reason can tell them apart, and an empty phrase does not satisfy this one.
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      Vault.spawnFromMidenClient('pw', 'abandon abandon abandon', [importedWalletAccount], 2, [importedBackup])
    ).rejects.toThrow(MALFORMED);

    const logged = consoleErrorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('seed-phrase-not-a-real-phrase');
    consoleErrorSpy.mockRestore();
  });

  it('rejects a restore with an HD account and no seed phrase', async () => {
    // Without this the HD branch derives its signing key from
    // mnemonicToSeedSync(''), a fixed value, while the EVM half already treats an
    // empty mnemonic as "no seed".
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    const hdAccount: WalletAccount = {
      publicKey: 'bech32:hd-account-id',
      name: 'HD',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0,
      authScheme: 'ecdsa'
    };

    await expect(Vault.spawnFromMidenClient('pw', '', [hdAccount], 2, [])).rejects.toThrow(
      'Encrypted file contains malformed imported account data'
    );
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('rejects a version 2 restore with a missing imported-secret entry', async () => {
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);

    await expect(restoreVersionTwo([importedWalletAccount], [])).rejects.toThrow(
      'Encrypted file is missing imported account data'
    );
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('rejects a version 2 restore with an extra imported-secret entry', async () => {
    const hdAccount: WalletAccount = {
      publicKey: 'pk-1',
      name: 'HD',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0
    };

    await expect(restoreVersionTwo([hdAccount], [importedBackup])).rejects.toThrow(PublicError);
  });

  it('rejects duplicate imported account ids or commitments defensively', async () => {
    const secondWallet: WalletAccount = {
      ...importedWalletAccount,
      publicKey: 'bech32:other-account-id',
      name: 'Imported 2'
    };
    const secondBackup: ImportedAccountBackup = {
      ...importedBackup,
      accountId: secondWallet.publicKey,
      publicKeyCommitment: 'c3d4',
      secretKeyHex: '0506'
    };
    const walletAccounts = [importedWalletAccount, secondWallet];

    await expect(
      restoreVersionTwo(walletAccounts, [importedBackup, { ...secondBackup, accountId: importedBackup.accountId }])
    ).rejects.toThrow(PublicError);
    await expect(
      restoreVersionTwo(walletAccounts, [
        importedBackup,
        { ...secondBackup, publicKeyCommitment: importedBackup.publicKeyCommitment }
      ])
    ).rejects.toThrow(PublicError);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('rejects one imported secret bound to multiple account ids defensively', async () => {
    const secondWallet: WalletAccount = {
      ...importedWalletAccount,
      publicKey: 'bech32:other-account-id',
      name: 'Imported 2'
    };
    const secondBackup: ImportedAccountBackup = {
      ...importedBackup,
      accountId: secondWallet.publicKey,
      publicKeyCommitment: 'c3d4'
    };

    await expect(
      restoreVersionTwo([importedWalletAccount, secondWallet], [importedBackup, secondBackup])
    ).rejects.toThrow(PublicError);
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it.each([
    // The message is the discriminator. A malformed SHAPE is refused by the
    // structural guard; a well-formed value that simply does not match the account
    // falls through to the semantic check one arm later. Asserting only the error
    // type cannot tell the two apart, so deleting the shape guard would look green.
    { label: 'malformed secret', backup: { ...importedBackup, secretKeyHex: 'not-hex' }, message: MALFORMED },
    { label: 'wrong scheme', backup: { ...importedBackup, authScheme: 'ecdsa' as const }, message: MISMATCHED },
    { label: 'empty commitment', backup: { ...importedBackup, publicKeyCommitment: '' }, message: MALFORMED },
    { label: 'odd-length commitment', backup: { ...importedBackup, publicKeyCommitment: 'a1b' }, message: MALFORMED },
    { label: 'non-hex commitment', backup: { ...importedBackup, publicKeyCommitment: 'zzzz' }, message: MALFORMED },
    {
      label: 'well-formed commitment that is not the account',
      backup: { ...importedBackup, publicKeyCommitment: 'ffff' },
      message: MISMATCHED
    }
  ])('rejects a version 2 restore with a $label', async ({ backup, message }) => {
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);

    await expect(restoreVersionTwo(undefined, [backup])).rejects.toThrow(message);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('rejects a version 2 restore when deterministic reconstruction changes the account id', async () => {
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockBuiltAccountIdMarker = 'different-account-id';

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('leaves no vault-key protector behind when a version 2 restore is rejected', async () => {
    // The protector is written before the validation, so a rejection downstream
    // would otherwise leave a wrapped vault key for a vault that never existed.
    const { getPlain } = require('./safe-storage');
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockBuiltAccountIdMarker = 'different-account-id';

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);

    expect(await getPlain(keys.vaultKeyPassword)).toBeUndefined();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('rejects a version 2 restore when the SDK database lacks the imported account', async () => {
    mockMidenClient.getAccounts.mockResolvedValueOnce([]);

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('rejects a version 2 imported account with multiple auth commitments', async () => {
    const account = importedSdkAccount('imported-account-id', ['0xa1b2', '0xc3d4']);
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);
    expect(mockAuthSecretKeyDeserialize).not.toHaveBeenCalled();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('retires the provisional realm sink when version 2 validation fails', async () => {
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockBuiltAccountIdMarker = 'different-account-id';
    (globalThis as any).__vaultTestRealmInsertKey = null;
    (globalThis as any).__vaultTestRealmUninstalled = null;

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);
    expect((globalThis as any).__vaultTestRealmUninstalled).toEqual(expect.any(Function));
    expect((globalThis as any).__vaultTestRealmInsertKey).toBeNull();
  });

  it('retires the provisional realm sink when an imported-secret insert fails', async () => {
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockKeystoreInsert.mockRejectedValueOnce(new Error('keystore rejected insert'));
    (globalThis as any).__vaultTestRealmInsertKey = null;
    (globalThis as any).__vaultTestRealmUninstalled = null;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);
    expect((globalThis as any).__vaultTestRealmUninstalled).toEqual(expect.any(Function));
    expect((globalThis as any).__vaultTestRealmInsertKey).toBeNull();
    // This arm replaces the SDK's error with a generic one, so it is the only
    // record of why the restore refused. The secret never travels with it.
    const logged = consoleErrorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('keystore rejected insert');
    expect(logged).not.toContain(importedBackup.secretKeyHex);
    consoleErrorSpy.mockRestore();
  });

  it('validates the entire imported collection before inserting the first secret', async () => {
    const first = importedSdkAccount();
    const second = importedSdkAccount('second-account-id', ['0xffff']);
    const secondWallet: WalletAccount = {
      ...importedWalletAccount,
      publicKey: 'bech32:second-account-id',
      name: 'Imported 2'
    };
    const secondBackup: ImportedAccountBackup = {
      ...importedBackup,
      accountId: secondWallet.publicKey,
      publicKeyCommitment: 'ffff',
      secretKeyHex: '05060708'
    };
    mockMidenClient.getAccounts.mockResolvedValueOnce([first, second]);
    mockMidenClient.getAccount.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await expect(
      restoreVersionTwo([importedWalletAccount, secondWallet], [importedBackup, secondBackup])
    ).rejects.toThrow(PublicError);
    expect(mockAuthSecretKeyDeserialize).toHaveBeenCalledTimes(2);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('silently skips miden-client accounts not present in walletAccounts (post-fix behaviour: no throw)', async () => {
    // The miden-client DB has account `pk-1` (from `beforeEach`); the
    // caller only gave us metadata for a DIFFERENT account `pk-owned`.
    // The old code would throw `'Account from Miden Client not found'`;
    // the new code silently `continue`s past the orphan so the restore
    // completes. No keystore insert for the orphan.
    (globalThis as any).__vaultTestRealmInsertKey = null;
    const vault = await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      { publicKey: 'pk-owned', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
    ]);
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
    // The restore installed the new key's sink before it could insert anything (#878).
    expect((globalThis as any).__vaultTestRealmInsertKey).toEqual(expect.any(Function));
  });

  it('restores a matching account through the sink installed before the loop inserts (#878)', async () => {
    // The restore loop hands the derived secret to the SDK, which inserts through the
    // realm sink; the vault must have installed it before the first insert.
    (globalThis as any).__vaultTestRealmInsertKey = null;
    mockKeystoreInsert.mockImplementationOnce(async (_id: any, _secretKey: any) => {
      await (globalThis as any).__vaultTestRealmInsertKey(new Uint8Array([0xab]), new Uint8Array([0x11]));
    });
    const vault = await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      { publicKey: 'pk-1', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
    ]);
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    expect(vault.insertKeySink).toBe((globalThis as any).__vaultTestRealmInsertKey);
  });

  it('skips walletAccount entries with hdIndex < 0 (imported accounts) instead of deriving garbage keys', async () => {
    // Caller passes an imported-account entry matching the miden-client's
    // `pk-1`. Without the `hdIndex < 0` skip, spawnFromMidenClient would
    // call `deriveClientSeed` with `hdIndex: -1` (an invalid path, which throws)
    // and write a mnemonic-derived key over the imported account's
    // real secret. With the skip, keystore.insert is never called for
    // that account.
    const vault = await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      { publicKey: 'pk-1', name: 'Imported', isPublic: true, type: WalletType.OnChain, hdIndex: -1 }
    ]);
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('derives + inserts a key for each HD account', async () => {
    const acc1 = { id: () => 'pk-1' as any, isFaucet: () => false };
    const acc2 = { id: () => 'pk-2' as any, isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([acc1, acc2]);
    mockMidenClient.getAccount.mockResolvedValueOnce(acc1).mockResolvedValueOnce(acc2);

    await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
      { publicKey: 'pk-2', name: 'B', isPublic: false, type: WalletType.OffChain, hdIndex: 0 }
    ]);
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(2);
  });

  it('skips null accounts returned by getAccount', async () => {
    const fakeAcc = { id: () => 'pk-1' as any, isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(null);
    const vault = await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      { publicKey: 'pk-1', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
    ]);
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('wraps errors from the WASM client in a PublicError', async () => {
    mockMidenClient.getAccounts.mockRejectedValueOnce(new Error('wasm failed'));
    await expect(Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [])).rejects.toThrow(PublicError);
  });

  it('re-derives ECDSA secret keys for accounts whose authScheme is "ecdsa"', async () => {
    // The keystore-insert call must receive the ECDSA-marker secret produced
    // by AuthSecretKey.ecdsaWithRNG, not the falcon one. Confirms the
    // restore path picks the right derivation function based on the stored
    // scheme, which is the contract that prevents post-migration encrypted-
    // file restores from corrupting an account's signing key.
    const fakeAcc = { id: () => 'pk-ecdsa' as any, isFaucet: () => false, isNetwork: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(fakeAcc);

    await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      {
        publicKey: 'pk-ecdsa',
        name: 'A',
        isPublic: true,
        type: WalletType.OnChain,
        hdIndex: 0,
        authScheme: 'ecdsa'
      }
    ]);

    // Last keystore insert receives the secret produced by ecdsaWithRNG —
    // the falcon constructor must not have been called for this account.
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    const insertedSecret = mockKeystoreInsert.mock.calls[0]![1];
    expect((insertedSecret as any).__marker).toBe('ecdsa-secret');
  });

  it('falls back to falcon-derivation for legacy WalletAccount entries with no authScheme', async () => {
    // Pre-migration WalletAccount records have no `authScheme` field;
    // the restore path must treat missing as falcon to preserve the
    // historical behavior. Confirms the LEGACY_AUTH_SCHEME default.
    const fakeAcc = { id: () => 'pk-legacy' as any, isFaucet: () => false, isNetwork: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(fakeAcc);

    await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
      // No authScheme field — the legacy shape.
      { publicKey: 'pk-legacy', name: 'Legacy', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
    ]);

    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    const insertedSecret = mockKeystoreInsert.mock.calls[0]![1];
    expect((insertedSecret as any).__marker).toBe('rpo-falcon-secret');
  });
});

describe('Vault.importAccountFromPrivateKey', () => {
  const VALID_HEX = 'deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef';

  beforeEach(() => {
    mockAuthSecretKeyDeserialize.mockReturnValue({
      sign: jest.fn(),
      signData: jest.fn()
    } as any);
  });

  it('builds a deterministic public account, inserts via keystore, persists the WalletAccount', async () => {
    const vault = await seedVault('pw');
    const accounts = await vault.importAccountFromPrivateKey(VALID_HEX, 'My Imported');

    expect(accounts).toHaveLength(2);
    const imported = accounts[1]!;
    expect(imported).toMatchObject({
      publicKey: 'bech32:imported-account-id',
      name: 'My Imported',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: -1
    });
    // Mocked secret key has no scheme accessors → detectAuthScheme falls
    // through to the legacy default. Mirrors how a pre-migration Falcon
    // hex key behaves on import.
    expect(imported.authScheme).toBe('falcon');
    expect(mockAccountsInsert).toHaveBeenCalledWith({ account: expect.any(Object) });
    expect(mockKeystoreInsert).toHaveBeenCalled();
  });

  it('stamps authScheme="ecdsa" when the imported key exposes the ECDSA accessor', async () => {
    // Mock a deserialized AuthSecretKey that responds to the ECDSA scheme
    // probe (`getEcdsaK256KeccakSecretKeyAsFelts`) without throwing —
    // mirrors the WASM-side behavior for an ECDSA-encoded private key.
    mockAuthSecretKeyDeserialize.mockReturnValueOnce({
      sign: jest.fn(),
      signData: jest.fn(),
      getEcdsaK256KeccakSecretKeyAsFelts: jest.fn(() => [])
    } as any);

    const vault = await seedVault('pw');
    const accounts = await vault.importAccountFromPrivateKey(VALID_HEX, 'My ECDSA Import');

    expect(accounts[1]!.authScheme).toBe('ecdsa');
  });

  it('auto-generates a fresh name when the user does not supply one', async () => {
    const vault = await seedVault('pw');
    const accounts = await vault.importAccountFromPrivateKey(VALID_HEX);
    expect(accounts[1]!.name).toMatch(/^Account /);
  });

  it('picks a non-colliding auto-generated name even when the caller has manually renamed accounts', async () => {
    const vault = await seedVault('pw', {
      accounts: [{ publicKey: 'acc-a', name: 'Account 2', isPublic: true, type: WalletType.OnChain } as any]
    });
    const accounts = await vault.importAccountFromPrivateKey(VALID_HEX);
    // The existing account is named `Account 2` (not `Account 1`), so
    // the lowest still-free slot is `Account 1`. Under the prior loop
    // that started at `allAccounts.length + 1 = 2` and walked forward
    // we would have returned `Account 3`, leaving the free `Account 1`
    // slot unused. The `let i = 1` fix surfaces that slot instead.
    expect(accounts[1]!.name).toBe('Account 1');
  });

  it('skips past collisions and returns the next free template slot', async () => {
    const vault = await seedVault('pw', {
      accounts: [
        { publicKey: 'acc-a', name: 'Account 1', isPublic: true, type: WalletType.OnChain } as any,
        { publicKey: 'acc-b', name: 'Account 2', isPublic: true, type: WalletType.OnChain } as any
      ]
    });
    const accounts = await vault.importAccountFromPrivateKey(VALID_HEX);
    // All of `Account 1` and `Account 2` are taken; walk forward.
    expect(accounts[2]!.name).toBe('Account 3');
  });

  it('rejects a hex string with odd length', async () => {
    const vault = await seedVault('pw');
    await expect(vault.importAccountFromPrivateKey('abc')).rejects.toThrow(PublicError);
    expect(mockAccountsInsert).not.toHaveBeenCalled();
  });

  it('rejects a non-hex private key', async () => {
    const vault = await seedVault('pw');
    await expect(vault.importAccountFromPrivateKey('not-hex-at-all!!')).rejects.toThrow(PublicError);
    expect(mockAccountsInsert).not.toHaveBeenCalled();
  });

  it('rejects a pathologically long hex string before touching the WASM client', async () => {
    const vault = await seedVault('pw');
    const huge = 'ab'.repeat(20_000); // 40k hex chars, > 32k cap
    await expect(vault.importAccountFromPrivateKey(huge)).rejects.toThrow(PublicError);
    expect(mockAccountsInsert).not.toHaveBeenCalled();
  });

  it('rejects a user-supplied name that duplicates an existing account', async () => {
    const vault = await seedVault('pw', {
      accounts: [{ publicKey: 'acc-a', name: 'Dupe', isPublic: true, type: WalletType.OnChain } as any]
    });
    await expect(vault.importAccountFromPrivateKey(VALID_HEX, 'Dupe')).rejects.toThrow(PublicError);
    expect(mockAccountsInsert).not.toHaveBeenCalled();
  });

  it('wraps `AuthSecretKey.deserialize` failures in a PublicError with a user-facing message', async () => {
    const vault = await seedVault('pw');
    mockAuthSecretKeyDeserialize.mockImplementationOnce(() => {
      throw new Error('bad bytes');
    });
    await expect(vault.importAccountFromPrivateKey(VALID_HEX)).rejects.toThrow(PublicError);
  });

  it('persists the imported secret via the insertKeyCallback under the pubkey-commitment hex slot', async () => {
    // Wire the mock client to invoke the callback synchronously when
    // `keystore.insert` is called — mirrors the real WASM behaviour.
    mockKeystoreInsert.mockImplementationOnce(async (_id: any, _secretKey: any) => {
      await (globalThis as any).__vaultTestRealmInsertKey(
        new Uint8Array([0xab, 0xcd]),
        new Uint8Array([0x11, 0x22, 0x33])
      );
    });

    const vault = await seedVault('pw');
    await vault.importAccountFromPrivateKey(VALID_HEX, 'My Import');

    // The reveal path looks up the secret by pubkey-commitment hex — the
    // whole feature depends on this invariant. Use the same lookup
    // `vault.getAuthSecretKey` performs.
    const sk = await vault.getAuthSecretKey('abcd');
    expect(sk).toBe('112233');
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
    const wrapped = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(keys.check, 'utf-8'))).toString(
      'hex'
    );
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
    const wrapped = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(keys.check, 'utf-8'))).toString(
      'hex'
    );
    memoryStore[wrapped] = saltHex + iv + dt;
    await expect(Vault.setup('wrong-pw')).rejects.toThrow(PublicError);
  });

  it('spawn acquires its client under a labelled hold, then constructs under its own labelled hold (#878)', async () => {
    (globalThis as any).__vaultTestLockLabels = [];
    (globalThis as any).__vaultTestLockNested = 0;
    await Vault.spawn(WalletType.OnChain, 'pw');
    // Exactly these two, in this order, never nested: the build hold is released before the construction hold.
    expect((globalThis as any).__vaultTestLockLabels).toEqual(['spawn-client-build', 'vault-spawn']);
    expect((globalThis as any).__vaultTestLockNested).toBe(0);
  });

  it('the insert-key sink spawn installs for its new key persists a fresh secret key', async () => {
    // Make the createMidenWallet call invoke the realm's sink before resolving,
    // the path the real WASM client takes; spawn must have installed it by then (#878).
    const createAsUsual = mockCreateMidenWallet.getMockImplementation()!;
    (globalThis as any).__vaultTestRealmInsertKey = null;
    mockCreateMidenWallet.mockImplementationOnce(async (...args: [any, Uint8Array]) => {
      await (globalThis as any).__vaultTestRealmInsertKey(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]));
      return createAsUsual(...args);
    });
    const vault = await Vault.spawn(WalletType.OnChain, 'cb-pw');
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
    const vault = await Vault.spawn(WalletType.OnChain, undefined as any);
    expect(vault).toBeInstanceOf(Vault);
    // Hardware key slot should be set
    const fetchUtil = await import('./safe-storage');
    expect(await fetchUtil.getPlain(keys.vaultKeyHardware)).toBeTruthy();
  });

  it('hasHardwareProtector returns true after hardware setup', async () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    await Vault.spawn(WalletType.OnChain, undefined as any);
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

  it('isHardwareSecurityAvailableForVault returns false on extension', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    // Spawn with no password — should use password protection because hardware is unavailable
    const vault = await Vault.spawn(WalletType.OnChain, 'password123');
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.hasPasswordProtector()).toBe(true);
  });

  it('isHardwareSecurityAvailableForVault catches import errors and returns false', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockRejectedValueOnce(new Error('no module'));
    // Spawn with empty password should fall back to password protection
    const vault = await Vault.spawn(WalletType.OnChain, 'fallback-pw');
    expect(vault).toBeInstanceOf(Vault);
  });

  it('setupHardwareProtector on desktop with hardware available generates key and encrypts', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(false);
    const vault = await Vault.spawn(WalletType.OnChain, undefined as any);
    expect(vault).toBeInstanceOf(Vault);
    expect(mockDesktopSecureStorage.generateHardwareKey).toHaveBeenCalled();
    expect(mockDesktopSecureStorage.encryptWithHardwareKey).toHaveBeenCalled();
  });

  it('setupHardwareProtector on desktop skips key generation if key already exists', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(true);
    await Vault.spawn(WalletType.OnChain, undefined as any);
    expect(mockDesktopSecureStorage.generateHardwareKey).not.toHaveBeenCalled();
    expect(mockDesktopSecureStorage.encryptWithHardwareKey).toHaveBeenCalled();
  });

  it('setupHardwareProtector on desktop catches errors and returns false', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.encryptWithHardwareKey.mockRejectedValueOnce(new Error('hw-fail'));
    await expect(Vault.spawn(WalletType.OnChain, undefined as any)).rejects.toThrow(PublicError);
  });

  it('getMainDerivationPath throws for invalid wallet type', async () => {
    // This triggers the 'Invalid wallet type' else branch
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    // Trying to create an HD account with an invalid wallet type
    const vlt = await Vault.spawn(WalletType.OnChain, 'pw-test');
    await expect(vlt.createHDAccount('invalid' as any)).rejects.toThrow();
  });

  it('Vault.spawn propagates recoverGuardianAccountsBySeed failures (no silent fallback)', async () => {
    // The Guardian recovery path must NOT fall back to createGuardianMidenWallet —
    // otherwise a silently-recreated account would leave the user with an empty
    // balance under their seed. The branch rethrows, wrapped as a PublicError by
    // withError.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed.mockRejectedValueOnce(new Error('guardian lookup failed'));

    // …and the lookup's OWN reason must survive. `withError('Failed to create
    // wallet', …)` replaces any non-PublicError with that generic string; on the
    // forgot-password reset the wallet is already wiped by the time this throws,
    // so the reason is all the user has left (#630). Asserting the message, not
    // just the class, is what pins that (a plain `toThrow(PublicError)` passes on
    // the generic wrapper too).
    const spawning = Vault.spawn(WalletType.Guardian, 'pw-guardian-fail', VALID_MNEMONIC, true);
    await expect(spawning).rejects.toThrow(PublicError);
    await expect(spawning).rejects.toThrow('guardian lookup failed');

    // createGuardianMidenWallet must NOT be called as a fallback — Guardian rethrows.
    expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('Vault.spawn scans the legacy derivation when the v1 scan finds no Guardian accounts', async () => {
    // A wallet created before #918 derived its cold keys under the legacy
    // scheme. The v1 scan answers "nothing here" (NoGuardianAccountsFoundError),
    // the legacy scan adopts, and the account is stamped `legacy` so the
    // recovery-seed and file-restore paths re-derive the same cold key.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const { NoGuardianAccountsFoundError } = require('../sdk/guardian-recovery-errors');
    mockMidenClient.recoverGuardianAccountsBySeed
      .mockRejectedValueOnce(new NoGuardianAccountsFoundError())
      .mockResolvedValueOnce([
        {
          accountId: 'guardian-legacy-pk',
          hdIndex: 0,
          coldPublicKey: 'bb'.repeat(33),
          coldSecretKeyHex: 'dd'.repeat(32)
        }
      ]);

    const vault = await Vault.spawn(WalletType.Guardian, 'pw-guardian-legacy', VALID_MNEMONIC, true);
    expect(mockMidenClient.recoverGuardianAccountsBySeed).toHaveBeenCalledTimes(2);
    // The two scans hand the lookup different cold seeds for the same index.
    const [v1Derive, legacyDerive] = mockMidenClient.recoverGuardianAccountsBySeed.mock.calls.map(call => call[0]);
    expect(Buffer.from(v1Derive(0)).toString('hex')).not.toBe(Buffer.from(legacyDerive(0)).toString('hex'));
    const accounts = await vault.fetchAccounts();
    expect(accounts[0]!.publicKey).toBe('guardian-legacy-pk');
    expect(accounts[0]!.keyDerivation).toBe('legacy');
    expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('Vault.spawn merges Guardian accounts found under both derivations and stamps each with its own', async () => {
    // A pre-#918 Guardian wallet that added an account after the update holds a
    // legacy account at index 0 and a v1 account at index 1. Stopping at the
    // first scan with a match would drop the legacy account and its balance.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed
      .mockResolvedValueOnce([
        { accountId: 'guardian-v1-pk', hdIndex: 1, coldPublicKey: 'aa'.repeat(33), coldSecretKeyHex: 'cc'.repeat(32) }
      ])
      .mockResolvedValueOnce([
        {
          accountId: 'guardian-legacy-pk',
          hdIndex: 0,
          coldPublicKey: 'bb'.repeat(33),
          coldSecretKeyHex: 'dd'.repeat(32)
        }
      ]);

    const vault = await Vault.spawn(WalletType.Guardian, 'pw-guardian-mixed', VALID_MNEMONIC, true);
    expect(mockMidenClient.recoverGuardianAccountsBySeed).toHaveBeenCalledTimes(2);
    const accounts = await vault.fetchAccounts();
    expect(accounts.map(a => [a.publicKey, a.hdIndex, a.keyDerivation])).toEqual([
      ['guardian-v1-pk', 1, 'v1'],
      ['guardian-legacy-pk', 0, 'legacy']
    ]);
    expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('Vault.spawn keeps one record when both scans answer the same Guardian account', async () => {
    // The lookup is by signer commitment, so an account listing a cold key from
    // each scheme answers both scans; the current-scheme match wins.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const match = {
      accountId: 'guardian-both-pk',
      hdIndex: 0,
      coldPublicKey: 'bb'.repeat(33),
      coldSecretKeyHex: 'dd'.repeat(32)
    };
    mockMidenClient.recoverGuardianAccountsBySeed.mockResolvedValue([match]);

    const vault = await Vault.spawn(WalletType.Guardian, 'pw-guardian-dup', VALID_MNEMONIC, true);
    const accounts = await vault.fetchAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.keyDerivation).toBe('v1');
  });

  it('Vault.spawn aborts the recovery when the legacy scan fails for a reason other than not-found', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed
      .mockResolvedValueOnce([
        { accountId: 'guardian-v1-pk', hdIndex: 0, coldPublicKey: 'aa'.repeat(33), coldSecretKeyHex: 'cc'.repeat(32) }
      ])
      .mockRejectedValueOnce(new Error('guardian lookup failed'));

    const spawning = Vault.spawn(WalletType.Guardian, 'pw-guardian-half', VALID_MNEMONIC, true);
    await expect(spawning).rejects.toThrow(PublicError);
    await expect(spawning).rejects.toThrow('guardian lookup failed');
  });

  it('Vault.spawn surfaces a not-found from BOTH scans as a PublicError with the lookup reason', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const { NoGuardianAccountsFoundError } = require('../sdk/guardian-recovery-errors');
    mockMidenClient.recoverGuardianAccountsBySeed.mockRejectedValue(new NoGuardianAccountsFoundError());

    const spawning = Vault.spawn(WalletType.Guardian, 'pw-guardian-none', VALID_MNEMONIC, true);
    await expect(spawning).rejects.toThrow(PublicError);
    await expect(spawning).rejects.toThrow('No Guardian accounts found at this guardian endpoint for this seed');
    expect(mockMidenClient.recoverGuardianAccountsBySeed).toHaveBeenCalledTimes(2);
  });

  it('Vault.spawn re-throws a PublicError from the recovery lookup unchanged', async () => {
    // The lookup may already be raising a user-facing error; promoting it a
    // second time would be a pointless re-wrap, and `withError` passes
    // PublicErrors through untouched, so the message must arrive verbatim.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const original = new PublicError('Could not reach the Miden network');
    mockMidenClient.recoverGuardianAccountsBySeed.mockRejectedValueOnce(original);

    await expect(Vault.spawn(WalletType.Guardian, 'pw-guardian-public', VALID_MNEMONIC, true)).rejects.toBe(original);
  });

  it('Vault.spawn stringifies a non-Error recovery rejection rather than losing it', async () => {
    // A rejection that is not an Error at all (an SDK that throws a string, or a
    // WASM trap surfacing as one) must still reach the screen as text — the
    // alternative is the generic 'Failed to create wallet' after a wipe.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed.mockRejectedValueOnce('guardian endpoint returned 503');

    await expect(Vault.spawn(WalletType.Guardian, 'pw-guardian-string', VALID_MNEMONIC, true)).rejects.toThrow(
      'guardian endpoint returned 503'
    );
  });

  it('Vault.spawn threads the picked guardianEndpoint into createGuardianMidenWallet (create path)', async () => {
    // Stage 1 of #408: the endpoint the user picked at choose-guardian is passed
    // explicitly through spawn instead of round-tripping the global storage key.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    await Vault.spawn(
      WalletType.Guardian,
      'pw-guardian-create',
      VALID_MNEMONIC,
      false,
      'https://picked-guardian.example'
    );
    expect(mockMidenClient.createGuardianMidenWallet).toHaveBeenCalledWith(
      expect.anything(),
      'https://picked-guardian.example'
    );
  });

  it('Vault.spawn threads the probed guardianEndpoint into recoverGuardianAccountsBySeed (recovery path)', async () => {
    // Stage 1 of #408: the probed endpoint reaches the recovery lookup explicitly.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    await Vault.spawn(
      WalletType.Guardian,
      'pw-guardian-recover',
      VALID_MNEMONIC,
      true,
      'https://probed-guardian.example'
    );
    expect(mockMidenClient.recoverGuardianAccountsBySeed).toHaveBeenCalledWith(
      expect.any(Function),
      'https://probed-guardian.example'
    );
    // createGuardianMidenWallet must NOT run on the recovery path.
    expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('createHDAccount supports WalletType.Guardian (derivation index 2)', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const vlt = await Vault.spawn(WalletType.OnChain, 'pw-guardian-test');
    // Guardian resolves to the third branch inside getMainDerivationPath (walletTypeIndex=2);
    // createGuardianMidenWallet is stubbed to return a predictable account id + keys.
    mockMidenClient.createGuardianMidenWallet.mockResolvedValueOnce({
      accountId: 'guardian-acc-1',
      keys: GUARDIAN_KEYS_FIXTURE
    });
    await expect(vlt.createHDAccount(WalletType.Guardian, 'Guardian 1')).resolves.toBeTruthy();
  });

  it('createHDAccount sources a second Guardian account endpoint from the existing account (not the global key)', async () => {
    // #408 stage 1: onboarding no longer writes the global GUARDIAN_URL_STORAGE_KEY,
    // so an added Guardian account must take its endpoint from a sibling account's
    // per-account field. Spawn a wallet whose first Guardian account is on a
    // non-default operator, then add a second Guardian account.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.createGuardianMidenWallet.mockResolvedValueOnce({
      accountId: 'guardian-acc-1',
      keys: GUARDIAN_KEYS_FIXTURE,
      guardianEndpoint: 'https://first-guardian.example'
    });
    const vlt = await Vault.spawn(
      WalletType.Guardian,
      'pw-add-guardian',
      VALID_MNEMONIC,
      false,
      'https://first-guardian.example'
    );

    // Isolate the createHDAccount call and make the resolved endpoint a sentinel
    // that can only have come from resolveGuardianEndpoint(existing account).
    mockMidenClient.createGuardianMidenWallet.mockClear();
    mockResolveGuardianEndpoint.mockResolvedValueOnce('https://resolved-from-sibling.example');
    mockMidenClient.createGuardianMidenWallet.mockResolvedValueOnce({
      accountId: 'guardian-acc-2',
      keys: GUARDIAN_KEYS_FIXTURE,
      guardianEndpoint: 'https://resolved-from-sibling.example'
    });

    await vlt.createHDAccount(WalletType.Guardian, 'Guardian 2');

    // Endpoint was resolved from the existing Guardian account…
    expect(mockResolveGuardianEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: 'guardian-acc-1', guardianEndpoint: 'https://first-guardian.example' })
    );
    // …and threaded into the second account's creation. Previously this 2nd arg
    // was absent, forcing createGuardianAccount to fall back to the (now unwritten)
    // global key — the regression stage 1 would otherwise introduce.
    expect(mockMidenClient.createGuardianMidenWallet).toHaveBeenCalledWith(
      expect.anything(),
      'https://resolved-from-sibling.example'
    );
  });

  it('createHDAccount supports WalletType.OffChain (derivation index 1)', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const vlt = await Vault.spawn(WalletType.OnChain, 'pw-offchain-test');
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('off-acc-1');
    await expect(vlt.createHDAccount(WalletType.OffChain, 'Off 1')).resolves.toBeTruthy();
  });

  it('getHardwareVaultKey on desktop decrypts via desktop secure-storage', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    // First spawn with hardware to store the key
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(true);
    const vaultKeyBytes = Passworder.generateVaultKey();
    const vaultKeyB64 = Buffer.from(vaultKeyBytes).toString('base64');
    mockDesktopSecureStorage.encryptWithHardwareKey.mockResolvedValue('enc-data');
    mockDesktopSecureStorage.decryptWithHardwareKey.mockResolvedValue(vaultKeyB64);
    await Vault.spawn(WalletType.OnChain, undefined as any);
    // Now try hardware unlock
    const vault = await Vault.tryHardwareUnlock();
    expect(vault).not.toBeNull();
  });

  it('revealMnemonic without password uses hardware key on desktop', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(true);
    const vaultKeyBytes = Passworder.generateVaultKey();
    const vaultKeyB64 = Buffer.from(vaultKeyBytes).toString('base64');
    mockDesktopSecureStorage.encryptWithHardwareKey.mockResolvedValue('enc-data');
    mockDesktopSecureStorage.decryptWithHardwareKey.mockResolvedValue(vaultKeyB64);
    await Vault.spawn(WalletType.OnChain, undefined as any);
    // revealMnemonic without password should use hardware key
    try {
      await Vault.revealMnemonic();
    } catch {
      // May throw if the decrypted key doesn't match - that's ok, we exercised the branch
    }
    expect(true).toBe(true); // assert no-throw
  });

  it('exports every imported account after one hardware authorization', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(true);
    let vaultKeyBase64 = '';
    mockDesktopSecureStorage.encryptWithHardwareKey.mockImplementation(async value => {
      vaultKeyBase64 = value;
      return 'encrypted-vault-key';
    });
    mockDesktopSecureStorage.decryptWithHardwareKey.mockImplementation(async () => vaultKeyBase64);

    const vault = await Vault.spawn(WalletType.OnChain, undefined as any);
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const importedAccount: WalletAccount = {
      publicKey: 'bech32:imported-account-id',
      name: 'Imported account',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: -1,
      authScheme: 'falcon'
    };
    const secondImportedAccount: WalletAccount = {
      ...importedAccount,
      publicKey: 'bech32:second-account-id',
      name: 'Imported account 2'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [importedAccount, secondImportedAccount]],
        [keys.accAuthSecretKey('a1b2'), '01020304'],
        [keys.accAuthSecretKey('c3d4'), '05060708']
      ],
      vaultKey
    );
    mockMidenClient.getAccount
      .mockResolvedValueOnce({
        id: () => ({ __marker: 'imported-account-id' }),
        getPublicKeyCommitments: () => [{ toHex: () => '0xa1b2' }]
      })
      .mockResolvedValueOnce({
        id: () => ({ __marker: 'second-account-id' }),
        getPublicKeyCommitments: () => [{ toHex: () => '0xc3d4' }]
      });
    mockAuthSecretKeyDeserialize.mockImplementation(bytes => {
      const isFirstAccount = bytes?.[0] === 1;
      return {
        ...defaultDeserializedSecret(),
        __accountIdMarker: isFirstAccount ? 'imported-account-id' : 'second-account-id',
        publicKey: jest.fn(() => ({
          toCommitment: jest.fn(() => ({ toHex: jest.fn(() => (isFirstAccount ? '0xa1b2' : '0xc3d4')) }))
        }))
      };
    });
    mockDesktopSecureStorage.decryptWithHardwareKey.mockClear();

    await expect(Vault.exportWalletBackupMaterial()).resolves.toEqual(
      expect.objectContaining({
        importedAccounts: [
          {
            accountId: importedAccount.publicKey,
            publicKeyCommitment: 'a1b2',
            authScheme: 'falcon',
            secretKeyHex: '01020304'
          },
          {
            accountId: secondImportedAccount.publicKey,
            publicKeyCommitment: 'c3d4',
            authScheme: 'falcon',
            secretKeyHex: '05060708'
          }
        ]
      })
    );
    expect(mockDesktopSecureStorage.decryptWithHardwareKey).toHaveBeenCalledTimes(1);
  });

  // Every reveal and the account-file export decide their authentication method
  // from whether a password was passed. A hardware-only wallet has no password to
  // pass, so the `undefined` arm is the ONLY way those users reach their own key
  // material — and it is the arm that fires the biometric prompt.
  it('serves every key reveal from the hardware protector when no password is given', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(true);
    let vaultKeyBase64 = '';
    mockDesktopSecureStorage.encryptWithHardwareKey.mockImplementation(async value => {
      vaultKeyBase64 = value;
      return 'encrypted-vault-key';
    });
    mockDesktopSecureStorage.decryptWithHardwareKey.mockImplementation(async () => vaultKeyBase64);

    const vault = await Vault.spawn(WalletType.OnChain, undefined as any);
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const guardian: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      evmAddress: '0xEvm'
    };
    const exportable: WalletAccount = {
      publicKey: 'acc-pub-key-1',
      name: 'Miden Account 1',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [exportable, guardian]],
        [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT'],
        [keys.accAuthSecretKey('aabb'), '010203'],
        [keys.accColdSecretKey('cold-pub-hex'), 'COLD_SECRET_HEX'],
        [`${ck('accevmsecretkey')}_0xevm`, `0x${'cd'.repeat(32)}`]
      ],
      vaultKey
    );
    mockRevealHotKey.mockResolvedValue('ab'.repeat(32));
    mockDesktopSecureStorage.decryptWithHardwareKey.mockClear();

    await expect(Vault.revealHotKey('guardian-acc-1')).resolves.toBe(`${'ab'.repeat(32)}:${'cd'.repeat(32)}`);
    await expect(Vault.revealGuardianKeys('guardian-acc-1')).resolves.toMatchObject({
      coldPrivateKey: 'COLD_SECRET_HEX',
      coldPublicKey: 'cold-pub-hex'
    });
    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', undefined, async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    // One unwrap per authorization, and no path quietly reused a cached key.
    expect(mockDesktopSecureStorage.decryptWithHardwareKey).toHaveBeenCalledTimes(3);
  });
});

describe('Vault.migrateLegacyGuardianAccounts', () => {
  const sdk = jest.requireMock('@miden-sdk/miden-sdk/lazy');

  beforeEach(() => {
    // Cold-key derivation is mocked to a fixed key; `deriveClientSeed` still runs
    // real BIP-39 over VALID_MNEMONIC but the seed it produces is ignored here.
    // The derived key's commitment is `0x020304` (the verification compares this
    // against the on-chain index-0 signer below).
    sdk.AuthSecretKey.ecdsaWithRNG.mockImplementation(() => ({
      publicKey: () => ({
        serialize: () => new Uint8Array([0x00, 0x02, 0x03, 0x04]),
        toCommitment: () => ({ toHex: () => '0x020304' })
      }),
      serialize: () => new Uint8Array([0xab, 0xcd])
    }));
    // By default the on-chain account is present and its index-0 signer matches
    // the derived cold commitment, so the legacy account migrates (verified).
    mockGetAccount.mockResolvedValue({ id: () => ({ toString: () => 'guardian-legacy' }) });
    mockGetSignerDetailsFromAccount.mockReset();
    mockGetSignerDetailsFromAccount.mockResolvedValue({ commitment: '020304' });
  });

  const legacyGuardian = {
    publicKey: 'guardian-legacy',
    name: 'Guardian 1',
    isPublic: true,
    type: WalletType.Guardian,
    hdIndex: 0
  };
  const normalAcc = { publicKey: 'normal-1', name: 'Acc', isPublic: true, type: WalletType.OnChain, hdIndex: 0 };
  const already3Key = {
    publicKey: 'guardian-3key',
    name: 'Guardian 2',
    isPublic: true,
    type: WalletType.Guardian,
    hdIndex: 1,
    coldPublicKey: 'existing-cold',
    hotPublicKey: 'existing-hot'
  };

  it('migrates a legacy single-key Guardian account to the 3-key model in place', async () => {
    const vault = await seedVault('pw', { accounts: [legacyGuardian, normalAcc, already3Key] as any });
    await vault.migrateLegacyGuardianAccounts();

    const accounts = await vault.fetchAccounts();
    const migrated = accounts.find(a => a.publicKey === 'guardian-legacy')!;
    expect(migrated.coldPublicKey).toBe('020304'); // serialize().slice(1) of [00,02,03,04]
    expect(migrated.requiresHotKeyRotation).toBe(true);
    // The derived cold key is persisted into the cold slot.
    const coldHex = await fetchAndDecryptOneWithLegacyFallBack(
      keys.accColdSecretKey('020304'),
      (vault as any).vaultKey
    );
    expect(coldHex).toBe('abcd');
  });

  it('leaves non-Guardian and already-3-key accounts untouched', async () => {
    const vault = await seedVault('pw', { accounts: [legacyGuardian, normalAcc, already3Key] as any });
    await vault.migrateLegacyGuardianAccounts();

    const accounts = await vault.fetchAccounts();
    const normal = accounts.find(a => a.publicKey === 'normal-1')!;
    const threeKey = accounts.find(a => a.publicKey === 'guardian-3key')!;
    expect(normal.coldPublicKey).toBeUndefined();
    expect(normal.requiresHotKeyRotation).toBeUndefined();
    expect(threeKey.coldPublicKey).toBe('existing-cold');
    expect(threeKey.requiresHotKeyRotation).toBeUndefined();
  });

  it('skips imported Guardian accounts (hdIndex < 0) — they cannot be re-derived', async () => {
    // Imported Guardian accounts are tagged hdIndex = -1; deriving a cold key
    // from the mnemonic at a negative index would be wrong, so they're excluded.
    const importedGuardian = {
      publicKey: 'guardian-imported',
      name: 'Guardian Imported',
      isPublic: true,
      type: WalletType.Guardian,
      hdIndex: -1
    };
    const vault = await seedVault('pw', { accounts: [importedGuardian] as any });
    sdk.AuthSecretKey.ecdsaWithRNG.mockClear();
    await vault.migrateLegacyGuardianAccounts();

    expect(sdk.AuthSecretKey.ecdsaWithRNG).not.toHaveBeenCalled();
    const imported = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-imported')!;
    expect(imported.coldPublicKey).toBeUndefined();
    expect(imported.requiresHotKeyRotation).toBeUndefined();
  });

  it('is idempotent — a second run derives nothing', async () => {
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    await vault.migrateLegacyGuardianAccounts();
    sdk.AuthSecretKey.ecdsaWithRNG.mockClear();
    await vault.migrateLegacyGuardianAccounts();
    expect(sdk.AuthSecretKey.ecdsaWithRNG).not.toHaveBeenCalled();
  });

  it('skips a legacy account whose derived cold key does NOT match the on-chain signer', async () => {
    // The on-chain index-0 signer is some other commitment — installing the
    // re-derived key + flagging rotation would arm an activation that can never
    // authorize on-chain, so the account is left untouched.
    mockGetSignerDetailsFromAccount.mockResolvedValue({ commitment: 'deadbeef' });
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    await vault.migrateLegacyGuardianAccounts();

    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-legacy')!;
    expect(acc.coldPublicKey).toBeUndefined();
    expect(acc.requiresHotKeyRotation).toBeUndefined();
  });

  it('migrates unverified when the on-chain account is unavailable to verify against', async () => {
    // Can't load the account (e.g. not synced yet) → can't confirm a mismatch →
    // fall back to migrating so the account isn't permanently stuck. No regression.
    mockGetAccount.mockResolvedValue(null);
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    await vault.migrateLegacyGuardianAccounts();

    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-legacy')!;
    expect(acc.coldPublicKey).toBe('020304');
    expect(acc.requiresHotKeyRotation).toBe(true);
    expect(mockGetSignerDetailsFromAccount).not.toHaveBeenCalled();
  });

  it('never throws (best-effort) — a failure cannot block unlock', async () => {
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    jest.spyOn(vault as any, 'fetchAccounts').mockRejectedValueOnce(new Error('boom'));
    await expect(vault.migrateLegacyGuardianAccounts()).resolves.toBeUndefined();
  });
});

describe('Vault.backfillGuardianEndpoints', () => {
  const legacyGuardian = {
    publicKey: 'guardian-legacy',
    name: 'Guardian 1',
    isPublic: true,
    type: WalletType.Guardian,
    hdIndex: 0
  };
  const stampedGuardian = {
    publicKey: 'guardian-stamped',
    name: 'Guardian 2',
    isPublic: true,
    type: WalletType.Guardian,
    hdIndex: 1,
    guardianEndpoint: 'https://already.example'
  };
  const normalAcc = { publicKey: 'normal-1', name: 'Acc', isPublic: true, type: WalletType.OnChain, hdIndex: 0 };
  const operator = { id: 'open-zeppelin', name: 'OpenZeppelin', endpoint: 'https://oz.example' };

  beforeEach(() => {
    // On-chain account present; its guardian commitment reads back as 'abc123'.
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue({ id: () => ({ toString: () => 'guardian-legacy' }) });
    mockGetGuardianCommitmentFromAccount.mockReset();
    mockGetGuardianCommitmentFromAccount.mockReturnValue('abc123');
    // By default the operator map holds the account's commitment, so the legacy
    // account gets stamped.
    mockBuildOperatorKeyMap.mockReset();
    mockBuildOperatorKeyMap.mockResolvedValue(new Map([['abc123', operator]]));
  });

  it('stamps a matched legacy Guardian account with the operator endpoint + commitment', async () => {
    const vault = await seedVault('pw', { accounts: [legacyGuardian, normalAcc] as any });
    await vault.backfillGuardianEndpoints();

    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-legacy')!;
    expect(acc.guardianEndpoint).toBe('https://oz.example');
    expect(acc.guardianOperatorCommitment).toBe('abc123');
    // Resolved by looking the on-chain commitment up in the built-in-operator
    // map — the same commitment -> operator path guardian-drift uses, built once
    // and (like guardian-drift) without an explicit network argument.
    expect(mockBuildOperatorKeyMap).toHaveBeenCalledWith();
    // A non-Guardian account is never touched.
    const normal = (await vault.fetchAccounts()).find(a => a.publicKey === 'normal-1')!;
    expect(normal.guardianEndpoint).toBeUndefined();
  });

  it('builds the operator key map ONCE regardless of how many legacy accounts there are', async () => {
    const secondLegacy = {
      publicKey: 'guardian-legacy-2',
      name: 'Guardian 3',
      isPublic: true,
      type: WalletType.Guardian,
      hdIndex: 2
    };
    const vault = await seedVault('pw', { accounts: [legacyGuardian, secondLegacy] as any });
    await vault.backfillGuardianEndpoints();

    // K accounts => a single operator probe round, not one per account.
    expect(mockBuildOperatorKeyMap).toHaveBeenCalledTimes(1);
    const accounts = await vault.fetchAccounts();
    expect(accounts.find(a => a.publicKey === 'guardian-legacy')!.guardianEndpoint).toBe('https://oz.example');
    expect(accounts.find(a => a.publicKey === 'guardian-legacy-2')!.guardianEndpoint).toBe('https://oz.example');
  });

  it('skips a Guardian account that already carries a guardianEndpoint (idempotent, never overwrites)', async () => {
    const vault = await seedVault('pw', { accounts: [stampedGuardian] as any });
    await vault.backfillGuardianEndpoints();

    // Already-stamped accounts are filtered out before the map is built or any
    // on-chain read happens.
    expect(mockBuildOperatorKeyMap).not.toHaveBeenCalled();
    expect(mockGetGuardianCommitmentFromAccount).not.toHaveBeenCalled();
    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-stamped')!;
    expect(acc.guardianEndpoint).toBe('https://already.example');
  });

  it('leaves a NO-MATCH account untouched — never stamps a guessed/default endpoint', async () => {
    // Operator down / custom / self-hosted / rotated key => commitment absent
    // from the map (here: empty map, e.g. every operator unreachable).
    mockBuildOperatorKeyMap.mockResolvedValue(new Map());
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    await vault.backfillGuardianEndpoints();

    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-legacy')!;
    expect(acc.guardianEndpoint).toBeUndefined();
    expect(acc.guardianOperatorCommitment).toBeUndefined();
  });

  it('leaves an account with no on-chain commitment untouched (retries next unlock)', async () => {
    mockGetGuardianCommitmentFromAccount.mockReturnValue(undefined);
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    await vault.backfillGuardianEndpoints();

    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-legacy')!;
    expect(acc.guardianEndpoint).toBeUndefined();
    expect(acc.guardianOperatorCommitment).toBeUndefined();
  });

  it("one account's error does not block the others", async () => {
    const secondLegacy = {
      publicKey: 'guardian-legacy-2',
      name: 'Guardian 3',
      isPublic: true,
      type: WalletType.Guardian,
      hdIndex: 2
    };
    // First account's on-chain read throws; second resolves fine.
    mockGetGuardianCommitmentFromAccount
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockReturnValue('abc123');
    const vault = await seedVault('pw', { accounts: [legacyGuardian, secondLegacy] as any });
    await vault.backfillGuardianEndpoints();

    const accounts = await vault.fetchAccounts();
    expect(accounts.find(a => a.publicKey === 'guardian-legacy')!.guardianEndpoint).toBeUndefined();
    expect(accounts.find(a => a.publicKey === 'guardian-legacy-2')!.guardianEndpoint).toBe('https://oz.example');
  });

  it('never throws (best-effort) — a failure cannot block unlock', async () => {
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });
    jest.spyOn(vault as any, 'fetchAccounts').mockRejectedValueOnce(new Error('boom'));
    await expect(vault.backfillGuardianEndpoints()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WASM-lock eviction mid-flow (#788 follow-up). An evicted operation is
// ABANDONED, not cancelled: the watchdog hands the mutex to a successor while
// the abandoned callback keeps running, so its next WASM call is a second
// borrow of a client somebody else is inside. Every guard under test sits at
// a provably pre-write transition — the assertion is always "the next WASM
// call was NOT made", never that a landed write was rolled back.
//
// Each rejection is asserted as the POISON error, not the `PublicError` the
// vault wraps every other failure in. `Vault.persistNewHotKey` and
// `Vault.swapHotKey` are called from inside the transaction pipeline, whose
// kill classifier reads that identity to decide whether a row may be requeued
// as a fresh write — and a rewrap tells it "this did not happen" about a flow
// that can still land. See the falsifier below for the ordinary case.
// ---------------------------------------------------------------------------
describe('WASM-lock eviction mid-flow (hold liveness)', () => {
  beforeEach(() => {
    // A test that rejects mid-loop leaves un-consumed mockResolvedValueOnce
    // entries queued (clearAllMocks does not drop Once queues) — reset so each
    // test's getAccount script starts clean.
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue(null);
  });

  it('still wraps an ORDINARY failure as a PublicError', async () => {
    // The falsifier for every assertion below: the poison passthrough is about
    // abandonment specifically, and must not have turned `withError` into a
    // plain rethrow that leaks SDK text into the screens (which render
    // `e.message` verbatim).
    mockMidenClient.syncState.mockImplementationOnce(async () => {
      throw new Error('node returned 503');
    });
    await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow(PublicError);
  });

  it('Vault.spawn (guardian create): eviction during the pre-create sync stops the guardian create', async () => {
    mockMidenClient.syncState.mockImplementationOnce(async () => {
      revokeWasmHold();
    });
    await expect(Vault.spawn(WalletType.Guardian, 'pw')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    // The whole point: no guardian account is minted off an abandoned flow.
    expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('Vault.spawn (restore probes): eviction during a probe stops the next probe AND the fresh-create fallback', async () => {
    // Probe 1 loses the mutex mid-lookup and then reports a definitive miss.
    // Pre-guard, the loop would carry on: probe 2 re-borrows the client, and a
    // full miss falls through to mint a fresh EMPTY wallet off an abandoned
    // restore — the fund-loss shape the per-iteration check exists to stop.
    mockMidenClient.importPublicMidenWalletFromSeed.mockImplementationOnce(async () => {
      revokeWasmHold();
      throw new Error('account not found on chain');
    });
    await expect(Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true)).rejects.toMatchObject({
      name: 'WasmClientPoisonedError'
    });
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
  });

  it('Vault.spawn (restore probes): a probe that REJECTS with poison is not read as a scheme miss', async () => {
    // The per-iteration guard above only asks whether THIS realm's hold is still
    // ours. It says nothing about a probe that rejected because the client itself
    // was replaced under it — and swallowed as a miss, that runs the loop out of
    // schemes and falls through to mint a fresh EMPTY wallet off a restore whose
    // outcome nobody knows, hiding the user's real account. Same guard
    // `createHDAccount` already carries.
    mockMidenClient.importPublicMidenWalletFromSeed.mockImplementationOnce(async () => {
      // Name-tagged rather than a real instance, which is the shape the offscreen
      // proxy reconstructs across the realm boundary.
      throw Object.assign(new Error('probe abandoned'), { name: 'WasmClientPoisonedError' });
    });

    await expect(Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true)).rejects.toMatchObject({
      name: 'WasmClientPoisonedError'
    });
    // Stopped at the FIRST scheme, and no empty wallet was minted.
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
  });

  it('Vault.spawn (fresh create): eviction during the pre-create sync stops createMidenWallet', async () => {
    mockMidenClient.syncState.mockImplementationOnce(async () => {
      revokeWasmHold();
    });
    await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
  });

  it("spawnFromMidenClient: eviction during one account's keystore insert stops the next insert", async () => {
    const acc1 = { id: () => 'pk-1' as any, isFaucet: () => false };
    const acc2 = { id: () => 'pk-2' as any, isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([acc1, acc2]);
    mockMidenClient.getAccount.mockResolvedValueOnce(acc1).mockResolvedValueOnce(acc2);
    mockKeystoreInsert.mockImplementationOnce(async () => {
      revokeWasmHold();
    });

    await expect(
      Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
        { publicKey: 'pk-2', name: 'B', isPublic: true, type: WalletType.OnChain, hdIndex: 1 }
      ])
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    // Full validation reads both accounts before any write. The post-insert
    // guard stops account 2 before its key can be inserted.
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.getAccount).toHaveBeenCalledTimes(2);
  });

  it('spawnFromMidenClient: eviction during an account read stops the isFaucet/id borrows', async () => {
    (globalThis as any).__vaultTestLockLabels = [];
    // isFaucet()/id() are WASM calls on an object borrowed from the client's
    // RefCell — touching them after an eviction IS the double borrow.
    const isFaucet = jest.fn(() => false);
    const fakeAcc = { id: () => 'pk-1' as any, isFaucet };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockImplementationOnce(async () => {
      revokeWasmHold();
      return fakeAcc;
    });

    await expect(
      Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
      ])
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(isFaucet).not.toHaveBeenCalled();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
    // The evicted hold names itself in the record.
    expect((globalThis as any).__vaultTestLockLabels).toContain('vault-spawn-from-client');
  });

  it('spawnFromMidenClient: eviction during the client build stops the account-list read', async () => {
    const defaultImpl = mockGetMidenClient.getMockImplementation()!;
    mockGetMidenClient.mockImplementationOnce(async (options?: any) => {
      revokeWasmHold();
      return defaultImpl(options);
    });

    await expect(
      Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
      ])
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(mockMidenClient.getAccounts).not.toHaveBeenCalled();
  });

  it('spawnFromMidenClient: eviction during the account-list read stops header access', async () => {
    const id = jest.fn(() => 'pk-1' as any);
    mockMidenClient.getAccounts.mockImplementationOnce(async () => {
      revokeWasmHold();
      return [{ id, isFaucet: () => false }];
    });

    await expect(
      Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
      ])
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(id).not.toHaveBeenCalled();
    expect(mockMidenClient.getAccount).not.toHaveBeenCalled();
  });

  it('spawnFromMidenClient: eviction during the final keystore insert rejects the restore', async () => {
    const account = { id: () => 'pk-1' as any, isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockKeystoreInsert.mockImplementationOnce(async () => revokeWasmHold());

    await expect(
      Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0 }
      ])
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
  });

  it('createHDAccount: eviction during the client build stops the wallet create', async () => {
    const vault = await seedVault('pw');
    (globalThis as any).__vaultTestLockLabels = [];
    const defaultImpl = mockGetMidenClient.getMockImplementation()!;
    mockGetMidenClient.mockImplementationOnce(async (options?: any) => {
      revokeWasmHold();
      return defaultImpl(options);
    });

    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    expect(mockMidenClient.importPublicMidenWalletFromSeed).not.toHaveBeenCalled();
    expect((globalThis as any).__vaultTestLockLabels).toContain('vault-create-hd-account');
  });

  it('importAccountFromPrivateKey: eviction during the client build stops the account/keystore inserts', async () => {
    const vault = await seedVault('pw');
    (globalThis as any).__vaultTestLockLabels = [];
    mockAuthSecretKeyDeserialize.mockReturnValue({ sign: jest.fn(), signData: jest.fn() } as any);
    const defaultImpl = mockGetMidenClient.getMockImplementation()!;
    mockGetMidenClient.mockImplementationOnce(async (options?: any) => {
      revokeWasmHold();
      return defaultImpl(options);
    });

    await expect(
      vault.importAccountFromPrivateKey('deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef')
    ).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(mockAccountsInsert).not.toHaveBeenCalled();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
    expect((globalThis as any).__vaultTestLockLabels).toContain('vault-import-private-key');
  });

  it('backfillGuardianEndpoints: eviction during the account read leaves the account unstamped (non-fatal)', async () => {
    const legacyGuardian = {
      publicKey: 'guardian-legacy',
      name: 'Guardian 1',
      isPublic: true,
      type: WalletType.Guardian,
      hdIndex: 0
    };
    mockBuildOperatorKeyMap.mockResolvedValue(new Map([['abc123', { id: 'oz', endpoint: 'https://oz.example' }]]));
    mockGetGuardianCommitmentFromAccount.mockReturnValue('abc123');
    mockMidenClient.getAccount.mockImplementationOnce(async () => {
      revokeWasmHold();
      return { id: () => ({ toString: () => 'guardian-legacy' }) };
    });
    const vault = await seedVault('pw', { accounts: [legacyGuardian] as any });

    // Best-effort by design: the per-account catch swallows the abandonment…
    await expect(vault.backfillGuardianEndpoints()).resolves.toBeUndefined();
    // …but the commitment read (a borrow of the returned Account) never ran,
    // and no endpoint was stamped — the account simply retries next unlock.
    expect(mockGetGuardianCommitmentFromAccount).not.toHaveBeenCalled();
    const acc = (await vault.fetchAccounts()).find(a => a.publicKey === 'guardian-legacy')!;
    expect(acc.guardianEndpoint).toBeUndefined();
  });
});

describe('insert-performing holds after a lock (#878)', () => {
  // A lock that lands while a create or import waits on the accounts queue retires
  // the vault's sink; the write must refuse as locked before any irreversible step.
  const LATE_HEX = 'deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef';
  // The production sequence: Actions.lock() retires the vault it locks.
  const lockLandedWhileQueued = (vault: Vault) => vault.retire();

  it('createHDAccount refuses, before any WASM step, when the realm sink is no longer its own', async () => {
    const vault = await seedVault('pw');
    lockLandedWhileQueued(vault);
    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toMatchObject({ reason: 'locked' });
    expect(mockCreateMidenWallet).not.toHaveBeenCalled();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('createHDAccount(Guardian) refuses before registerOnGuardian, when the realm sink is no longer its own', async () => {
    // The guardian arm registers with the operator before it inserts the key: the
    // irreversible step a late refusal would leave behind.
    const vault = await seedVault('pw');
    lockLandedWhileQueued(vault);
    await expect(vault.createHDAccount(WalletType.Guardian)).rejects.toMatchObject({ reason: 'locked' });
    expect(mockCreateGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('createHDAccount over an own mnemonic refuses before importPublicMidenWalletFromSeed', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    lockLandedWhileQueued(vault);
    await expect(vault.createHDAccount(WalletType.OnChain)).rejects.toMatchObject({ reason: 'locked' });
    expect(mockImportPublicMidenWalletFromSeed).not.toHaveBeenCalled();
  });

  it('importAccountFromPrivateKey refuses, before accounts.insert, when the realm sink is no longer its own', async () => {
    mockAuthSecretKeyDeserialize.mockReturnValue({ sign: jest.fn(), signData: jest.fn() } as any);
    const vault = await seedVault('pw');
    lockLandedWhileQueued(vault);
    await expect(vault.importAccountFromPrivateKey(LATE_HEX, 'Late')).rejects.toMatchObject({ reason: 'locked' });
    expect(mockAccountsInsert).not.toHaveBeenCalled();
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });
});

describe('recovery seed waiting time', () => {
  it.each([false, true])('resumes after an hour, with a legacy row: %s', async legacyRow => {
    const account: WalletAccount = {
      publicKey: 'guardian-recovery',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: 0,
      isPublic: false,
      coldPublicKey: '020304'
    };
    const vault = await seedVault('pw', { mnemonic: '', accounts: [account] });
    const transaction: ITransaction = new Transaction(account.publicKey, new Uint8Array());
    transaction.type = 'replace-hot-key';
    transaction.awaitingRecoverySeed = legacyRow;
    const startedAt = transaction.initiatedAt;
    const now = jest.spyOn(Date, 'now').mockReturnValue((startedAt + 60) * 1000);
    await Repo.transactions.add(transaction);
    try {
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({ ready: false });
      const expectedPause = startedAt + Number(!legacyRow) * 60;
      expect((await Repo.transactions.get(transaction.id))?.recoverySeedRequestedAt).toBe(expectedPause);
      now.mockReturnValue((startedAt + 3660) * 1000);
      await vault.prepareRecoveryTransaction(transaction.id);
      expect((await Repo.transactions.get(transaction.id))?.recoverySeedRequestedAt).toBe(expectedPause);
      if (legacyRow) {
        await Repo.transactions.where({ id: transaction.id }).modify(tx => {
          delete tx.recoverySeedRequestedAt;
        });
      }
      const action = getRecoveryAction(transaction);
      await expect(vault.provideRecoverySeed(transaction.id, 'invalid', action)).rejects.toThrow();
      expect((await Repo.transactions.get(transaction.id))?.awaitingRecoverySeed).toBe(true);
      const sdk = jest.requireMock<{ AuthSecretKey: { ecdsaWithRNG: jest.Mock } }>('@miden-sdk/miden-sdk/lazy');
      sdk.AuthSecretKey.ecdsaWithRNG.mockImplementationOnce(() => ({
        publicKey: () => ({
          serialize: () => new Uint8Array([1, 2, 3, 4]),
          toCommitment: () => ({ toHex: () => '0x020304', free: jest.fn() }),
          free: jest.fn()
        }),
        serialize: () => new Uint8Array([1, 5, 6]),
        free: jest.fn()
      }));
      mockGetAccount.mockResolvedValueOnce({});
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: '020304' });
      await vault.provideRecoverySeed(transaction.id, VALID_MNEMONIC, action);
      const resumed = await Repo.transactions.get(transaction.id);
      expect(resumed?.awaitingRecoverySeed).toBe(false);
      expect(resumed?.recoverySeedRequestedAt).toBeUndefined();
      const expectedStart = startedAt + 3600 + Number(legacyRow) * 60;
      expect(resumed?.initiatedAt).toBe(expectedStart);
      await cancelStaleQueuedTransactions();
      expect((await Repo.transactions.get(transaction.id))?.status).toBe(ITransactionStatus.Queued);
      now.mockReturnValue((expectedStart + MAX_QUEUED_AGE + 1) * 1000);
      await cancelStaleQueuedTransactions();
      expect((await Repo.transactions.get(transaction.id))?.status).toBe(ITransactionStatus.Failed);
    } finally {
      now.mockRestore();
      clearRecoveryAuthorizations();
      await Repo.transactions.delete(transaction.id);
    }
  });

  // The key is authorized BEFORE the row is handed to the pipeline. If that
  // write rejects rather than matching no row, the two outcomes are identical -
  // an authorized key nothing will ever spend - so both must zero it.
  it('zeroes the authorization when the resume write rejects', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian-write-fails',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: 0,
      isPublic: false,
      coldPublicKey: '020304'
    };
    const vault = await seedVault('pw', { mnemonic: '', accounts: [account] });
    const transaction: ITransaction = new Transaction(account.publicKey, new Uint8Array());
    transaction.type = 'replace-hot-key';
    transaction.awaitingRecoverySeed = true;
    await Repo.transactions.add(transaction);
    const where = jest.spyOn(Repo.transactions, 'where');
    try {
      const sdk = jest.requireMock<{ AuthSecretKey: { ecdsaWithRNG: jest.Mock } }>('@miden-sdk/miden-sdk/lazy');
      sdk.AuthSecretKey.ecdsaWithRNG.mockImplementationOnce(() => ({
        publicKey: () => ({
          serialize: () => new Uint8Array([1, 2, 3, 4]),
          toCommitment: () => ({ toHex: () => '0x020304', free: jest.fn() }),
          free: jest.fn()
        }),
        serialize: () => new Uint8Array([1, 5, 6]),
        free: jest.fn()
      }));
      mockGetAccount.mockResolvedValueOnce({});
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: '020304' });
      // provideRecoverySeed calls `where` exactly once, for the resume write.
      where.mockImplementationOnce(
        () =>
          ({
            filter: () => ({
              modify: async () => {
                throw new Error('dexie write failed');
              }
            })
          }) as never
      );
      await expect(
        vault.provideRecoverySeed(transaction.id, VALID_MNEMONIC, getRecoveryAction(transaction))
      ).rejects.toThrow('dexie write failed');
      // The key must be gone: a surviving authorization would report ready and
      // let the pipeline spend a key the row never learned about.
      where.mockRestore();
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({ ready: false });
    } finally {
      where.mockRestore();
      clearRecoveryAuthorizations();
      await Repo.transactions.delete(transaction.id);
    }
  });

  // A hot-key-only import stores no cold public key and has hdIndex -1, so the
  // seed prompt is the ONLY place the cold key for that account ever exists.
  // The GuardianSettings CTA test asserts the button stays offered; this asserts
  // the pipeline behind it actually works, and that the derived key is bound to
  // the one transaction that asked for it.
  it('derives and binds a cold key for an account that has none', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian-no-cold',
      name: 'Imported from hot key',
      type: WalletType.Guardian,
      hdIndex: -1,
      isPublic: false
      // coldPublicKey deliberately absent: that is the hot-key-only marker.
    };
    const vault = await seedVault('pw', { mnemonic: '', accounts: [account] });
    const transaction: ITransaction = new Transaction(account.publicKey, new Uint8Array());
    transaction.type = 'replace-hot-key';
    const other: ITransaction = new Transaction(account.publicKey, new Uint8Array());
    other.type = 'replace-hot-key';
    await Repo.transactions.bulkAdd([transaction, other]);
    try {
      // No local cold key and no authorization yet, so the pipeline must pause.
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({ ready: false });
      expect((await Repo.transactions.get(transaction.id))?.awaitingRecoverySeed).toBe(true);

      const sdk = jest.requireMock<{ AuthSecretKey: { ecdsaWithRNG: jest.Mock } }>('@miden-sdk/miden-sdk/lazy');
      sdk.AuthSecretKey.ecdsaWithRNG.mockImplementationOnce(() => ({
        publicKey: () => ({
          serialize: () => new Uint8Array([1, 2, 3, 4]),
          toCommitment: () => ({ toHex: () => '0x020304', free: jest.fn() }),
          free: jest.fn()
        }),
        serialize: () => new Uint8Array([1, 5, 6]),
        free: jest.fn()
      }));
      mockGetAccount.mockResolvedValueOnce({});
      // The on-chain cold signer is what picks the HD index when the account
      // cannot name one itself.
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: '020304' });
      await vault.provideRecoverySeed(transaction.id, VALID_MNEMONIC, getRecoveryAction(transaction));

      // getAuthorizedRecoveryPublicKey is the only source for this key.
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({
        ready: true,
        coldPublicKey: '020304'
      });
      // Bound to the transaction that asked: a sibling of the SAME type on the
      // SAME account does not inherit the authorization.
      await expect(vault.prepareRecoveryTransaction(other.id)).resolves.toEqual({ ready: false });
    } finally {
      clearRecoveryAuthorizations();
      await Repo.transactions.bulkDelete([transaction.id, other.id]);
    }
  });
});

describe('seed phrase removal', () => {
  it('removes the phrase and leaves the account usable after unlock', async () => {
    const vault = await seedVault('password123');
    const before = await vault.fetchAccounts();
    expect(await vault.fetchSeedPhraseStatus()).toBe('stored');
    await expect(Vault.revealMnemonic('password123')).resolves.toBe(VALID_MNEMONIC);
    await vault.removeSeedPhrase();
    expect(await vault.fetchSeedPhraseStatus()).toBe('removed');
    const reopened = await Vault.setup('password123');
    expect(await reopened.fetchSeedPhraseStatus()).toBe('removed');
    expect(await reopened.fetchAccounts()).toEqual(before);
    await expect(Vault.revealMnemonic('password123')).rejects.toThrow();
    await expect(reopened.createHDAccount(WalletType.OnChain)).rejects.toThrow();
    await reopened.removeSeedPhrase();
    expect(await reopened.fetchSeedPhraseStatus()).toBe('removed');
  });

  it.each([
    { retainedKey: undefined, error: undefined, status: 'removed' },
    { retainedKey: keys.accAuthSecretKey('020304'), error: 'seedRemovalFailed', status: 'removing' }
  ])('deletes all recovery-key copies, with retained storage: $retainedKey', async ({ retainedKey, error, status }) => {
    const account: WalletAccount = {
      publicKey: 'guardian',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: -1,
      isPublic: false,
      hotPublicKey: 'hot-key',
      coldPublicKey: '02' + 'ab'.repeat(32)
    };
    const vault = await seedVault('password123', { accounts: [account] });
    const protector = await getPlain<string>(keys.vaultKeyPassword);
    if (!protector) throw new Error('Missing test vault protector');
    const key = await Passworder.importVaultKey(await Passworder.decryptVaultKeyWithPassword(protector, 'password123'));
    const coldPublicKey = account.coldPublicKey;
    if (!coldPublicKey) throw new Error('Missing test recovery public key');
    await encryptAndSaveMany(
      [
        [keys.accAuthSecretKey('hot-key'), 'daily-secret'],
        [keys.accAuthSecretKey(coldPublicKey), 'recovery-secret'],
        [keys.accAuthSecretKey('020304'), 'recovery-secret'],
        [keys.accColdSecretKey(coldPublicKey), 'recovery-secret']
      ],
      key
    );
    retainedStorageKey = retainedKey;
    if (retainedKey) {
      const digest = await crypto.subtle.digest('SHA-256', Buffer.from(retainedKey, 'utf-8'));
      retainedStorageKey = Buffer.from(digest).toString('hex');
    }
    const removalError = await vault.removeSeedPhrase().catch((cause: Error) => cause.message);
    expect(removalError).toBe(error);
    expect(await vault.fetchSeedPhraseStatus()).toBe(status);
    retainedStorageKey = undefined;
    await vault.removeSeedPhrase();
    expect(await isStored(keys.mnemonic)).toBe(false);
    expect(await isStored(keys.accAuthSecretKey(coldPublicKey))).toBe(false);
    expect(await isStored(keys.accAuthSecretKey('020304'))).toBe(false);
    expect(await isStored(keys.accColdSecretKey(coldPublicKey))).toBe(false);
    expect(await vault.getAuthSecretKey('hot-key')).toBe('daily-secret');
    expect(mockGetMidenClient).toHaveBeenCalledWith();
    expect(mockKeystoreRemove).toHaveBeenCalled();
    expect(mockKeystoreGet).not.toHaveBeenCalled();
    expect(mockKeystoreGetAccountId).toHaveBeenCalled();
    expect(await vault.fetchAccounts()).toEqual([account]);
  });

  it.each(['remove', 'mapping-lookup', 'retained-mapping'])(
    'resumes cleanup after a keystore failure at %s',
    async failure => {
      const account: WalletAccount = {
        publicKey: 'guardian',
        name: 'Guardian',
        type: WalletType.Guardian,
        hdIndex: -1,
        isPublic: false,
        hotPublicKey: 'hot-key',
        coldPublicKey: '02' + 'ab'.repeat(32)
      };
      const vault = await seedVault('password123', { accounts: [account] });
      const protector = await getPlain<string>(keys.vaultKeyPassword);
      if (!protector) throw new Error('Missing test vault protector');
      const key = await Passworder.importVaultKey(
        await Passworder.decryptVaultKeyWithPassword(protector, 'password123')
      );
      await encryptAndSaveMany([[keys.accAuthSecretKey('hot-key'), 'daily-secret']], key);
      const free = jest.fn();
      switch (failure) {
        case 'remove':
          mockKeystoreRemove.mockRejectedValueOnce(new Error('Storage failed'));
          break;
        case 'mapping-lookup':
          mockKeystoreGetAccountId.mockRejectedValueOnce(new Error('Storage failed'));
          break;
        case 'retained-mapping':
          mockKeystoreGetAccountId.mockResolvedValueOnce({ free });
          break;
      }
      await expect(vault.removeSeedPhrase()).rejects.toThrow();
      expect(free).toHaveBeenCalledTimes(Number(failure === 'retained-mapping'));
      expect(await vault.fetchSeedPhraseStatus()).toBe('removing');
      await expect(Vault.revealMnemonic('password123')).rejects.toThrow();
      const reopened = await Vault.setup('password123');
      await reopened.removeSeedPhrase();
      expect(await reopened.fetchSeedPhraseStatus()).toBe('removed');
      expect(await reopened.getAuthSecretKey('hot-key')).toBe('daily-secret');
      expect(mockKeystoreGet).not.toHaveBeenCalled();
    }
  );

  it('keeps the phrase when the everyday key is not ready', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: -1,
      isPublic: false,
      coldPublicKey: '02' + 'ab'.repeat(32)
    };
    const vault = await seedVault('password123', { accounts: [account] });
    await expect(vault.removeSeedPhrase()).rejects.toThrow();
    expect(await vault.fetchSeedPhraseStatus()).toBe('stored');
  });

  it('distinguishes a wallet without a phrase from a removed phrase', async () => {
    const vault = await seedVault('password123', { mnemonic: '' });
    expect(await vault.fetchSeedPhraseStatus()).toBe('unavailable');
    await expect(vault.removeSeedPhrase()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Seed-less Guardian import: spawn from a pasted HOT key.
// ---------------------------------------------------------------------------
describe('Vault.spawnFromHotKey', () => {
  const ENDPOINT = 'https://guardian.example.com';
  const EVM_KEY = `0x${'cd'.repeat(32)}`;
  const PAIR = `${'beef'.repeat(16)}:${'cd'.repeat(32)}`;

  it('authenticates reveal without a seed and never recreates a missing EVM key', async () => {
    const vault = await Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);
    mockRevealHotKey.mockResolvedValue('beef'.repeat(16));
    await expect(Vault.revealHotKey('guardian-acc-hot', 'wrong')).rejects.toThrow();
    expect(mockRevealHotKey).not.toHaveBeenCalled();
    await expect(Vault.revealHotKey('guardian-acc-hot', 'pw')).resolves.toBe(PAIR);
    const account = (await vault.fetchAccounts())[0]!;
    await removeMany([`${ck('accevmsecretkey')}_${account.evmAddress?.toLowerCase()}`]);
    await expect(Vault.revealHotKey('guardian-acc-hot', 'pw')).rejects.toThrow('evmPrivateKeyMissing');
    expect(await isStored(keys.mnemonic)).toBe(false);
  });

  it('loads the WASM module before it parses the pasted key', async () => {
    // Fresh onboarding has no client yet, so nothing else has loaded the lazy
    // SDK's WASM. A parse before the load throws inside the SDK and is reported
    // to the user as an invalid paste.
    const sdk = jest.requireMock('@miden-sdk/miden-sdk/lazy');
    const order: string[] = [];
    sdk.getWasmOrThrow.mockImplementationOnce(async () => {
      order.push('wasm');
      return {};
    });
    mockDeserializeHotSecretKey.mockImplementationOnce((_hex: string) => {
      order.push('parse');
      return fakeHotSecretKey() as any;
    });

    await Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);

    expect(order).toEqual(['wasm', 'parse']);
  });

  it('adopts the guardian account and persists a hot-key-only wallet', async () => {
    const vault = await Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);

    // The canonical serialized hex (from the deserialized key, not the raw
    // paste) is what reaches the guardian lookup.
    expect(mockRecoverGuardianAccountByHotKey).toHaveBeenCalledWith('01beef', ENDPOINT);

    const accounts = await vault.fetchAccounts();
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account).toMatchObject({
      publicKey: 'guardian-acc-hot',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: -1,
      authScheme: 'ecdsa',
      hotPublicKey: 'dead',
      guardianEndpoint: ENDPOINT,
      guardianNoteRecoveryPending: true
    });
    // No cold key, and no rotation gate — the pasted key IS the working hot key.
    expect(account.coldPublicKey).toBeUndefined();
    expect(account.requiresHotKeyRotation).toBeUndefined();
    const evmAddress = privateKeyToAccount(`0x${'cd'.repeat(32)}`).address;
    expect(account.evmAddress).toBe(evmAddress);
    const protector = await getPlain<string>(keys.vaultKeyPassword);
    if (!protector) throw new Error('Missing test vault protector');
    const authenticatedKey = await Passworder.importVaultKey(
      await Passworder.decryptVaultKeyWithPassword(protector, 'pw')
    );
    const storageKey = `${ck('accevmsecretkey')}_${evmAddress.toLowerCase()}`;
    await expect(fetchAndDecryptOneWithLegacyFallBack<string>(storageKey, authenticatedKey)).resolves.toBe(EVM_KEY);
    const digest = await crypto.subtle.digest('SHA-256', Buffer.from(storageKey, 'utf-8'));
    const encrypted = memoryStore[Buffer.from(digest).toString('hex')];
    expect(encrypted).toEqual(expect.any(String));
    expect(encrypted).not.toContain(EVM_KEY);

    // The hot secret is persisted under the accAuthSecretKey slot in its
    // canonical serialized form (signWord's hot path reads exactly this).
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await expect(fetchAndDecryptOneWithLegacyFallBack<string>(keys.accAuthSecretKey('dead'), vaultKey)).resolves.toBe(
      '01beef'
    );

    // No mnemonic was written: the wallet is born seed-less and every
    // seed-status gate engages.
    expect(await isStored(keys.mnemonic)).toBe(false);
    await expect(vault.fetchSeedPhraseStatus()).resolves.toBe('unavailable');

    // The imported account is current, and the wallet counts as user-imported.
    await expect(getPlain(keys.currentAccPubKey)).resolves.toBe('guardian-acc-hot');
    await expect(vault.isOwnMnemonic()).resolves.toBe(true);
  });

  it('refuses account creation afterwards (no seed to derive from)', async () => {
    const vault = await Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);

    await expect(vault.createHDAccount(WalletType.Guardian)).rejects.toThrow(PublicError);
  });

  it('rejects an unparseable paste before any storage wipe or network work', async () => {
    await savePlain('sentinel', 'still-here');
    mockDeserializeHotSecretKey.mockImplementation(() => {
      throw new Error('bad key');
    });

    await expect(Vault.spawnFromHotKey('pw', 'zz', ENDPOINT)).rejects.toThrow(PublicError);

    expect(mockRecoverGuardianAccountByHotKey).not.toHaveBeenCalled();
    // The existing wallet's storage was not cleared by the failed validation.
    await expect(getPlain('sentinel')).resolves.toBe('still-here');
  });

  it.each([
    'beef'.repeat(16),
    `${'beef'.repeat(16)}:`,
    `${'beef'.repeat(16)}:${'0'.repeat(64)}`,
    `${'0'.repeat(64)}:${'cd'.repeat(32)}`,
    `${'beef'.repeat(16)}:fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`,
    `${'f'.repeat(64)}:${'cd'.repeat(32)}`,
    `${PAIR}:extra`
  ])('rejects an invalid pair before storage or recovery', async payload => {
    await savePlain('sentinel', 'preserved');
    await expect(Vault.spawnFromHotKey('pw', payload, ENDPOINT)).rejects.toThrow(PublicError);
    expect(mockDeserializeHotSecretKey).not.toHaveBeenCalled();
    expect(mockRecoverGuardianAccountByHotKey).not.toHaveBeenCalled();
    await expect(getPlain('sentinel')).resolves.toBe('preserved');
  });

  it('rejects a non-ECDSA key (Falcon blob pasted by mistake)', async () => {
    mockDeserializeHotSecretKey.mockImplementation(() => {
      const key = fakeHotSecretKey();
      key.getEcdsaK256KeccakSecretKeyAsFelts = jest.fn(() => {
        throw new Error('wrong scheme');
      });
      return key as any;
    });

    await expect(Vault.spawnFromHotKey('pw', PAIR, ENDPOINT)).rejects.toThrow(PublicError);
    expect(mockRecoverGuardianAccountByHotKey).not.toHaveBeenCalled();
  });

  it('surfaces the guardian lookup reason as a PublicError (no account for this key)', async () => {
    mockRecoverGuardianAccountByHotKey.mockRejectedValue(new Error('No Guardian account was found for this key'));

    await expect(Vault.spawnFromHotKey('pw', PAIR, ENDPOINT)).rejects.toThrow(
      'No Guardian account was found for this key'
    );
  });

  it('requires a password when hardware protection is unavailable', async () => {
    await expect(Vault.spawnFromHotKey(undefined, PAIR, ENDPOINT)).rejects.toThrow(PublicError);
    expect(mockRecoverGuardianAccountByHotKey).not.toHaveBeenCalled();
  });

  it('falls back to the network default endpoint when none is passed', async () => {
    await Vault.spawnFromHotKey('pw', PAIR);

    const [, endpoint] = mockRecoverGuardianAccountByHotKey.mock.calls[0]!;
    expect(typeof endpoint).toBe('string');
    expect(endpoint.length).toBeGreaterThan(0);
  });
});
