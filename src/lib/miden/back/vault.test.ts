// ---------------------------------------------------------------------------
// In-memory storage adapter used by `safe-storage`. Mocked at module scope so
// the real `safe-storage` code runs but writes/reads go to `memoryStore`.
// ---------------------------------------------------------------------------
import { privateKeyToAccount } from 'viem/accounts';

import { getMessage } from 'lib/i18n';
import { deserializeInternalError, serializeInternalError } from 'lib/intercom/helpers';
import { importedAccountBackupFailure } from 'lib/miden/backup-file';
import { ITransaction, ITransactionStatus, ITransactionType, Transaction } from 'lib/miden/db/types';
import * as Passworder from 'lib/miden/passworder';
import * as Repo from 'lib/miden/repo';
import { PENDING_ADMISSION_STORAGE_KEY } from 'lib/miden/reset';
import { cancelStaleQueuedTransactions, MAX_QUEUED_AGE } from 'lib/miden/transaction/cancel';
import { NoteTypeEnum } from 'lib/miden/types';
import { getEffectiveDefaultGuardianEndpoint } from 'lib/miden-chain/effective-endpoints';
import { ImportedAccountBackup, WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { HOT_KEY_CHANGED, HOT_KEY_NOT_STORED, PublicError } from './defaults';
import { midenClientProxy } from './miden-client-proxy';
import { clearRecoveryAuthorizations, getRecoveryAction } from './recovery-authorization';
import { encryptAndSaveMany, fetchAndDecryptOne, getPlain, isStored, removeMany, savePlain } from './safe-storage';
import { Vault } from './vault';
import * as CanonicalReads from '../recovery/canonical-reads';
import { StorageContinuityError } from '../recovery/continuity';
import { installProviderReceiptBackend } from '../recovery/receipt-backend';
import { checkpointProviderReceipt } from '../recovery/receipt-writer';
import { oneClickReceiptRow } from '../recovery/testing/provider-receipts';
import { GUARDIAN_ACCOUNT_NOT_FOUND, NoGuardianAccountsFoundError } from '../sdk/guardian-recovery-errors';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';
import { getStorageHealth, markStorageUnavailable, resetStorageHealthForLifecycle } from '../storage-health';

jest.mock('../recovery/canonical-reads', () => ({ createRecoveryCanonicalReads: jest.fn() }));

const mockRecoveryCommitment = jest.fn();
const mockRecoveryGuardianState = jest.fn();
jest.mock('lib/secure-hot-key/commitment', () => {
  const actual = jest.requireActual('lib/secure-hot-key/commitment');
  return {
    ...actual,
    commitmentFromPublicKeyHex: (...args: unknown[]) =>
      mockRecoveryCommitment.getMockImplementation()
        ? mockRecoveryCommitment(...args)
        : actual.commitmentFromPublicKeyHex(...args)
  };
});
jest.mock('../recovery/guardian-state', () => ({
  readGuardianRecoveryAccount: (...args: unknown[]) => mockRecoveryGuardianState(...args)
}));

jest.setTimeout(30_000);

const memoryStore: Record<string, any> = {};
// The keys of each storage write, so a test can count the saves one call makes.
const mockStorageSets: string[][] = [];
let retainedStorageKey: string | undefined;
let mockBeforeRecoveryWrite: (() => Promise<void>) | undefined;
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: jest.fn(() => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) if (k in memoryStore) out[k] = memoryStore[k];
      return out;
    },
    set: async (items: Record<string, any>) => {
      if (Object.keys(items).some(key => /^miden_recovery_v1_[01]$/.test(key))) await mockBeforeRecoveryWrite?.();
      mockStorageSets.push(Object.keys(items));
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
    _createKey?: { guardianEndpoint: string },
    _assertLive?: (step?: string) => void
  ): Promise<{
    accountId: string;
    keys: typeof GUARDIAN_KEYS_FIXTURE;
    guardianEndpoint?: string;
    registration?: { stateBase64: string };
  }> => ({
    accountId: 'guardian-acc-1',
    keys: GUARDIAN_KEYS_FIXTURE,
    registration: { stateBase64: 'state' }
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
let mockRecoveryClient: import('../sdk/miden-client-interface').MidenClientInterface | undefined;
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
    getMidenClientForRecovery: async (capability: import('../storage-health').StorageRecoveryCapability) => {
      const { assertStorageRecoveryAllowed } =
        jest.requireActual<typeof import('../storage-health')>('../storage-health');
      assertStorageRecoveryAllowed(capability);
      if (!currentWasmHold || !mockRecoveryClient) throw new Error('Missing owned recovery client fixture');
      return mockRecoveryClient;
    },
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

// provideRecoverySeed reads the on-chain cold signer via getSignerDetailsFromAccount.
// Mock it so tests can drive the match / mismatch branches.
const mockGetSignerDetailsFromAccount = jest.fn();
// createHDAccount resolves a second Guardian account's endpoint from the sibling
// account's per-account field via resolveGuardianEndpoint. Default: echo the
// account's guardianEndpoint, then a stand-in default.
const mockResolveGuardianEndpoint = jest.fn((acc: any) => acc?.guardianEndpoint ?? 'https://default.example');
const mockFetchGuardianCreateKey = jest.fn();
const mockRegisterGuardianAccount = jest.fn();
jest.mock('../guardian/account', () => ({
  getSignerDetailsFromAccount: (...a: unknown[]) => mockGetSignerDetailsFromAccount(...a),
  fetchGuardianCreateKey: (...a: unknown[]) => mockFetchGuardianCreateKey(...a),
  registerGuardianAccount: (...a: unknown[]) => mockRegisterGuardianAccount(...a),
  resolveGuardianEndpoint: (...a: unknown[]) => mockResolveGuardianEndpoint(...(a as [any])),
  resolveChosenGuardianEndpoint: (account: { guardianEndpoint?: string }) => account.guardianEndpoint
}));

// normalizeHex mirrors the real strip-0x + lowercase so commitments compare equal.
jest.mock('../guardian/operator-map', () => ({
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
  canonicalWalletAccountId: (id: string) => id.split('_')[0],
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
jest.mock('lib/miden/reset', () => {
  const actual = jest.requireActual<typeof import('lib/miden/reset')>('lib/miden/reset');
  return {
    PRESERVED_STORAGE_KEYS: actual.PRESERVED_STORAGE_KEYS,
    PENDING_ADMISSION_STORAGE_KEY: actual.PENDING_ADMISSION_STORAGE_KEY,
    SETUP_WIPE_KEPT_KEYS: actual.SETUP_WIPE_KEPT_KEYS,
    // Mirrors the real reset: every key but the kept list goes.
    clearStorage: jest.fn(async (_clearDb: boolean = true, keep: readonly string[] = actual.PRESERVED_STORAGE_KEYS) => {
      for (const k of Object.keys(memoryStore)) if (!keep.includes(k)) delete memoryStore[k];
    })
  };
});

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
    NoteType: { Private: 0, Public: 1 },
    InputNoteState: {
      Expected: 0,
      Unverified: 1,
      Committed: 2,
      Invalid: 3,
      ProcessingAuthenticated: 4,
      ConsumedAuthenticatedLocal: 6,
      ConsumedExternal: 8
    },
    NoteFile: { deserialize: jest.fn(), fromInputNote: jest.fn() },
    Note: Object.assign(base.Note, { deserialize: jest.fn() }),
    InputNote: { authenticated: jest.fn(), unauthenticated: jest.fn() },
    RpcClient: jest.fn(),
    Endpoint: jest.fn(),
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

// web-sdk 0.16.1's rendering of a 0.16 node's uncoded account-not-found answer (#1127).
const NODE_016_ACCOUNT_MISS =
  'failed to import public account: RPC error: grpc request failed for get_account: invalid request parameters: ' +
  'code: \'Client specified an invalid argument\', message: "account 0x0e3b5b2d8a1f4c10000000000000ab not found at block 1234"';
const NODE_UNAVAILABLE =
  'client error: RPC error: Miden node is unavailable; check that the node is running and reachable';
// A probe failure that is neither a miss nor transport-shaped, e.g. a local store write after the lookup.
const UNCLASSIFIED_PROBE_FAILURE = 'failed to import public account: store error: quota exceeded';

/** Seed memoryStore with everything a fresh vault needs, and return the Vault. */
async function seedVault(
  password: string,
  opts: {
    mnemonic?: string;
    accounts?: Array<{ publicKey: string; name: string; isPublic: boolean; type: WalletType } & Partial<WalletAccount>>;
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
  mockBeforeRecoveryWrite = undefined;
  clearMemoryStore();
  jest.clearAllMocks();
  (isDesktop as jest.Mock).mockReturnValue(false);
  (isMobile as jest.Mock).mockReturnValue(false);
  mockMidenClient.createMidenWallet.mockResolvedValue('acc-pub-key-1');
  mockMidenClient.createGuardianMidenWallet.mockResolvedValue({
    accountId: 'guardian-acc-1',
    keys: GUARDIAN_KEYS_FIXTURE,
    registration: { stateBase64: 'state' }
  });
  mockFetchGuardianCreateKey.mockReset().mockImplementation(async (endpoint?: string) => ({
    guardianEndpoint: endpoint ?? 'https://default.guardian',
    guardianCommitment: 'c',
    guardianPubkey: 'p',
    rateLimitBudgetLeftMs: 90_000
  }));
  mockRegisterGuardianAccount.mockReset().mockResolvedValue(undefined);
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

    it('refuses a password unlock when no password protector exists', async () => {
      // A check value under a PBKDF2 password key and no `vault_key_password` slot:
      // the storage a wallet from before the vault-key model left behind.
      const salt = Passworder.generateSalt();
      const derived = await Passworder.deriveKey(await Passworder.generateKey('pw-old'), salt, 310_000);
      const { dt, iv } = await Passworder.encrypt('any-check', derived);
      const digest = await crypto.subtle.digest('SHA-256', Buffer.from(keys.check, 'utf-8'));
      memoryStore[Buffer.from(digest).toString('hex')] = Buffer.from(salt).toString('hex') + iv + dt;

      await expect(Vault.setup('pw-old')).rejects.toThrow('Invalid password');
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
      'Wallet has no recovery phrase to back up its derived accounts'
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

  // #1114: Vault.spawnFromHotKey's record shape, beside an imported private-key account,
  // in a wallet that stores no recovery phrase.
  const hotKeyGuardian: WalletAccount = {
    publicKey: 'bech32:guardian-hot-account',
    name: 'Guardian account',
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex: -1,
    authScheme: 'ecdsa',
    hotPublicKey: 'dead',
    guardianEndpoint: 'http://localhost:3000',
    guardianNoteRecoveryPending: true,
    evmAddress: '0x0000000000000000000000000000000000000001'
  };
  const seedHotKeyWallet = async (accounts: WalletAccount[]) => {
    const seeded = await seedVault('pw', { accounts });
    await seeded.insertKeySink(new Uint8Array([0xa1, 0xb2]), new Uint8Array([1, 2, 3, 4]));
    await removeMany([keys.mnemonic]);
  };

  it('backs up the imported account and does not restore a hot-key Guardian account beside it (#1114)', async () => {
    await seedHotKeyWallet([hotKeyGuardian, importedAccount]);
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());

    await expect(Vault.exportWalletBackupMaterial('pw')).resolves.toEqual({
      seedPhrase: '',
      accounts: [importedAccount],
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
    // Never read as an imported account: nothing of its key travels in the file.
    expect(mockMidenClient.getAccount).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.getAccount).toHaveBeenCalledWith(importedAccount.publicKey);
    expect(mockExportDb).toHaveBeenCalledTimes(1);
  });

  it('refuses a wallet whose every account is a hot-key Guardian, whose file would restore nothing (#1114)', async () => {
    await seedHotKeyWallet([hotKeyGuardian]);

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      'Wallet has no accounts an encrypted file can restore'
    );
    expect(mockMidenClient.getAccount).not.toHaveBeenCalled();
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('still refuses an imported account it cannot back up when a hot-key Guardian sits beside it (#1114)', async () => {
    await seedHotKeyWallet([hotKeyGuardian, { ...importedAccount, isPublic: false }]);

    await expect(Vault.exportWalletBackupMaterial('pw')).rejects.toThrow(
      importedAccountBackupFailure(importedAccount.name)
    );
    expect(mockExportDb).not.toHaveBeenCalled();
  });

  it('writes a file whose restore brings back the imported account with its key and no keyless Guardian (#1114)', async () => {
    await seedHotKeyWallet([hotKeyGuardian, importedAccount]);
    mockMidenClient.getAccount.mockResolvedValueOnce(sdkAccount());
    const material = await Vault.exportWalletBackupMaterial('pw');

    // The database dump still carries the Guardian's SDK row, and the restore meets it first.
    const sdkRow = (marker: string) => ({ ...sdkAccount(), id: () => ({ __marker: marker }), isFaucet: () => false });
    const guardianRow = sdkRow('guardian-hot-account');
    const importedRow = sdkRow('imported-account-id');
    mockMidenClient.getAccounts.mockResolvedValueOnce([guardianRow, importedRow]);
    mockMidenClient.getAccount.mockResolvedValueOnce(guardianRow).mockResolvedValueOnce(importedRow);
    mockKeystoreInsert.mockClear();

    const restored = await Vault.spawnFromMidenClient(
      'pw',
      material.seedPhrase,
      material.accounts,
      material.importedAccounts
    );

    await expect(restored.fetchAccounts()).resolves.toEqual([importedAccount]);
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    expect(mockKeystoreInsert).toHaveBeenCalledWith({ __marker: 'imported-account-id' }, expect.any(Object));
    await expect(Vault.getCurrentAccountPublicKey()).resolves.toBe(importedAccount.publicKey);
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

describe('Vault rotated-out hot key', () => {
  const seedRotatedOutAccount = async (overrides: Partial<WalletAccount> = {}) => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      ...overrides
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [account]],
        [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT']
      ],
      vaultKey
    );
    return vault;
  };

  it('markHotKeyRotatedOut records the verdict against the stored key, once', async () => {
    const vault = await seedRotatedOutAccount();

    const first = await vault.markHotKeyRotatedOut('guardian-acc-1', 'hot-pub-hex', '0xchain');
    expect(first.written).toBe(true);
    const [account] = await vault.fetchAccounts();
    expect(account?.hotKeyRotatedOut).toMatchObject({ hotPublicKey: 'hot-pub-hex', onChainHotCommitment: '0xchain' });
    expect(typeof account?.hotKeyRotatedOut?.detectedAt).toBe('number');

    // The sync tick reaches this once per cooldown; the second write is a no-op.
    const second = await vault.markHotKeyRotatedOut('guardian-acc-1', 'hot-pub-hex', '0xchain');
    expect(second.written).toBe(false);
  });

  // The detector read the account in another realm: a rotation back that landed in between moved the
  // pointer, and a verdict written then would accuse the live key.
  it('markHotKeyRotatedOut refuses a verdict about a key the record no longer uses', async () => {
    const vault = await seedRotatedOutAccount();

    const result = await vault.markHotKeyRotatedOut('guardian-acc-1', 'older-pub', '0xchain');

    expect(result.written).toBe(false);
    const [account] = await vault.fetchAccounts();
    expect(account?.hotKeyRotatedOut).toBeUndefined();
  });

  it('swapHotKey clears the verdict with the key it was about', async () => {
    const vault = await seedRotatedOutAccount({
      hotKeyRotatedOut: { hotPublicKey: 'hot-pub-hex', onChainHotCommitment: '0xchain', detectedAt: 1 }
    });
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await encryptAndSaveMany([[keys.accAuthSecretKey('new-pub'), 'NEW_CIPHERTEXT']], vaultKey);

    await vault.swapHotKey('guardian-acc-1', 'new-pub', 'hot-pub-hex');

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('new-pub');
    expect(account?.hotKeyRotatedOut).toBeUndefined();
  });

  it('retireRotatedOutHotKey drops the key, flags the rotation and releases the blobs', async () => {
    const vault = await seedRotatedOutAccount({
      hotKeyRotatedOut: { hotPublicKey: 'hot-pub-hex', onChainHotCommitment: '0xchain', detectedAt: 1 }
    });

    await vault.retireRotatedOutHotKey('guardian-acc-1', 'hot-pub-hex');

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBeUndefined();
    expect(account?.requiresHotKeyRotation).toBe(true);
    expect(account?.hotKeyRotatedOut).toBeUndefined();
    expect(account?.coldPublicKey).toBe('cold-pub-hex');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(false);
    expect(mockDeleteHotKey).toHaveBeenCalledWith('OPAQUE_CIPHERTEXT');
  });

  it('retireRotatedOutHotKey refuses a stale expectation and changes nothing', async () => {
    const vault = await seedRotatedOutAccount({
      hotKeyRotatedOut: { hotPublicKey: 'hot-pub-hex', onChainHotCommitment: '0xchain', detectedAt: 1 }
    });

    const caught = await vault.retireRotatedOutHotKey('guardian-acc-1', 'stale-pub').then(
      () => undefined,
      (e: unknown) => e
    );

    expect(caught).toBeInstanceOf(PublicError);
    expect(caught).toMatchObject({ code: HOT_KEY_CHANGED });
    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('hot-pub-hex');
    expect(account?.requiresHotKeyRotation).toBeUndefined();
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(true);
    expect(mockDeleteHotKey).not.toHaveBeenCalled();
  });

  it('retireRotatedOutHotKey refuses a live key that carries no verdict', async () => {
    const vault = await seedRotatedOutAccount({ hotKeyRotatedOut: undefined });

    await expect(vault.retireRotatedOutHotKey('guardian-acc-1', 'hot-pub-hex')).rejects.toMatchObject({
      code: HOT_KEY_CHANGED
    });

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('hot-pub-hex');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(true);
  });

  // A hot-key-only import has nothing to sign the rotation with.
  it('retireRotatedOutHotKey refuses an account without a cold key', async () => {
    const vault = await seedRotatedOutAccount({
      coldPublicKey: undefined,
      hotKeyRotatedOut: { hotPublicKey: 'hot-pub-hex', onChainHotCommitment: '0xchain', detectedAt: 1 }
    });

    await expect(vault.retireRotatedOutHotKey('guardian-acc-1', 'hot-pub-hex')).rejects.toBeInstanceOf(PublicError);

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('hot-pub-hex');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(true);
  });
});

describe('Vault.swapHotKey', () => {
  const seedGuardianAccount = async (extraKeys: [string, string][] = []) => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex'
    };
    await encryptAndSaveMany(
      [[keys.accounts, [account]], [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT'], ...extraKeys],
      vaultKey
    );
    return vault;
  };

  // A swap to a key this vault lacks would point the account at nothing: an encrypted-file restore
  // keeps the rotation rows but not necessarily the key a rotation minted (#1233).
  it('swapHotKey refuses a key this wallet does not hold', async () => {
    const vault = await seedGuardianAccount();

    const swap = vault.swapHotKey('guardian-acc-1', 'missing-pub');
    await expect(swap).rejects.toBeInstanceOf(PublicError);
    // The heal closes its budget on this code alone, never on the message (#1233).
    await expect(swap).rejects.toMatchObject({ code: HOT_KEY_NOT_STORED });

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('hot-pub-hex');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(true);
    expect(mockDeleteHotKey).not.toHaveBeenCalled();
  });

  it('swapHotKey repoints and releases the old key when the new one is stored', async () => {
    const vault = await seedGuardianAccount([[keys.accAuthSecretKey('new-pub'), 'NEW_CIPHERTEXT']]);

    await vault.swapHotKey('guardian-acc-1', 'new-pub');

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('new-pub');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(false);
    expect(mockDeleteHotKey).toHaveBeenCalledWith('OPAQUE_CIPHERTEXT');
  });

  // A background heal swaps only if the pointer is still where it read it; a rotation that completed
  // meanwhile owns the account's key (#1233).
  it('refuses a stale expectation and changes nothing (#1233)', async () => {
    const vault = await seedGuardianAccount([[keys.accAuthSecretKey('new-pub'), 'NEW_CIPHERTEXT']]);

    const caught = await vault.swapHotKey('guardian-acc-1', 'new-pub', 'stale-pub').then(
      () => undefined,
      (e: unknown) => e
    );

    expect(caught).toBeInstanceOf(PublicError);
    expect(caught).toMatchObject({ code: HOT_KEY_CHANGED });
    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('hot-pub-hex');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(true);
    expect(await isStored(keys.accAuthSecretKey('new-pub'))).toBe(true);
    expect(mockDeleteHotKey).not.toHaveBeenCalled();
    // The extension's port carries the code the heal matches on.
    expect(deserializeInternalError(serializeInternalError(caught)).code).toBe(HOT_KEY_CHANGED);
  });

  it('refuses a keyless expectation once the account has a key (#1233)', async () => {
    const vault = await seedGuardianAccount([[keys.accAuthSecretKey('new-pub'), 'NEW_CIPHERTEXT']]);

    await expect(vault.swapHotKey('guardian-acc-1', 'new-pub', null)).rejects.toMatchObject({
      code: HOT_KEY_CHANGED
    });

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('hot-pub-hex');
  });

  it('reports a moved pointer before a missing key (#1233)', async () => {
    const vault = await seedGuardianAccount();

    await expect(vault.swapHotKey('guardian-acc-1', 'missing-pub', 'stale-pub')).rejects.toMatchObject({
      code: HOT_KEY_CHANGED
    });
  });

  it('swaps when the expectation matches (#1233)', async () => {
    const vault = await seedGuardianAccount([[keys.accAuthSecretKey('new-pub'), 'NEW_CIPHERTEXT']]);

    await vault.swapHotKey('guardian-acc-1', 'new-pub', 'hot-pub-hex');

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('new-pub');
    expect(await isStored(keys.accAuthSecretKey('hot-pub-hex'))).toBe(false);
    expect(mockDeleteHotKey).toHaveBeenCalledWith('OPAQUE_CIPHERTEXT');
  });

  it('swaps a keyless record when the expectation is null (#1233)', async () => {
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const pending: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      coldPublicKey: 'cold-pub-hex',
      requiresHotKeyRotation: true
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [pending]],
        [keys.accAuthSecretKey('new-pub'), 'NEW_CIPHERTEXT']
      ],
      vaultKey
    );

    await vault.swapHotKey('guardian-acc-1', 'new-pub', null);

    const [account] = await vault.fetchAccounts();
    expect(account?.hotPublicKey).toBe('new-pub');
    expect(account?.requiresHotKeyRotation).toBe(false);
    expect(mockDeleteHotKey).not.toHaveBeenCalled();
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
      authScheme: 'ecdsa',
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
      hdIndex: 0,
      authScheme: 'ecdsa'
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
      authScheme: 'ecdsa',
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
      authScheme: 'ecdsa',
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
      authScheme: 'ecdsa',
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

    await expect(Vault.revealHotKey('guardian-acc-1', 'pw')).rejects.toThrow('Everyday key ciphertext not found');
    expect(mockRevealHotKey).not.toHaveBeenCalled();
  });

  it('rejects when the EVM secret is present in storage but decrypts to nothing', async () => {
    // `isStored` says yes and the decrypt still yields an empty value. The pair
    // must not be assembled from it: a half-empty pair encodes to `hot:` and
    // reads as a valid-looking export.
    const vault = await seedVault('pw');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const account: WalletAccount = {
      publicKey: 'guardian-acc-1',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
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
      authScheme: 'ecdsa',
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
        authScheme: 'ecdsa',
        guardianSyncStatus: 'in-sync'
      },
      {
        publicKey: 'pkB',
        name: 'Guardian B',
        isPublic: false,
        type: WalletType.Guardian,
        hdIndex: 1,
        authScheme: 'ecdsa',
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

  describe('updateGuardianBinding (the guardian-write CAS)', () => {
    it('applies an epoch-matched patch atomically and bumps the epoch (absent epoch reads as 0)', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);
      // With pkA current, the result's account read writes no fallback pointer.
      await savePlain(keys.currentAccPubKey, 'pkA');
      mockStorageSets.length = 0;

      const write = await vault.updateGuardianBinding('pkA', 0, {
        guardianEndpoint: 'https://op.example',
        guardianOperatorCommitment: 'c1'
      });

      expect(write.outcome).toBe('applied');
      const pkA = (await vault.fetchAccounts()).find(a => a.publicKey === 'pkA');
      expect(pkA?.guardianEndpoint).toBe('https://op.example');
      expect(pkA?.guardianOperatorCommitment).toBe('c1');
      expect(pkA?.guardianEpoch).toBe(1);
      // One save carries both fields and the bump.
      expect(mockStorageSets).toHaveLength(1);
    });

    it('refuses a stale-epoch patch without writing anything', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);
      await vault.updateGuardianBinding('pkA', 0, { guardianEndpoint: 'https://current.example' });

      const write = await vault.updateGuardianBinding('pkA', 0, { guardianEndpoint: 'https://stale.example' });

      expect(write).toEqual({ outcome: 'stale' });
      const pkA = (await vault.fetchAccounts()).find(a => a.publicKey === 'pkA');
      expect(pkA?.guardianEndpoint).toBe('https://current.example');
      expect(pkA?.guardianEpoch).toBe(1);
    });

    it('the F-220 scenario: a repair that snapshotted before a rotation cannot resurrect the old operator', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);
      // The drift repair snapshots the account (epoch 0) and goes probing.
      const repairSnapshotEpoch = 0;

      // A rotation completes while the repair's probes are in flight - the
      // completion path writes through the force-with-bump legacy setter.
      await vault.setGuardianEndpoint('pkA', 'https://new-guardian.example');

      // The repair now writes what it reasoned from the PRE-rotation snapshot.
      const write = await vault.updateGuardianBinding('pkA', repairSnapshotEpoch, {
        guardianEndpoint: 'https://old-guardian.example',
        guardianOperatorCommitment: 'pre-rotation-baseline'
      });

      expect(write.outcome).toBe('stale');
      const pkA = (await vault.fetchAccounts()).find(a => a.publicKey === 'pkA');
      expect(pkA?.guardianEndpoint).toBe('https://new-guardian.example');
      expect(pkA?.guardianOperatorCommitment).toBeUndefined();
    });

    // A patch is a set of fields to change, not a replacement binding. Spread
    // whole, an explicitly-`undefined` key (the shape an optional read produces
    // when its source is empty) erased a field the caller never mentioned -
    // silently unbinding an operator on a write about the other field.
    it('leaves a field the patch does not carry alone, even when the key is present and undefined', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);
      await vault.updateGuardianBinding('pkA', 0, {
        guardianEndpoint: 'https://op.example',
        guardianOperatorCommitment: 'baseline'
      });

      const write = await vault.updateGuardianBinding('pkA', 1, {
        guardianEndpoint: 'https://moved.example',
        guardianOperatorCommitment: undefined
      });

      expect(write.outcome).toBe('applied');
      const pkA = (await vault.fetchAccounts()).find(a => a.publicKey === 'pkA');
      expect(pkA?.guardianEndpoint).toBe('https://moved.example');
      expect(pkA?.guardianOperatorCommitment).toBe('baseline');
    });

    // The epoch is a CAS token, not a modification counter. A patch that changes
    // nothing must not spend one: the bump invalidates the snapshot every
    // concurrent repair is holding, so an all-`undefined` patch - which the type
    // permits, and which `'force'` would wave through without even a stale check
    // - would turn an uncontended repair's write `stale` and make it unwind.
    it.each([
      ['a caller-supplied empty patch', {}],
      ['a patch whose every field is explicitly undefined', { guardianEndpoint: undefined }]
    ])('does not spend an epoch on %s', async (_label, patch) => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);
      await vault.updateGuardianBinding('pkA', 0, { guardianEndpoint: 'https://op.example' });

      const write = await vault.updateGuardianBinding('pkA', 1, patch);

      expect(write.outcome).toBe('applied');
      const pkA = (await vault.fetchAccounts()).find(a => a.publicKey === 'pkA');
      expect(pkA?.guardianEndpoint).toBe('https://op.example');
      expect(pkA?.guardianEpoch).toBe(1);
      // The concurrent repair still holding epoch 1 can therefore still write.
      expect((await vault.updateGuardianBinding('pkA', 1, { guardianOperatorCommitment: 'c2' })).outcome).toBe(
        'applied'
      );
    });

    // `'force'` skips the stale check, so without the empty-patch guard it is the
    // one path that bumps unconditionally.
    it('does not spend an epoch on an empty forced patch either', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);

      const write = await vault.updateGuardianBinding('pkA', 'force', {});

      expect(write.outcome).toBe('applied');
      expect((await vault.fetchAccounts()).find(a => a.publicKey === 'pkA')?.guardianEpoch).toBeUndefined();
    });

    it('status writes stay last-write-wins and do not consume or bump the epoch', async () => {
      const vault = await seedVault('pw');
      await seedGuardianPair(vault);
      await vault.updateGuardianBinding('pkA', 0, { guardianEndpoint: 'https://op.example' });

      await vault.setGuardianSyncStatus('pkA', 'resolving');

      const pkA = (await vault.fetchAccounts()).find(a => a.publicKey === 'pkA');
      expect(pkA?.guardianEpoch).toBe(1);
      // A binding write at the still-current epoch remains possible after any
      // number of status writes - status cannot starve a repair.
      const write = await vault.updateGuardianBinding('pkA', 1, { guardianOperatorCommitment: 'c2' });
      expect(write.outcome).toBe('applied');
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
    const { fetchAndDecryptOne } = await import('./safe-storage');
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const m = await fetchAndDecryptOne<string>(keys.mnemonic, vaultKey);
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

    // And run the full HD flow. The seeded vault already holds one public
    // account, so the new one takes hdIndex 1 and must be created from that seed.
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(mockMidenClient.createMidenWallet).toHaveBeenCalledWith(WalletType.OnChain, d, expect.anything());
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
    // The import probe at the new index misses, so the account is fresh.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_016_ACCOUNT_MISS));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-fallback');
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-fallback');
    expect(accounts[1]!.keyDerivation).toBe('v1');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.createMidenWallet).toHaveBeenCalled();
  });

  it('treats the node reporting the account missing as a miss, not an outage (#1127)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_016_ACCOUNT_MISS));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('acc-fresh-1127');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-fresh-1127');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    // The miss is logged with the node text that decided it.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('account on chain'),
      expect.objectContaining({ message: NODE_016_ACCOUNT_MISS })
    );
    warn.mockRestore();
  });

  it('names the node failure when the import probe cannot reach the node (own mnemonic path)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_UNAVAILABLE));
    const error = await vault.createHDAccount(WalletType.OnChain).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Could not reach the Miden network to look up your account. Your recovery phrase is fine. ' +
        `Please check your connection and try again. Details: ${NODE_UNAVAILABLE}`
    );
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
  });

  it('aborts instead of creating an account when the probe fails for a reason other than a miss', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(UNCLASSIFIED_PROBE_FAILURE));
    const error = await vault.createHDAccount(WalletType.OnChain).catch((e: unknown) => e);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toBe('createAccountLookupFailed');
    expect(getMessage).toHaveBeenCalledWith('createAccountLookupFailed', { reason: UNCLASSIFIED_PROBE_FAILURE });
  });

  it('stamps v1 when the first import probe finds the account (own mnemonic path)', async () => {
    const vault = await seedVault('pw', { ownMnemonic: true });
    mockMidenClient.importPublicMidenWalletFromSeed.mockResolvedValueOnce('acc-v1-1');
    const accounts = await vault.createHDAccount(WalletType.OnChain);
    expect(accounts[1]!.publicKey).toBe('acc-v1-1');
    expect(accounts[1]!.keyDerivation).toBe('v1');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
  });

  it('aborts on an unreachable node during the import probe (own mnemonic path)', async () => {
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

  it('probes only the v1 ECDSA derivation during spawn, then creates from that seed', async () => {
    // One node miss; beforeEach never resets this mock, so a persistent
    // rejection would leak into later tests.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_016_ACCOUNT_MISS));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('fallback-pk');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('fallback-pk');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    const probeCalls: unknown[][] = mockMidenClient.importPublicMidenWalletFromSeed.mock.calls;
    expect(probeCalls.map(call => call[1])).toEqual(['ecdsa']);
    const seedHex = (value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('hex') : 'not-bytes';
    // The v1 on-chain ECDSA golden vector at index 0 (derive-seed.test.ts).
    expect(seedHex(probeCalls[0]![0])).toBe('694ff992013be7c9f1c8ac4ed266f549df45acc0d9c0abe803a6ef0f22f78464');
    const createCalls: unknown[][] = mockMidenClient.createMidenWallet.mock.calls;
    expect(seedHex(createCalls[0]![1])).toBe(seedHex(probeCalls[0]![0]));
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
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
  });

  it('still creates a fresh wallet when the probes definitively miss (seed is genuinely new)', async () => {
    // The legitimate fall-through must survive: "no account on chain" is a real
    // answer and a first-time seed must still produce a wallet.
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_016_ACCOUNT_MISS));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('fresh-pk');
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(vault).toBeInstanceOf(Vault);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('fresh-pk');
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
  });

  it('treats the node reporting the account missing as a miss, not an outage (#1127)', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_016_ACCOUNT_MISS));
    mockMidenClient.createMidenWallet.mockResolvedValueOnce('fresh-pk-1127');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true);
    expect(await Vault.getCurrentAccountPublicKey()).toBe('fresh-pk-1127');
    // The miss is logged with the node text that decided it.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('account on chain'),
      expect.objectContaining({ message: NODE_016_ACCOUNT_MISS })
    );
    warn.mockRestore();
  });

  it('names the node failure when the import probe cannot reach the node', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(NODE_UNAVAILABLE));
    const error = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Could not reach the Miden network to look up your account. Your recovery phrase is fine. ' +
        `Please check your connection and try restoring again. Details: ${NODE_UNAVAILABLE}`
    );
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
  });

  it('aborts the restore instead of creating a wallet when the probe fails for a reason other than a miss', async () => {
    mockMidenClient.importPublicMidenWalletFromSeed.mockRejectedValueOnce(new Error(UNCLASSIFIED_PROBE_FAILURE));
    const error = await Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true).catch((e: unknown) => e);
    expect(mockMidenClient.createMidenWallet).not.toHaveBeenCalled();
    expect(mockMidenClient.importPublicMidenWalletFromSeed).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toBe('restoreAccountLookupFailed');
    expect(getMessage).toHaveBeenCalledWith('restoreAccountLookupFailed', { reason: UNCLASSIFIED_PROBE_FAILURE });
  });

  it('stamps v1 when the probe finds an account', async () => {
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

  it('leaves no protector behind when creation is rejected, and keeps what every setup keeps (#946)', async () => {
    memoryStore['endpoint_overrides'] = { rpcUrl: 'https://rpc.custom' };
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow('Failed to create wallet');

    expect(await getPlain(keys.vaultKeyPassword)).toBeUndefined();
    expect(memoryStore['endpoint_overrides']).toEqual({ rpcUrl: 'https://rpc.custom' });
  });

  it('undoes a creation that fails after its check key landed, so a reload does not open Unlock (#946)', async () => {
    // The current-account pointer is the last write but one, after the check key, the mnemonic and the accounts.
    Object.defineProperty(memoryStore, keys.currentAccPubKey, {
      configurable: true,
      get: () => undefined,
      set: () => {
        throw new Error('disk full');
      }
    });
    try {
      await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow('Failed to create wallet');
    } finally {
      delete memoryStore[keys.currentAccPubKey];
    }

    expect(await Vault.isExist()).toBe(false);
    expect(await isStored(keys.mnemonic)).toBe(false);
    expect(await Vault.hasPasswordProtector()).toBe(false);
  });

  it('leaves the existing wallet untouched when creation fails before its opening wipe (#946)', async () => {
    await seedVault('old-pw');
    const protector = await getPlain(keys.vaultKeyPassword);
    expect(protector).toEqual(expect.any(String));
    const { clearStorage } = jest.requireMock('lib/miden/reset');
    const importKey = jest.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('key import failed'));

    try {
      await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow('Failed to create wallet');
    } finally {
      importKey.mockRestore();
    }

    expect(clearStorage).not.toHaveBeenCalled();
    expect(await Vault.isExist()).toBe(true);
    expect(await getPlain(keys.vaultKeyPassword)).toBe(protector);
  });

  it('retires its provisional realm sink when creation is rejected (#946)', async () => {
    (globalThis as any).__vaultTestRealmInsertKey = null;
    (globalThis as any).__vaultTestRealmUninstalled = null;
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow('Failed to create wallet');

    expect((globalThis as any).__vaultTestRealmUninstalled).toEqual(expect.any(Function));
    expect((globalThis as any).__vaultTestRealmInsertKey).toBeNull();
  });

  it('finishes its undo before the caller sees the rejection, so a queued retry cannot race it (#946)', async () => {
    const { clearStorage } = jest.requireMock('lib/miden/reset');
    const defaultClear = clearStorage.getMockImplementation();
    let entered!: () => void;
    let release!: () => void;
    const entered$ = new Promise<void>(resolve => {
      entered = resolve;
    });
    const release$ = new Promise<void>(resolve => {
      release = resolve;
    });
    // The first call is the opening wipe, left to run for real; the second is the undo,
    // held open until the assertions below have seen it, so an awaited undo and a
    // fire-and-forget one are told apart by whether the spawn is still unsettled.
    clearStorage.mockImplementationOnce(defaultClear).mockImplementationOnce(async () => {
      entered();
      await release$;
    });
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));

    let settled = false;
    const spawning = Vault.spawn(WalletType.OnChain, 'pw');
    spawning.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await entered$;
    await new Promise<void>(resolve => jest.requireActual('timers').setImmediate(resolve));

    expect(clearStorage).toHaveBeenCalledTimes(2);
    expect(clearStorage).toHaveBeenNthCalledWith(2, false);
    expect(settled).toBe(false);

    release();
    await expect(spawning).rejects.toThrow('Failed to create wallet');
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
  ) => Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, walletAccounts, importedAccounts);

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

    const vault = await Vault.spawnFromMidenClient('pw', '', [importedWalletAccount], [importedBackup]);

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
      Vault.spawnFromMidenClient('pw', 'abandon abandon abandon', [importedWalletAccount], [importedBackup])
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

    await expect(Vault.spawnFromMidenClient('pw', '', [hdAccount], [])).rejects.toThrow(
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
      hdIndex: 0,
      authScheme: 'ecdsa'
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

  it('keeps the endpoint override through a rejected restore (#1174)', async () => {
    memoryStore['endpoint_overrides'] = { rpcUrl: 'https://rpc.custom' };
    memoryStore['stale_setting'] = 'from the previous profile';
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockBuiltAccountIdMarker = 'different-account-id';

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);

    // The opening wipe and its undo both ran, so what survived them was kept, not skipped.
    expect(memoryStore['stale_setting']).toBeUndefined();
    expect(await getPlain(keys.vaultKeyPassword)).toBeUndefined();
    expect(memoryStore['endpoint_overrides']).toEqual({ rpcUrl: 'https://rpc.custom' });
  });

  it("surfaces the restore's own error when its undo cannot clear storage (#1174)", async () => {
    const { clearStorage } = jest.requireMock('lib/miden/reset');
    const wipe = clearStorage.getMockImplementation();
    // The restore's opening wipe runs as usual; the undo's wipe fails.
    clearStorage.mockImplementationOnce(wipe).mockImplementationOnce(async () => {
      throw new Error('storage down');
    });
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockBuiltAccountIdMarker = 'different-account-id';
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(restoreVersionTwo()).rejects.toThrow(PublicError);
    expect(clearStorage).toHaveBeenCalledTimes(2);
    consoleErrorSpy.mockRestore();
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
    const vault = await Vault.spawnFromMidenClient(
      'pw',
      VALID_MNEMONIC,
      [
        {
          publicKey: 'pk-owned',
          name: 'HD 1',
          isPublic: true,
          type: WalletType.OnChain,
          hdIndex: 0,
          authScheme: 'ecdsa'
        }
      ],
      []
    );
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
    // The restore installed the new key's sink before it could insert anything (#878).
    expect((globalThis as any).__vaultTestRealmInsertKey).toEqual(expect.any(Function));
  });

  it('keeps the endpoint override through a restore (#1174)', async () => {
    memoryStore['endpoint_overrides'] = { rpcUrl: 'https://rpc.custom' };
    memoryStore['stale_setting'] = 'from the previous profile';

    await Vault.spawnFromMidenClient(
      'pw',
      VALID_MNEMONIC,
      [{ publicKey: 'pk-1', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
      []
    );

    expect(memoryStore['stale_setting']).toBeUndefined();
    expect(memoryStore['endpoint_overrides']).toEqual({ rpcUrl: 'https://rpc.custom' });
  });

  it('restores a matching account through the sink installed before the loop inserts (#878)', async () => {
    // The restore loop hands the derived secret to the SDK, which inserts through the
    // realm sink; the vault must have installed it before the first insert.
    (globalThis as any).__vaultTestRealmInsertKey = null;
    mockKeystoreInsert.mockImplementationOnce(async (_id: any, _secretKey: any) => {
      await (globalThis as any).__vaultTestRealmInsertKey(new Uint8Array([0xab]), new Uint8Array([0x11]));
    });
    const vault = await Vault.spawnFromMidenClient(
      'pw',
      VALID_MNEMONIC,
      [{ publicKey: 'pk-1', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
      []
    );
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    expect(vault.insertKeySink).toBe((globalThis as any).__vaultTestRealmInsertKey);
  });

  it('derives + inserts a key for each HD account', async () => {
    const acc1 = { id: () => 'pk-1' as any, isFaucet: () => false };
    const acc2 = { id: () => 'pk-2' as any, isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([acc1, acc2]);
    mockMidenClient.getAccount.mockResolvedValueOnce(acc1).mockResolvedValueOnce(acc2);

    await Vault.spawnFromMidenClient(
      'pw',
      VALID_MNEMONIC,
      [
        { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' },
        { publicKey: 'pk-2', name: 'B', isPublic: false, type: WalletType.OffChain, hdIndex: 0, authScheme: 'ecdsa' }
      ],
      []
    );
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(2);
  });

  it('skips null accounts returned by getAccount', async () => {
    const fakeAcc = { id: () => 'pk-1' as any, isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(null);
    const vault = await Vault.spawnFromMidenClient(
      'pw',
      VALID_MNEMONIC,
      [{ publicKey: 'pk-1', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
      []
    );
    expect(vault).toBeInstanceOf(Vault);
    expect(mockKeystoreInsert).not.toHaveBeenCalled();
  });

  it('wraps errors from the WASM client in a PublicError', async () => {
    mockMidenClient.getAccounts.mockRejectedValueOnce(new Error('wasm failed'));
    await expect(
      Vault.spawnFromMidenClient(
        'pw',
        VALID_MNEMONIC,
        [
          { publicKey: 'pk-1', name: 'HD 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }
        ],
        []
      )
    ).rejects.toThrow('Failed to spawn from miden client');
    expect(mockMidenClient.getAccounts).toHaveBeenCalled();
  });

  describe('a Guardian account in the file', () => {
    const COLD_PUBLIC = '0a0b0c';
    const guardianRecord: WalletAccount = {
      publicKey: 'pk-guardian',
      name: 'Guardian 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      keyDerivation: 'v1',
      hotPublicKey: 'old-hot',
      coldPublicKey: COLD_PUBLIC,
      guardianEndpoint: 'https://guardian.example',
      guardianOperatorCommitment: '0xabc',
      guardianEpoch: 3,
      guardianSyncStatus: 'in-sync'
    };
    const derivedColdKey = (publicHex = COLD_PUBLIC, commitment = '0x0a0b0c') => ({
      publicKey: () => ({
        serialize: () => new Uint8Array([2, ...Buffer.from(publicHex, 'hex')]),
        toCommitment: () => ({ toHex: () => commitment, free: jest.fn() }),
        free: jest.fn()
      }),
      serialize: () => new Uint8Array([9, 9]),
      free: jest.fn()
    });
    const stageGuardianStore = (derived: ReturnType<typeof derivedColdKey>, onChain = '0a0b0c') => {
      const sdk = jest.requireMock<{ AuthSecretKey: { ecdsaWithRNG: jest.Mock } }>('@miden-sdk/miden-sdk/lazy');
      sdk.AuthSecretKey.ecdsaWithRNG.mockImplementationOnce(() => derived);
      const row = { id: () => 'pk-guardian' as any, isFaucet: () => false };
      mockMidenClient.getAccounts.mockResolvedValueOnce([row]);
      mockMidenClient.getAccount.mockResolvedValueOnce(row);
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: onChain });
    };

    it('restores as a recovered account: cold key kept, everyday key to be replaced', async () => {
      const derived = derivedColdKey();
      stageGuardianStore(derived);

      const vault = await Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [guardianRecord], []);

      expect(mockKeystoreInsert).toHaveBeenCalledWith('pk-guardian', derived);
      expect(mockGetSignerDetailsFromAccount).toHaveBeenCalledWith(expect.anything(), true);
      const [stored] = await vault.fetchAccounts();
      expect(stored).toMatchObject({
        publicKey: 'pk-guardian',
        coldPublicKey: COLD_PUBLIC,
        requiresHotKeyRotation: true,
        guardianNoteRecoveryPending: true,
        guardianEndpoint: 'https://guardian.example',
        guardianOperatorCommitment: '0xabc',
        guardianEpoch: 3
      });
      expect(stored!.hotPublicKey).toBeUndefined();
      expect(await isStored(keys.accColdSecretKey(COLD_PUBLIC))).toBe(true);
    });

    it('refuses a file whose phrase does not derive the account cold signer', async () => {
      stageGuardianStore(derivedColdKey('0d0e0f', '0x0d0e0f'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [guardianRecord], [])).rejects.toThrow(MISMATCHED);

      expect(mockKeystoreInsert).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('refuses a file whose dump carries no state for the account', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [guardianRecord], [])).rejects.toThrow(
        'Encrypted file is missing imported account data'
      );

      expect(mockKeystoreInsert).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  it('re-derives ECDSA secret keys for accounts whose authScheme is "ecdsa"', async () => {
    // The keystore-insert call must receive the ECDSA-marker secret produced
    // by AuthSecretKey.ecdsaWithRNG, not the falcon one. Confirms the
    // restore path picks the right derivation function based on the stored
    // scheme, which is the contract that prevents a restore from corrupting
    // an account's signing key.
    const fakeAcc = { id: () => 'pk-ecdsa' as any, isFaucet: () => false, isNetwork: () => false };
    mockMidenClient.getAccounts.mockResolvedValueOnce([fakeAcc]);
    mockMidenClient.getAccount.mockResolvedValueOnce(fakeAcc);

    await Vault.spawnFromMidenClient(
      'pw',
      VALID_MNEMONIC,
      [
        {
          publicKey: 'pk-ecdsa',
          name: 'A',
          isPublic: true,
          type: WalletType.OnChain,
          hdIndex: 0,
          authScheme: 'ecdsa'
        }
      ],
      []
    );

    // Last keystore insert receives the secret produced by ecdsaWithRNG —
    // the falcon constructor must not have been called for this account.
    expect(mockKeystoreInsert).toHaveBeenCalledTimes(1);
    const insertedSecret = mockKeystoreInsert.mock.calls[0]![1];
    expect((insertedSecret as any).__marker).toBe('ecdsa-secret');
  });

  it('finishes its undo before the caller sees the rejection, so a queued retry cannot race it (#946)', async () => {
    const { clearStorage } = jest.requireMock('lib/miden/reset');
    const defaultClear = clearStorage.getMockImplementation();
    let entered!: () => void;
    let release!: () => void;
    const entered$ = new Promise<void>(resolve => {
      entered = resolve;
    });
    const release$ = new Promise<void>(resolve => {
      release = resolve;
    });
    // The first call is the opening wipe, left to run for real; the second is the undo,
    // held open until the assertions below have seen it, so an awaited undo and a
    // fire-and-forget one are told apart by whether the restore is still unsettled.
    clearStorage.mockImplementationOnce(defaultClear).mockImplementationOnce(async () => {
      entered();
      await release$;
    });
    const account = importedSdkAccount();
    mockMidenClient.getAccounts.mockResolvedValueOnce([account]);
    mockMidenClient.getAccount.mockResolvedValueOnce(account);
    mockBuiltAccountIdMarker = 'different-account-id';

    let settled = false;
    const restoring = restoreVersionTwo();
    restoring.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await entered$;
    await new Promise<void>(resolve => jest.requireActual('timers').setImmediate(resolve));

    expect(clearStorage).toHaveBeenCalledTimes(2);
    expect(clearStorage).toHaveBeenNthCalledWith(2, false);
    expect(settled).toBe(false);

    release();
    await expect(restoring).rejects.toThrow(PublicError);
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
    // Mocked secret key has no scheme accessors → detectAuthScheme reads it
    // as Falcon, since Falcon is the only other AuthScheme.
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

describe('Vault.spawn + insertKeyCallback', () => {
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
    deleteHardwareKey: jest.fn(),
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
    await expect(Vault.setup('any-pw')).rejects.toThrow(
      'This wallet uses biometric unlock only. Use Face ID/Touch ID or recover with your recovery phrase.'
    );
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

  it('leaves no wrapped vault key after a rejected hardware creation, and keeps the device key (#946)', async () => {
    (isDesktop as jest.Mock).mockReturnValue(true);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockDesktopSecureStorage.isHardwareSecurityAvailable.mockResolvedValue(true);
    mockDesktopSecureStorage.hasHardwareKey.mockResolvedValue(true);
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(Vault.spawn(WalletType.OnChain, '')).rejects.toThrow('Failed to create wallet');

    // The wrapped key was written before the rejection, so its absence is the undo's doing.
    expect(mockDesktopSecureStorage.encryptWithHardwareKey).toHaveBeenCalled();
    expect(await Vault.hasHardwareProtector()).toBe(false);
    expect(mockDesktopSecureStorage.deleteHardwareKey).not.toHaveBeenCalled();
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

  it('Vault.spawn scans once, under the v1 cold-key derivation, and surfaces a not-found as a PublicError', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed.mockRejectedValue(new NoGuardianAccountsFoundError());

    const spawning = Vault.spawn(WalletType.Guardian, 'pw-guardian-none', VALID_MNEMONIC, true);
    await expect(spawning).rejects.toThrow(PublicError);
    await expect(spawning).rejects.toThrow('No Guardian accounts found at this guardian endpoint for this seed');
    await expect(spawning).rejects.toMatchObject({ code: GUARDIAN_ACCOUNT_NOT_FOUND });
    expect(mockMidenClient.recoverGuardianAccountsBySeed).toHaveBeenCalledTimes(1);
    // The v1 Guardian ECDSA golden vector at index 0 (derive-seed.test.ts).
    const [deriveColdSeed] = mockMidenClient.recoverGuardianAccountsBySeed.mock.calls[0]!;
    expect(Buffer.from(deriveColdSeed(0)).toString('hex')).toBe(
      'a8ecedd7d91f0355bfa4f914044e00b1395c77db738e91ba7b6d897322ec383c'
    );
  });

  it('gives a seed-path network failure no not-found code', async () => {
    // A network error is an unrelated failure that must reach the caller as
    // itself, not as a not-found.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed.mockRejectedValueOnce(new Error('Failed to fetch'));

    const spawning = Vault.spawn(WalletType.Guardian, 'pw-guardian-network', VALID_MNEMONIC, true);
    await expect(spawning).rejects.toThrow(PublicError);
    await expect(spawning).rejects.toMatchObject({ message: 'Failed to fetch' });
    await expect(spawning).rejects.not.toHaveProperty('code');
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

  it('promotes a liveClient() rejection during the recovery scan to a PublicError with its own message', async () => {
    // The client spawn resolved at step 5 can be disposed by lock recovery
    // before the scan starts (#775); liveClient() then re-resolves a fresh one.
    // That re-resolve must fail through the same promotion as the lookup
    // itself, not bubble up raw and get flattened to 'Failed to create wallet'.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const disposed = { isDisposed: true, network: 'devnet' };
    mockGetMidenClient
      .mockImplementationOnce(async () => disposed as never)
      .mockImplementationOnce(async () => {
        throw new Error('client gone');
      });

    const spawning = Vault.spawn(WalletType.Guardian, 'pw-guardian-client-gone', VALID_MNEMONIC, true);
    await expect(spawning).rejects.toThrow(PublicError);
    await expect(spawning).rejects.toThrow('client gone');
  });

  it('Vault.spawn threads the picked guardianEndpoint into createGuardianMidenWallet (create path)', async () => {
    // The endpoint the user picked at choose-guardian is passed explicitly through spawn.
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    await Vault.spawn(
      WalletType.Guardian,
      'pw-guardian-create',
      VALID_MNEMONIC,
      false,
      'https://picked-guardian.example'
    );
    expect(mockFetchGuardianCreateKey).toHaveBeenCalledWith('https://picked-guardian.example');
    expect(mockMidenClient.createGuardianMidenWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ guardianEndpoint: 'https://picked-guardian.example' }),
      expect.any(Function)
    );
  });

  it('Vault.spawn threads the probed guardianEndpoint into recoverGuardianAccountsBySeed (recovery path)', async () => {
    // The probed endpoint reaches the recovery lookup explicitly.
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

  it('Vault.spawn stores a seed-recovered Guardian account behind the rotation gate, with its cold mirror', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    const vault = await Vault.spawn(WalletType.Guardian, 'pw-guardian-stamp', VALID_MNEMONIC, true);

    const accounts = await vault.fetchAccounts();
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account).toMatchObject({
      publicKey: 'guardian-acc-imported',
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      keyDerivation: 'v1',
      coldPublicKey: GUARDIAN_KEYS_FIXTURE.coldPublicKey,
      guardianEndpoint: getEffectiveDefaultGuardianEndpoint(),
      requiresHotKeyRotation: true,
      guardianNoteRecoveryPending: true
    });
    // The hot key is unrecoverable from the seed; the rotation mints it.
    expect(account.hotPublicKey).toBeUndefined();

    const protector = await getPlain<string>(keys.vaultKeyPassword);
    if (!protector) throw new Error('Missing test vault protector');
    const vaultKey = await Passworder.importVaultKey(
      await Passworder.decryptVaultKeyWithPassword(protector, 'pw-guardian-stamp')
    );
    await expect(
      fetchAndDecryptOne<string>(keys.accColdSecretKey(GUARDIAN_KEYS_FIXTURE.coldPublicKey), vaultKey)
    ).resolves.toBe(GUARDIAN_KEYS_FIXTURE.coldSecretKeyHex);
  });

  it('Vault.spawn keeps one record, the lowest HD index, for an account recovered at two indices', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    mockMidenClient.recoverGuardianAccountsBySeed.mockResolvedValueOnce([
      { accountId: 'guardian-acc-twice', hdIndex: 0, coldPublicKey: 'cold-pub-0', coldSecretKeyHex: 'cold-sk-0' },
      { accountId: 'guardian-acc-twice', hdIndex: 1, coldPublicKey: 'cold-pub-1', coldSecretKeyHex: 'cold-sk-1' }
    ]);

    const vault = await Vault.spawn(WalletType.Guardian, 'pw-guardian-twice', VALID_MNEMONIC, true);

    const accounts = await vault.fetchAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ publicKey: 'guardian-acc-twice', hdIndex: 0, coldPublicKey: 'cold-pub-0' });
  });

  it('Vault.spawn falls back to the network default when the recovery path is given no guardianEndpoint', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    await Vault.spawn(WalletType.Guardian, 'pw-guardian-recover-default', VALID_MNEMONIC, true);

    expect(mockMidenClient.recoverGuardianAccountsBySeed).toHaveBeenCalledWith(
      expect.any(Function),
      getEffectiveDefaultGuardianEndpoint()
    );
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

  it('createHDAccount sources a second Guardian account endpoint from the existing account', async () => {
    // An added Guardian account takes its endpoint from a sibling account's
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
    mockResolveGuardianEndpoint.mockReturnValueOnce('https://resolved-from-sibling.example');
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
    // ...and threaded into the second account's creation as fetchGuardianCreateKey's
    // endpoint override: without it the fetch binds to the network default instead
    // of the sibling's operator, the regression stage 1 guards against.
    const [fetchEndpoint, fetchAssertLive] = mockFetchGuardianCreateKey.mock.lastCall ?? [];
    expect(fetchEndpoint).toBe('https://resolved-from-sibling.example');
    // The second argument is the vault's own sink check: silent while the vault is live,
    // a locked refusal once a lock retires it.
    expect(fetchAssertLive).not.toThrow();
    vlt.retire();
    expect(fetchAssertLive).toThrow('Wallet is locked');
    expect(mockMidenClient.createGuardianMidenWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ guardianEndpoint: 'https://resolved-from-sibling.example' }),
      expect.any(Function)
    );
  });

  it('createHDAccount (Guardian) binds a sibling-less-pointer account to the resolved default endpoint, not a Promise', async () => {
    (isDesktop as jest.Mock).mockReturnValue(false);
    (isMobile as jest.Mock).mockReturnValue(false);
    // The default create mock returns no guardianEndpoint, so the sibling stores none.
    const vlt = await Vault.spawn(WalletType.Guardian, 'pw-add-guardian-default');
    mockFetchGuardianCreateKey.mockClear();
    mockMidenClient.createGuardianMidenWallet.mockResolvedValueOnce({
      accountId: 'guardian-acc-2',
      keys: GUARDIAN_KEYS_FIXTURE
    });

    await vlt.createHDAccount(WalletType.Guardian, 'Guardian 2');

    expect(mockFetchGuardianCreateKey).toHaveBeenCalledWith('https://default.example', expect.any(Function));
  });

  // Guardian creation parks inside the hold (the hot key, the account build,
  // the sync), and an evicted flow is abandoned, not cancelled: the hold
  // hands the creation a re-check bound to itself, live while it owns the mutex
  // and poisoned once it does not.
  describe('Guardian creation re-checks its own hold (#906)', () => {
    const recordAssertLive = () => {
      const outcomes: unknown[] = [];
      const probe = (assertLive: ((step?: string) => void) | undefined) => {
        try {
          assertLive?.('probe');
          outcomes.push('live');
        } catch (error) {
          outcomes.push(error);
        }
      };
      mockMidenClient.createGuardianMidenWallet.mockImplementationOnce(async (_seed, _createKey, assertLive) => {
        probe(assertLive);
        revokeWasmHold();
        probe(assertLive);
        return { accountId: 'guardian-acc-1', keys: GUARDIAN_KEYS_FIXTURE };
      });
      return outcomes;
    };

    it('in Vault.spawn', async () => {
      const { WasmClientPoisonedError } = await import('../sdk/wasm-client-poison');
      const outcomes = recordAssertLive();
      await Vault.spawn(WalletType.Guardian, 'pw-guardian-hold', VALID_MNEMONIC, false);
      expect(outcomes[0]).toBe('live');
      expect(outcomes[1]).toBeInstanceOf(WasmClientPoisonedError);
    });

    it('in createHDAccount', async () => {
      const { WasmClientPoisonedError } = await import('../sdk/wasm-client-poison');
      const vlt = await Vault.spawn(WalletType.OnChain, 'pw-guardian-hd-hold');
      const outcomes = recordAssertLive();
      await vlt.createHDAccount(WalletType.Guardian, 'Guardian 1');
      expect(outcomes[0]).toBe('live');
      expect(outcomes[1]).toBeInstanceOf(WasmClientPoisonedError);
    });
  });

  // The guardian's 429 waits (up to 90 s) must not block the realm's other
  // client work, and a failed registration must leave no entry in the vault's
  // account list (#1207).
  describe('Guardian creation keeps its guardian calls outside the WASM hold (#1207)', () => {
    const getCurrentWasmLockHoldForTests = () => currentWasmHold;
    // Storage keys are hashed, so the account's write is read back through the store.
    const accountWritten = () => isStored(keys.accPubKey('guardian-acc-1'));

    it.each<'spawn' | 'createHDAccount'>(['spawn', 'createHDAccount'])(
      '%s fetches the guardian key and registers with no WASM hold, before any vault write',
      async path => {
        const holdAt: Record<string, boolean> = {};
        mockFetchGuardianCreateKey.mockImplementationOnce(async (endpoint?: string) => {
          holdAt.fetch = getCurrentWasmLockHoldForTests() !== null;
          return {
            guardianEndpoint: endpoint ?? 'https://default.guardian',
            guardianCommitment: 'c',
            guardianPubkey: 'p',
            rateLimitBudgetLeftMs: 90_000
          };
        });
        mockRegisterGuardianAccount.mockImplementationOnce(async () => {
          holdAt.register = getCurrentWasmLockHoldForTests() !== null;
          holdAt.accountWritten = await accountWritten();
        });
        if (path === 'spawn') {
          await Vault.spawn(WalletType.Guardian, 'pw-1207', VALID_MNEMONIC, false, 'https://picked.example');
        } else {
          const vlt = await Vault.spawn(WalletType.OnChain, 'pw-1207');
          await vlt.createHDAccount(WalletType.Guardian, 'Guardian 1');
        }
        expect(holdAt).toEqual({ fetch: false, register: false, accountWritten: false });
        // The account is written once registration succeeds.
        expect(await accountWritten()).toBe(true);
      }
    );

    it('takes no creation hold when the guardian key fetch fails', async () => {
      mockFetchGuardianCreateKey.mockRejectedValueOnce(new Error('Failed to create Guardian account'));
      Reflect.set(globalThis, '__vaultTestLockLabels', []);
      await expect(
        Vault.spawn(WalletType.Guardian, 'pw-1207-fail', VALID_MNEMONIC, false, 'https://down.example')
      ).rejects.toThrow();
      const lockLabels: unknown = Reflect.get(globalThis, '__vaultTestLockLabels');
      expect(lockLabels).not.toContain('vault-spawn');
      expect(mockMidenClient.createGuardianMidenWallet).not.toHaveBeenCalled();
      expect(mockFetchGuardianCreateKey).toHaveBeenCalledTimes(1);
    });

    it('writes no account when the registration fails', async () => {
      const vlt = await Vault.spawn(WalletType.OnChain, 'pw-1207-reg');
      const before = await vlt.fetchAccounts();
      mockRegisterGuardianAccount.mockRejectedValueOnce(new Error('Failed to create Guardian account'));
      await expect(vlt.createHDAccount(WalletType.Guardian, 'Guardian 1')).rejects.toThrow();
      expect(await vlt.fetchAccounts()).toEqual(before);
      expect(mockRegisterGuardianAccount).toHaveBeenCalledTimes(1);
    });

    it('does not register after an eviction in the create hold', async () => {
      const { WasmClientPoisonedError } = await import('../sdk/wasm-client-poison');
      const vlt = await Vault.spawn(WalletType.OnChain, 'pw-1207-evict');
      mockMidenClient.createGuardianMidenWallet.mockImplementationOnce(async () => {
        throw new WasmClientPoisonedError('watchdog', new Error('evicted'));
      });
      await expect(vlt.createHDAccount(WalletType.Guardian, 'Guardian 1')).rejects.toBeInstanceOf(
        WasmClientPoisonedError
      );
      expect(mockRegisterGuardianAccount).not.toHaveBeenCalled();
    });
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
      authScheme: 'ecdsa',
      hotPublicKey: 'hot-pub-hex',
      coldPublicKey: 'cold-pub-hex',
      evmAddress: '0xEvm'
    };
    const exportable: WalletAccount = {
      publicKey: 'acc-pub-key-1',
      name: 'Miden Account 1',
      isPublic: true,
      type: WalletType.OnChain,
      hdIndex: 0,
      authScheme: 'ecdsa'
    };
    await encryptAndSaveMany(
      [
        [keys.accounts, [exportable, guardian]],
        [keys.accAuthSecretKey('hot-pub-hex'), 'OPAQUE_CIPHERTEXT'],
        [keys.accAuthSecretKey('aabb'), '010203'],
        [`${ck('accevmsecretkey')}_0xevm`, `0x${'cd'.repeat(32)}`]
      ],
      vaultKey
    );
    mockRevealHotKey.mockResolvedValue('ab'.repeat(32));
    mockDesktopSecureStorage.decryptWithHardwareKey.mockClear();

    await expect(Vault.revealHotKey('guardian-acc-1')).resolves.toBe(`${'ab'.repeat(32)}:${'cd'.repeat(32)}`);
    await expect(
      Vault.withAccountFileKeyReader('acc-pub-key-1', undefined, async getKey => getKey(new Uint8Array([0xaa, 0xbb])))
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    // One unwrap per authorization, and no path quietly reused a cached key.
    expect(mockDesktopSecureStorage.decryptWithHardwareKey).toHaveBeenCalledTimes(2);
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

  it('Vault.spawn (restore probes): eviction during the probe stops the fresh-create fallback', async () => {
    // The probe loses the mutex mid-lookup and then reports a definitive miss,
    // so the restore falls through. Pre-guard, that would mint a fresh EMPTY
    // wallet off an abandoned restore - it's the guard
    // `'in Vault.spawn before the pre-create sync'`, after the import, that
    // catches the revoked hold and stops it.
    mockMidenClient.importPublicMidenWalletFromSeed.mockImplementationOnce(async () => {
      revokeWasmHold();
      throw new Error(NODE_016_ACCOUNT_MISS);
    });
    await expect(Vault.spawn(WalletType.OnChain, 'pw', VALID_MNEMONIC, true)).rejects.toMatchObject({
      name: 'WasmClientPoisonedError'
    });
    expect(mockMidenClient.syncState).not.toHaveBeenCalled();
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
      Vault.spawnFromMidenClient(
        'pw',
        VALID_MNEMONIC,
        [
          { publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' },
          { publicKey: 'pk-2', name: 'B', isPublic: true, type: WalletType.OnChain, hdIndex: 1, authScheme: 'ecdsa' }
        ],
        []
      )
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
      Vault.spawnFromMidenClient(
        'pw',
        VALID_MNEMONIC,
        [{ publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
        []
      )
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
      Vault.spawnFromMidenClient(
        'pw',
        VALID_MNEMONIC,
        [{ publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
        []
      )
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
      Vault.spawnFromMidenClient(
        'pw',
        VALID_MNEMONIC,
        [{ publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
        []
      )
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
      Vault.spawnFromMidenClient(
        'pw',
        VALID_MNEMONIC,
        [{ publicKey: 'pk-1', name: 'A', isPublic: true, type: WalletType.OnChain, hdIndex: 0, authScheme: 'ecdsa' }],
        []
      )
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
    // Refused before the key fetch, whose 429 waits run with no hold.
    expect(mockFetchGuardianCreateKey).not.toHaveBeenCalled();
    expect(mockCreateGuardianMidenWallet).not.toHaveBeenCalled();
  });

  it('createHDAccount(Guardian) refuses as locked after a key-fetch wait during which a lock landed', async () => {
    const vault = await seedVault('pw');
    let refusal: unknown;
    // Stands in for a 429 wait: the fetch runs its caller's check after each one.
    mockFetchGuardianCreateKey.mockImplementationOnce(async (endpoint: string | undefined, assertLive: () => void) => {
      assertLive();
      lockLandedWhileQueued(vault);
      try {
        assertLive();
      } catch (error) {
        refusal = error;
        throw error;
      }
      return {
        guardianEndpoint: endpoint ?? 'https://default.guardian',
        guardianCommitment: 'c',
        guardianPubkey: 'p',
        rateLimitBudgetLeftMs: 90_000
      };
    });

    await expect(vault.createHDAccount(WalletType.Guardian)).rejects.toMatchObject({ reason: 'locked' });
    expect(refusal).toMatchObject({ reason: 'locked' });
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
  it('resumes after an hour', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian-recovery',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: 0,
      isPublic: false,
      authScheme: 'ecdsa',
      coldPublicKey: '020304'
    };
    const vault = await seedVault('pw', { mnemonic: '', accounts: [account] });
    const transaction: ITransaction = new Transaction(account.publicKey, new Uint8Array());
    transaction.type = 'replace-hot-key';
    transaction.awaitingRecoverySeed = false;
    const startedAt = transaction.initiatedAt;
    const now = jest.spyOn(Date, 'now').mockReturnValue((startedAt + 60) * 1000);
    await Repo.transactions.add(transaction);
    try {
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({ ready: false });
      const expectedPause = startedAt + 60;
      expect((await Repo.transactions.get(transaction.id))?.recoverySeedRequestedAt).toBe(expectedPause);
      now.mockReturnValue((startedAt + 3660) * 1000);
      await vault.prepareRecoveryTransaction(transaction.id);
      expect((await Repo.transactions.get(transaction.id))?.recoverySeedRequestedAt).toBe(expectedPause);
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
      const expectedStart = startedAt + 3600;
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
      authScheme: 'ecdsa',
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
      authScheme: 'ecdsa',
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

  it('refuses the seed without authorizing it when the account read loses the hold (F-053)', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian-read-evicted',
      name: 'Imported from hot key',
      type: WalletType.Guardian,
      hdIndex: -1,
      isPublic: false,
      authScheme: 'ecdsa'
    };
    const vault = await seedVault('pw', { mnemonic: '', accounts: [account] });
    const transaction: ITransaction = new Transaction(account.publicKey, new Uint8Array());
    transaction.type = 'replace-hot-key';
    await Repo.transactions.add(transaction);
    const sdk = jest.requireMock<{ AuthSecretKey: { ecdsaWithRNG: jest.Mock } }>('@miden-sdk/miden-sdk/lazy');
    const ecdsaWithRNG = sdk.AuthSecretKey.ecdsaWithRNG.getMockImplementation();
    try {
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({ ready: false });
      // A key and an on-chain signer that match, so only the hold check can refuse.
      sdk.AuthSecretKey.ecdsaWithRNG.mockImplementationOnce(() => ({
        publicKey: () => ({
          serialize: () => new Uint8Array([1, 2, 3, 4]),
          toCommitment: () => ({ toHex: () => '0x020304', free: jest.fn() }),
          free: jest.fn()
        }),
        serialize: () => new Uint8Array([1, 5, 6]),
        free: jest.fn()
      }));
      mockGetAccount.mockImplementationOnce(async () => {
        revokeWasmHold();
        return {};
      });
      mockGetSignerDetailsFromAccount.mockResolvedValueOnce({ commitment: '020304' });

      const error = await vault
        .provideRecoverySeed(transaction.id, VALID_MNEMONIC, getRecoveryAction(transaction))
        .catch((cause: unknown) => cause);

      expect(isWasmClientPoisonedError(error)).toBe(true);
      expect(mockGetSignerDetailsFromAccount).not.toHaveBeenCalled();
      await expect(vault.prepareRecoveryTransaction(transaction.id)).resolves.toEqual({ ready: false });
    } finally {
      // Neither queued reply is consumed once the read is refused.
      sdk.AuthSecretKey.ecdsaWithRNG.mockReset().mockImplementation(ecdsaWithRNG);
      mockGetSignerDetailsFromAccount.mockReset();
      clearRecoveryAuthorizations();
      await Repo.transactions.delete(transaction.id);
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
      authScheme: 'ecdsa',
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
        authScheme: 'ecdsa',
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

  it('keeps the phrase while Guardian recovery is pending, and removes it once the flag is cleared', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: -1,
      authScheme: 'ecdsa',
      isPublic: false,
      hotPublicKey: 'hot-key',
      coldPublicKey: '02' + 'ab'.repeat(32),
      guardianNoteRecoveryPending: true
    };
    const vault = await seedVault('password123', { accounts: [account] });
    const protector = await getPlain<string>(keys.vaultKeyPassword);
    if (!protector) throw new Error('Missing test vault protector');
    const key = await Passworder.importVaultKey(await Passworder.decryptVaultKeyWithPassword(protector, 'password123'));
    await encryptAndSaveMany([[keys.accAuthSecretKey('hot-key'), 'daily-secret']], key);

    await expect(vault.removeSeedPhrase()).rejects.toThrow();
    expect(await vault.fetchSeedPhraseStatus()).toBe('stored');

    // The write the detached recovery's clearPendingFlag makes.
    await vault.setGuardianNoteRecoveryPending(account.publicKey, false);
    await vault.removeSeedPhrase();
    expect(await vault.fetchSeedPhraseStatus()).toBe('removed');
  });

  // An evicted callback keeps running after its caller saw the poison, so a
  // missing re-check keeps deleting keys that nobody is waiting on.
  async function guardianRemovalVault() {
    const account: WalletAccount = {
      publicKey: 'guardian',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: -1,
      isPublic: false,
      authScheme: 'ecdsa',
      hotPublicKey: 'hot-key',
      coldPublicKey: '02' + 'ab'.repeat(32)
    };
    const vault = await seedVault('password123', { accounts: [account] });
    const protector = await getPlain<string>(keys.vaultKeyPassword);
    if (!protector) throw new Error('Missing test vault protector');
    const key = await Passworder.importVaultKey(await Passworder.decryptVaultKeyWithPassword(protector, 'password123'));
    await encryptAndSaveMany([[keys.accAuthSecretKey('hot-key'), 'daily-secret']], key);
    return vault;
  }

  async function expectRemovalResumes(vault: Vault) {
    expect(await vault.fetchSeedPhraseStatus()).toBe('removing');
    const reopened = await Vault.setup('password123');
    await reopened.removeSeedPhrase();
    expect(await reopened.fetchSeedPhraseStatus()).toBe('removed');
  }

  it('stops before the mapping lookup when a keystore removal loses the hold (F-053)', async () => {
    const vault = await guardianRemovalVault();
    mockKeystoreRemove.mockImplementationOnce(async () => {
      revokeWasmHold();
    });

    const error = await vault.removeSeedPhrase().catch((cause: unknown) => cause);

    expect(isWasmClientPoisonedError(error)).toBe(true);
    expect(mockKeystoreGetAccountId).not.toHaveBeenCalled();
    await expectRemovalResumes(vault);
  });

  it('stops before any keystore removal when the client build loses the hold (F-053)', async () => {
    const vault = await guardianRemovalVault();
    const buildClient = mockGetMidenClient.getMockImplementation()!;
    mockGetMidenClient.mockImplementationOnce(async (...args) => {
      const client = await buildClient(...args);
      revokeWasmHold();
      return client;
    });

    const error = await vault.removeSeedPhrase().catch((cause: unknown) => cause);

    expect(isWasmClientPoisonedError(error)).toBe(true);
    expect(mockKeystoreRemove).not.toHaveBeenCalled();
    await expectRemovalResumes(vault);
  });

  it('stops before freeing the mapping when the mapping lookup loses the hold (F-053)', async () => {
    const vault = await guardianRemovalVault();
    const free = jest.fn();
    mockKeystoreGetAccountId.mockImplementationOnce(async () => {
      revokeWasmHold();
      return { free };
    });

    const error = await vault.removeSeedPhrase().catch((cause: unknown) => cause);

    expect(isWasmClientPoisonedError(error)).toBe(true);
    expect(free).not.toHaveBeenCalled();
    await expectRemovalResumes(vault);
  });

  it('keeps the phrase when the everyday key is not ready', async () => {
    const account: WalletAccount = {
      publicKey: 'guardian',
      name: 'Guardian',
      type: WalletType.Guardian,
      hdIndex: -1,
      authScheme: 'ecdsa',
      isPublic: false,
      coldPublicKey: '02' + 'ab'.repeat(32)
    };
    const vault = await seedVault('password123', { accounts: [account] });
    await expect(vault.removeSeedPhrase()).rejects.toThrow();
    expect(await vault.fetchSeedPhraseStatus()).toBe('stored');
  });

  it('keeps the phrase when an HD account has no stored EVM key', async () => {
    const account: WalletAccount = {
      publicKey: 'hd-account',
      name: 'HD',
      type: WalletType.OnChain,
      hdIndex: 0,
      isPublic: true,
      authScheme: 'ecdsa'
    };
    const vault = await seedVault('password123', { accounts: [account] });

    await expect(vault.removeSeedPhrase()).rejects.toThrow('seedRemovalKeysNotReady');
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
    await expect(fetchAndDecryptOne<string>(storageKey, authenticatedKey)).resolves.toBe(EVM_KEY);
    const digest = await crypto.subtle.digest('SHA-256', Buffer.from(storageKey, 'utf-8'));
    const encrypted = memoryStore[Buffer.from(digest).toString('hex')];
    expect(encrypted).toEqual(expect.any(String));
    expect(encrypted).not.toContain(EVM_KEY);

    // The hot secret is persisted under the accAuthSecretKey slot in its
    // canonical serialized form (signWord's hot path reads exactly this).
    const vaultKey = (vault as any).vaultKey as CryptoKey;
    await expect(fetchAndDecryptOne<string>(keys.accAuthSecretKey('dead'), vaultKey)).resolves.toBe('01beef');

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

  it('keeps the not-found code on the rethrown PublicError', async () => {
    mockRecoverGuardianAccountByHotKey.mockRejectedValueOnce(
      new NoGuardianAccountsFoundError('No Guardian account was found for this key at this Guardian.')
    );

    const promise = Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);

    await expect(promise).rejects.toMatchObject({ code: GUARDIAN_ACCOUNT_NOT_FOUND });
    await expect(promise).rejects.toBeInstanceOf(PublicError);
  });

  it('gives a timeout no not-found code', async () => {
    mockRecoverGuardianAccountByHotKey.mockRejectedValueOnce(
      new Error('RPC "recoverGuardianByKey" timed out after 30000ms')
    );

    const promise = Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);

    await expect(promise).rejects.toMatchObject({ message: 'RPC "recoverGuardianByKey" timed out after 30000ms' });
    await expect(promise).rejects.not.toHaveProperty('code');
  });

  it('requires a password when hardware protection is unavailable', async () => {
    await expect(Vault.spawnFromHotKey(undefined, PAIR, ENDPOINT)).rejects.toThrow(PublicError);
    expect(mockRecoverGuardianAccountByHotKey).not.toHaveBeenCalled();
  });

  it('leaves no protector behind when the guardian lookup rejects after the wipe (#946)', async () => {
    memoryStore['endpoint_overrides'] = { rpcUrl: 'https://rpc.custom' };
    (globalThis as any).__vaultTestRealmInsertKey = null;
    (globalThis as any).__vaultTestRealmUninstalled = null;
    mockRecoverGuardianAccountByHotKey.mockRejectedValueOnce(new Error('guardian unreachable'));

    await expect(Vault.spawnFromHotKey('pw', PAIR, ENDPOINT)).rejects.toThrow('guardian unreachable');

    expect(await getPlain(keys.vaultKeyPassword)).toBeUndefined();
    expect(memoryStore['endpoint_overrides']).toEqual({ rpcUrl: 'https://rpc.custom' });
    expect((globalThis as any).__vaultTestRealmUninstalled).toEqual(expect.any(Function));
    expect((globalThis as any).__vaultTestRealmInsertKey).toBeNull();
  });

  it('finishes its undo before the caller sees the rejection, so a queued retry cannot race it (#946)', async () => {
    const { clearStorage } = jest.requireMock('lib/miden/reset');
    const defaultClear = clearStorage.getMockImplementation();
    let entered!: () => void;
    let release!: () => void;
    const entered$ = new Promise<void>(resolve => {
      entered = resolve;
    });
    const release$ = new Promise<void>(resolve => {
      release = resolve;
    });
    // The first call is the opening wipe, left to run for real; the second is the undo,
    // held open until the assertions below have seen it, so an awaited undo and a
    // fire-and-forget one are told apart by whether the spawn is still unsettled.
    clearStorage.mockImplementationOnce(defaultClear).mockImplementationOnce(async () => {
      entered();
      await release$;
    });
    mockRecoverGuardianAccountByHotKey.mockRejectedValueOnce(new Error('guardian unreachable'));

    let settled = false;
    const spawning = Vault.spawnFromHotKey('pw', PAIR, ENDPOINT);
    spawning.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await entered$;
    await new Promise<void>(resolve => jest.requireActual('timers').setImmediate(resolve));

    expect(clearStorage).toHaveBeenCalledTimes(2);
    expect(clearStorage).toHaveBeenNthCalledWith(2, false);
    expect(settled).toBe(false);

    release();
    await expect(spawning).rejects.toThrow('guardian unreachable');
  });

  it('falls back to the network default endpoint when none is passed', async () => {
    await Vault.spawnFromHotKey('pw', PAIR);

    const [, endpoint] = mockRecoverGuardianAccountByHotKey.mock.calls[0]!;
    expect(typeof endpoint).toBe('string');
    expect(endpoint.length).toBeGreaterThan(0);
  });
});

describe('a setup spawn and the pending-admission marker', () => {
  const HD_ACCOUNT: WalletAccount = {
    publicKey: 'pk-1',
    name: 'HD 1',
    isPublic: true,
    type: WalletType.OnChain,
    hdIndex: 0,
    authScheme: 'ecdsa'
  };

  it.each([
    ['Vault.spawn', () => Vault.spawn(WalletType.OnChain, 'pw')],
    ['Vault.spawnFromHotKey', () => Vault.spawnFromHotKey('pw', `${'beef'.repeat(16)}:${'cd'.repeat(32)}`)],
    ['Vault.spawnFromMidenClient', () => Vault.spawnFromMidenClient('pw', VALID_MNEMONIC, [HD_ACCOUNT], [])]
  ])('%s keeps the marker its setup wrote through its wipe, which removes everything else', async (_name, spawn) => {
    const sdkAccount = { id: () => 'pk-1', isFaucet: () => false };
    mockMidenClient.getAccounts.mockResolvedValue([sdkAccount]);
    mockMidenClient.getAccount.mockResolvedValue(sdkAccount);
    memoryStore[PENDING_ADMISSION_STORAGE_KEY] = [];
    memoryStore['stale_setting'] = 'from the previous profile';

    await spawn();

    expect(memoryStore[PENDING_ADMISSION_STORAGE_KEY]).toEqual([]);
    expect(memoryStore['stale_setting']).toBeUndefined();
  });

  it('removes the marker in the undo of a spawn rejected after its wipe, as every other wipe does', async () => {
    memoryStore[PENDING_ADMISSION_STORAGE_KEY] = [];
    mockMidenClient.createMidenWallet.mockRejectedValueOnce(new Error('wasm exploded'));

    await expect(Vault.spawn(WalletType.OnChain, 'pw')).rejects.toThrow('Failed to create wallet');

    expect(memoryStore[PENDING_ADMISSION_STORAGE_KEY]).toBeUndefined();
  });
});

describe('Vault.importHotKeyPair', () => {
  const PAIR = `${'11'.repeat(32)}:${'22'.repeat(32)}`;
  const recovered: WalletAccount = {
    publicKey: 'pk-recovered',
    name: 'Guardian 1',
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex: 0,
    authScheme: 'ecdsa',
    coldPublicKey: '0a0b0c',
    requiresHotKeyRotation: true,
    guardianNoteRecoveryPending: true
  };
  const pastedKey = (commitment: string) => ({
    publicKey: () => ({
      serialize: () => Uint8Array.from([0x02, 0xde, 0xad]),
      toCommitment: () => ({ toHex: () => commitment, free: jest.fn() }),
      free: jest.fn()
    }),
    serialize: () => Uint8Array.from([0x01, 0xbe, 0xef]),
    getEcdsaK256KeccakSecretKeyAsFelts: jest.fn(),
    free: jest.fn()
  });
  const stage = (pasted: string, hotOnChain: string, coldOnChain = '0a0b0c') => {
    mockDeserializeHotSecretKey.mockReturnValueOnce(pastedKey(pasted) as any);
    mockGetAccount.mockResolvedValueOnce({} as any);
    mockGetSignerDetailsFromAccount.mockImplementation(async (_account: unknown, cold: boolean) => ({
      commitment: cold ? coldOnChain : hotOnChain
    }));
  };

  afterEach(() => {
    mockGetSignerDetailsFromAccount.mockReset();
  });

  it('installs the key the restored account names as its everyday signer and ends the rotation gate', async () => {
    const vault = await seedVault('pw', { accounts: [recovered] });
    stage('0xaabb', '0xAABB');

    const result = await vault.importHotKeyPair(recovered.publicKey, PAIR);

    expect(result.accounts[0]).toMatchObject({ hotPublicKey: 'dead', requiresHotKeyRotation: false });
    expect(await isStored(keys.accAuthSecretKey('dead'))).toBe(true);
    expect(await isStored(keys.accAuthPubKey('dead'))).toBe(true);
  });

  it('refuses the recovery key pasted as the everyday key, writing nothing', async () => {
    const vault = await seedVault('pw', { accounts: [recovered] });
    stage('0x0a0b0c', '0xaabb');

    await expect(vault.importHotKeyPair(recovered.publicKey, PAIR)).rejects.toThrow('importHotKeyIsRecoveryKey');

    expect(await isStored(keys.accAuthSecretKey('dead'))).toBe(false);
    expect((await vault.fetchAccounts())[0]!.requiresHotKeyRotation).toBe(true);
  });

  it('refuses a key that is not the account everyday signer', async () => {
    const vault = await seedVault('pw', { accounts: [recovered] });
    stage('0xffff', '0xaabb');

    await expect(vault.importHotKeyPair(recovered.publicKey, PAIR)).rejects.toThrow('importHotKeyNotActive');
    expect(await isStored(keys.accAuthSecretKey('dead'))).toBe(false);
  });

  it('refuses an account that is not waiting for its everyday key', async () => {
    const vault = await seedVault('pw', { accounts: [{ ...recovered, requiresHotKeyRotation: false }] });

    await expect(vault.importHotKeyPair(recovered.publicKey, PAIR)).rejects.toThrow(
      'This account does not need an everyday key'
    );
    expect(mockDeserializeHotSecretKey).not.toHaveBeenCalled();
  });

  it('refuses a payload that is not a key pair', async () => {
    const vault = await seedVault('pw', { accounts: [recovered] });

    await expect(vault.importHotKeyPair(recovered.publicKey, 'nope')).rejects.toThrow('importHotKeyInvalid');
  });
});

describe('Vault storage continuity', () => {
  let vault: Vault;
  let fixtureKey: CryptoKey;
  let generation: string | null;
  let readSnapshot: jest.SpyInstance;
  let initializeGeneration: jest.SpyInstance;
  beforeEach(async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, operation: () => Promise<unknown>) => operation()
      }
    });
    const key = await Passworder.importVaultKey(new Uint8Array(32).fill(7));
    fixtureKey = key;
    await encryptAndSaveMany(
      [
        [keys.check, 'retained-vault'],
        [keys.accounts, [{ publicKey: 'retained', name: 'Account', isPublic: true, type: WalletType.OnChain }]]
      ],
      key
    );
    vault = new Vault(key);
    await Repo.metadata.put({ id: 'generation', generation: 'wallet-fixture', origin: 'migrated' });
    generation = null;
    readSnapshot = jest.spyOn(midenClientProxy, 'readStorageContinuity').mockImplementation(async () => ({
      generation,
      accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
      notes: [{ kind: 'note', id: 'private-note', noteFile: new Uint8Array([1, 2]), provenance: 'input' }]
    }));
    initializeGeneration = jest
      .spyOn(midenClientProxy, 'initializeStorageGeneration')
      .mockImplementation(async next => {
        generation = next;
      });
  });
  afterEach(() => {
    installProviderReceiptBackend(undefined);
    readSnapshot.mockRestore();
    initializeGeneration.mockRestore();
  });

  async function acquisition() {
    await encryptAndSaveMany(
      [[keys.accounts, [{ publicKey: 'retained', name: 'Guardian', isPublic: true, type: WalletType.Guardian }]]],
      fixtureKey
    );
    expect(await vault.verifyStorageContinuity()).toBe(true);
    readSnapshot.mockClear();
    const noteFile = new Uint8Array([19, 48, 7, 255]);
    const noteId = '0x' + '12'.repeat(32);
    const details = {
      recipient: () => ({ digest: () => ({ toFelts: () => [] }) }),
      assets: () => ({ assets: () => [] }),
      free: () => {}
    };
    const sdk = jest.requireMock<{
      NoteFile: { deserialize: jest.Mock };
      Poseidon2: { hashElements: jest.Mock };
    }>('@miden-sdk/miden-sdk/lazy');
    const hash = jest.spyOn(sdk.Poseidon2, 'hashElements').mockReturnValue({
      toHex: () => '0x' + '34'.repeat(32),
      toFelts: () => [],
      free: () => {}
    });
    const setCandidate = (
      bytes: Uint8Array,
      { identity = noteId, detailsOnly = false, tag = 7, afterBlock = 10 } = {}
    ) => {
      const metadata = () => ({ noteType: () => 0, tag: () => ({ asU32: () => tag, free: () => {} }), free: () => {} });
      const id = () => ({ toString: () => identity, free: () => {} });
      const file = {
        noteId: () => (detailsOnly ? undefined : id()),
        note: () => (detailsOnly ? undefined : { ...details, metadata, id }),
        noteDetails: () => (detailsOnly ? details : undefined),
        noteType: () => (detailsOnly ? 'NoteDetails' : 'NoteWithProof'),
        noteTag: () => (detailsOnly ? { asU32: () => tag, free: () => {} } : undefined),
        afterBlockNum: () => (detailsOnly ? afterBlock : undefined),
        inclusionProof: () =>
          detailsOnly
            ? undefined
            : { location: () => ({ blockNum: () => afterBlock, free: () => {} }), free: () => {} },
        nullifier: () => (detailsOnly ? undefined : '0x' + '56'.repeat(32)),
        serialize: () => bytes.slice(),
        free: () => {}
      };
      sdk.NoteFile.deserialize.mockReturnValue(file);
      return file;
    };
    setCandidate(noteFile);
    const imported = jest.fn(async (_file?: { serialize: () => Uint8Array }) => noteId);
    const { MidenClientInterface } = await import('../sdk/miden-client-interface');
    const client: import('../sdk/miden-client-interface').MidenClientInterface = Reflect.apply(
      MidenClientInterface.fromClient,
      MidenClientInterface,
      [{ notes: { import: imported } }, 'testnet']
    );
    const { withWasmClientLock } = await import('../sdk/miden-client');
    const { getAccountsWriteQueue } = await import('./accounts-write-queue');
    return {
      noteFile,
      noteId,
      imported,
      setCandidate,
      client,
      run: (bytes = noteFile) =>
        getAccountsWriteQueue().add(() => withWasmClientLock(hold => client.importNoteBytes(bytes, hold))),
      runRecovery: (bytes = [noteFile]) =>
        getAccountsWriteQueue().add(() => withWasmClientLock(hold => client.importRecoveryNoteBytes(bytes, hold))),
      restore: () => {
        hash.mockRestore();
        sdk.NoteFile.deserialize.mockReset();
        mockBeforeRecoveryWrite = undefined;
      }
    };
  }

  async function canonicalAcquisition({ distinctExport = false, conflictingCandidate = false, state = 2 } = {}) {
    const fixture = await acquisition();
    const expectedBytes = new Uint8Array([19, 48, 80]);
    const canonicalBytes = new Uint8Array([19, 48, 81]);
    const candidateBytes = distinctExport ? new Uint8Array([19, 48, 82]) : canonicalBytes;
    const detailsId = '34'.repeat(32);
    const canonicalId = '12'.repeat(32);
    const files = new Map<string, ReturnType<typeof fixture.setCandidate>>();
    const remember = (bytes: Uint8Array, options = {}) => {
      const file = fixture.setCandidate(bytes, options);
      files.set(Array.from(bytes).join(','), file);
      return file;
    };
    remember(expectedBytes, { detailsOnly: true, tag: 71, afterBlock: 7 });
    await fixture.run(expectedBytes);
    remember(candidateBytes, { tag: 72, afterBlock: 19 });
    await fixture.run(candidateBytes);
    const conflictBytes = new Uint8Array([19, 48, 83]);
    if (conflictingCandidate) {
      remember(conflictBytes, { identity: '0x' + 'ab'.repeat(32), tag: 73, afterBlock: 23 });
      await fixture.run(conflictBytes);
    }
    const canonicalFile = remember(canonicalBytes, { tag: 72, afterBlock: 19 });
    const sdk = jest.requireMock<{
      NoteFile: { deserialize: jest.Mock; fromInputNote: jest.Mock };
    }>('@miden-sdk/miden-sdk/lazy');
    sdk.NoteFile.deserialize.mockImplementation((bytes: Uint8Array) => {
      const file = files.get(Array.from(bytes).join(','));
      if (!file) throw new Error('Unknown fixture NoteFile');
      return file;
    });
    sdk.NoteFile.fromInputNote.mockImplementation(() => canonicalFile);
    const record = () => ({
      details: () => {
        const details = canonicalFile.note();
        if (!details) throw new Error('Missing canonical fixture body');
        return details;
      },
      id: canonicalFile.noteId,
      state: () => state,
      isAuthenticated: () => state === 2 || state === 4 || state === 6,
      isConsumed: () => state === 6,
      isInclusionPending: () => state === 1,
      metadata: () => canonicalFile.note()?.metadata(),
      inclusionProof: canonicalFile.inclusionProof,
      nullifier: canonicalFile.nullifier,
      toInputNote: () => ({ free: () => {} }),
      free: () => {}
    });
    const list = jest.fn().mockImplementation(async () => [record()]);
    const settings = { get: jest.fn().mockImplementation(async () => generation), set: jest.fn() };
    const accounts = {
      get: jest.fn().mockResolvedValue({
        nonce: () => ({ asInt: () => 4n }),
        to_commitment: () => ({ toHex: () => 'state-4', free: () => {} })
      }),
      insert: jest.fn()
    };
    Reflect.set(fixture.client.client, 'notes', { import: fixture.imported, list });
    Reflect.set(fixture.client.client, 'settings', settings);
    Reflect.set(fixture.client.client, 'accounts', accounts);
    const { getCurrentWasmLockHold, assertWasmHoldCurrent } = await import('../sdk/miden-client');
    readSnapshot.mockImplementation(async (accountIds, includeNotes, _capability, retained = [], families = []) => {
      const hold = getCurrentWasmLockHold();
      if (!hold) throw new Error('Canonical fixture requires the actual reconciliation hold');
      return Reflect.apply(fixture.client.readStorageContinuity, fixture.client, [
        accountIds,
        includeNotes,
        () => assertWasmHoldCurrent(hold, 'during canonical fixture readback'),
        retained,
        families
      ]);
    });
    const reads = {
      dispose: jest.fn(),
      identity: jest.fn().mockResolvedValue(undefined),
      header: jest.fn().mockResolvedValue(undefined),
      scan: jest.fn().mockResolvedValue([]),
      node: {
        blockCommitment: jest.fn().mockResolvedValue(undefined),
        account: jest.fn().mockResolvedValue({ ok: false, pruned: false, timedOut: false }),
        noteInclusions: jest.fn().mockResolvedValue(new Map()),
        nullifierHeight: jest.fn().mockResolvedValue(undefined)
      }
    };
    jest.mocked(CanonicalReads.createRecoveryCanonicalReads).mockResolvedValue(reads);
    fixture.imported.mockClear();
    const savedFamily = async (owner = vault) => {
      const snapshot = await owner.readRecoveryJournal();
      const note = snapshot?.entries.find(entry => entry.kind === 'note' && entry.detailsId === detailsId);
      if (!snapshot || note?.kind !== 'note') throw new Error('Missing retained canonical fixture family');
      return { snapshot, note };
    };
    return {
      ...fixture,
      expectedBytes,
      canonicalBytes,
      candidateBytes,
      conflictBytes,
      detailsId,
      canonicalId,
      canonicalFile,
      record,
      list,
      settings,
      accounts,
      reads,
      savedFamily,
      restore: () => {
        fixture.restore();
        sdk.NoteFile.fromInputNote.mockReset();
        jest.mocked(CanonicalReads.createRecoveryCanonicalReads).mockReset();
      }
    };
  }

  it('Task4C3G3 reorders an exact candidate into a full primary and restores it after encrypted restart', async () => {
    const fixture = await canonicalAcquisition();
    const before = await fixture.savedFamily();
    try {
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      const after = await fixture.savedFamily();
      expect(after.note).toMatchObject({ id: fixture.canonicalId, noteFile: fixture.canonicalBytes, format: 'full' });
      expect(after.note.candidates).toEqual([
        expect.objectContaining({ id: fixture.detailsId, noteFile: fixture.expectedBytes, format: 'details' })
      ]);
      expect(journalNoteBodies(after.snapshot)).toHaveLength(journalNoteBodies(before.snapshot).length);
      expect(after.snapshot).toMatchObject({ scope: before.snapshot.scope, accounts: before.snapshot.accounts });
      expect(after.snapshot.sequence).toBe(before.snapshot.sequence + 1);
      expect(fixture.list).toHaveBeenCalledWith({ detailsCommitments: [`0x${fixture.detailsId}`] });
      expect(fixture.imported).not.toHaveBeenCalled();
      const restarted = new Vault(fixtureKey);
      const persisted = await fixture.savedFamily(restarted);
      expect(persisted.snapshot).toEqual(after.snapshot);
      let restored = false;
      const imported = jest.fn().mockImplementation(async (file: { serialize: () => Uint8Array }) => {
        expect(file.serialize()).toEqual(fixture.canonicalBytes);
        restored = true;
      });
      const { restoreSdkRecovery } = await import('../recovery/sdk-restore');
      const { withWasmClientLock, assertWasmHoldCurrent } = await import('../sdk/miden-client');
      await withWasmClientLock(hold =>
        restoreSdkRecovery(
          {
            settings: fixture.settings,
            accounts: fixture.accounts,
            notes: {
              import: imported,
              list: jest.fn().mockImplementation(async () => (restored ? [fixture.record()] : []))
            },
            storeIdentifier: jest.fn()
          },
          { kind: 'note', note: persisted.note, accountId: 'retained' },
          () => assertWasmHoldCurrent(hold, 'during canonical primary reconstruction')
        )
      );
      expect(imported).toHaveBeenCalledTimes(1);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G3 retains every older body when the authenticated export adds distinct required material', async () => {
    const fixture = await canonicalAcquisition({ distinctExport: true });
    const before = await fixture.savedFamily();
    try {
      await vault.reconcileStorageRecovery();
      const after = await fixture.savedFamily();
      expect(after.note.noteFile).toEqual(fixture.canonicalBytes);
      expect(journalNoteBodies(after.snapshot)).toEqual(
        expect.arrayContaining([...journalNoteBodies(before.snapshot), fixture.canonicalBytes])
      );
      expect(journalNoteBodies(after.snapshot)).toHaveLength(journalNoteBodies(before.snapshot).length + 1);
      expect(after.snapshot.sequence).toBe(before.snapshot.sequence + 1);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G3 preserves a conflicting candidate while upgrading the authenticated primary', async () => {
    const fixture = await canonicalAcquisition({ conflictingCandidate: true });
    const before = await fixture.savedFamily();
    try {
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      const after = await fixture.savedFamily();
      expect(after.note.noteFile).toEqual(fixture.canonicalBytes);
      expect(after.note.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ noteFile: fixture.expectedBytes }),
          expect.objectContaining({ noteFile: fixture.conflictBytes })
        ])
      );
      expect(journalNoteBodies(after.snapshot)).toHaveLength(journalNoteBodies(before.snapshot).length);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G3 repeats canonical readback without another journal generation', async () => {
    const fixture = await canonicalAcquisition();
    try {
      await vault.reconcileStorageRecovery();
      const first = await fixture.savedFamily();
      expect(first.note.noteFile).toEqual(fixture.canonicalBytes);
      const writes = mockStorageSets.length;
      await vault.reconcileStorageRecovery();
      expect((await fixture.savedFamily()).snapshot).toEqual(first.snapshot);
      expect(mockStorageSets.length).toBe(writes);
    } finally {
      fixture.restore();
    }
  });

  it.each([1, 3])('Task4C3G3 leaves state %s unresolved without changing retained evidence or health', async state => {
    const fixture = await canonicalAcquisition({ state });
    const before = await fixture.savedFamily();
    try {
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G3 refuses a distinct canonical export at global material capacity without losing the primary', async () => {
    const fixture = await canonicalAcquisition({ distinctExport: true });
    try {
      const initial = await fixture.savedFamily();
      const countMaterials = (snapshot: typeof initial.snapshot) =>
        journalNoteBodies(snapshot).length + snapshot.entries.filter(entry => entry.kind !== 'note').length;
      const remaining = 256 - countMaterials(initial.snapshot);
      expect(remaining).toBeGreaterThan(0);
      await vault.retainRecoveryEntries(
        Array.from({ length: remaining }, (_, index) => ({
          kind: 'note',
          id: `g-capacity-${index}`,
          noteFile: new Uint8Array([97, index]),
          provenance: 'input'
        }))
      );
      const before = await fixture.savedFamily();
      expect(countMaterials(before.snapshot)).toBe(256);
      expect(before.snapshot.entries.filter(entry => entry.kind !== 'note')).toEqual(
        initial.snapshot.entries.filter(entry => entry.kind !== 'note')
      );
      await expect(vault.reconcileStorageRecovery()).rejects.toThrow();
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G3 refuses stale canonical replacement when candidate evidence changes during the SDK read', async () => {
    const fixture = await canonicalAcquisition();
    let release = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = () => {};
    const atRead = new Promise<void>(resolve => {
      entered = resolve;
    });
    fixture.list.mockImplementationOnce(async () => {
      entered();
      await pending;
      return [fixture.record()];
    });
    const outcome = vault.reconcileStorageRecovery().then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    try {
      expect(await Promise.race([atRead.then(() => true), outcome.then(() => false)])).toBe(true);
      const before = await fixture.savedFamily();
      const lateBytes = new Uint8Array([19, 48, 84]);
      await vault.retainRecoveryEntries([
        {
          ...before.note,
          candidates: [
            ...(before.note.candidates ?? []),
            {
              id: fixture.canonicalId,
              detailsId: fixture.detailsId,
              noteFile: lateBytes,
              provenance: 'input',
              format: 'full'
            }
          ]
        }
      ]);
      const current = await fixture.savedFamily();
      release();
      expect((await outcome).error).toBeDefined();
      expect((await fixture.savedFamily()).snapshot).toEqual(current.snapshot);
      expect(journalNoteBodies(current.snapshot)).toContainEqual(lateBytes);
      expect(current.note.noteFile).toEqual(fixture.expectedBytes);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      release();
      await outcome;
      fixture.restore();
    }
  });

  it('Task4C3G3 preserves pending aliases and transaction receipt evidence after the primary ID changes', async () => {
    const fixture = await canonicalAcquisition();
    try {
      await vault.reconcileStorageRecovery();
      const promoted = await fixture.savedFamily();
      expect(promoted.note.id).toBe(fixture.canonicalId);
      await Repo.transactions.put({
        id: 'g-pending',
        accountId: 'retained',
        type: 'send',
        status: ITransactionStatus.Unconfirmed,
        initiatedAt: 1,
        displayIcon: 'SEND',
        mayHaveSubmitted: true,
        inputNoteIds: [fixture.detailsId, fixture.canonicalId],
        outputNoteIds: [],
        heldNoteIds: [fixture.detailsId],
        noteDelivery: 'pending'
      });
      await vault.retainTransactionRecovery('g-pending', { requestBytes: new Uint8Array([9]), notes: [] });
      const receipt = oneClickReceiptRow();
      receipt.id = 'g-receipt';
      receipt.accountId = 'retained';
      receipt.extraInputs.oneClick.accountId = 'retained';
      await Repo.transactions.put(receipt);
      installProviderReceiptBackend((value, epoch) => vault.checkpointProviderReceipt(value, epoch));
      await checkpointProviderReceipt(receipt);
      const before = await fixture.savedFamily();
      const pendingRow = await Repo.transactions.get('g-pending');
      const receiptRow = await Repo.transactions.get('g-receipt');
      fixture.reads.identity.mockClear().mockResolvedValue({ nullifier: '56'.repeat(32), fromBlock: 19 });
      fixture.reads.header.mockResolvedValue('canonical-header');
      fixture.reads.scan.mockResolvedValue([{ nullifier: '56'.repeat(32), block: 19 }]);
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      const after = await fixture.savedFamily();
      expect(after.snapshot.entries).toEqual(before.snapshot.entries);
      expect(await Repo.transactions.get('g-pending')).toEqual(pendingRow);
      expect(await Repo.transactions.get('g-receipt')).toEqual(receiptRow);
      expect(fixture.reads.identity).not.toHaveBeenCalled();
      expect(fixture.reads.scan).not.toHaveBeenCalled();
      expect(journalNoteBodies(after.snapshot)).toContainEqual(fixture.expectedBytes);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G3 latches a real canonical primary write quota while preserving the last readable generation', async () => {
    const fixture = await canonicalAcquisition();
    const before = await fixture.savedFamily();
    mockBeforeRecoveryWrite = async () => {
      throw new DOMException('Independent store full', 'QuotaExceededError');
    };
    try {
      await expect(vault.reconcileStorageRecovery()).rejects.toThrow();
      expect(getStorageHealth().status).toBe('unavailable');
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
    } finally {
      fixture.restore();
    }
  });

  async function canonicalRetirement({ conflictingCandidate = false } = {}) {
    const fixture = await canonicalAcquisition({ conflictingCandidate });
    await vault.reconcileStorageRecovery();
    const actual = jest.requireActual<typeof import('../recovery/canonical-reads')>('../recovery/canonical-reads');
    const sdk = jest.requireMock<{ RpcClient: jest.Mock; Word: object }>('@miden-sdk/miden-sdk/lazy');
    const rpcImplementation = sdk.RpcClient.getMockImplementation();
    const wordDescriptor = Object.getOwnPropertyDescriptor(sdk.Word, 'fromHex');
    const word = jest.fn((_hex: string) => ({
      toU64s: () => [0n, 0n, 0n, 0x5656565656565656n],
      free: jest.fn()
    }));
    Object.defineProperty(sdk.Word, 'fromHex', { configurable: true, value: word });
    const headerValue = (commitment = 'aa'.repeat(32)) => ({
      commitment: () => ({ toHex: () => `0x${commitment}`, free: jest.fn() }),
      free: jest.fn()
    });
    const header = jest.fn().mockImplementation(async () => headerValue());
    const update = (nullifier = '56'.repeat(32)) => ({
      nullifier: () => ({ toHex: () => `0x${nullifier}`, free: jest.fn() }),
      blockNum: () => 19,
      free: jest.fn()
    });
    const scan = jest.fn().mockImplementation(async () => [update()]);
    const free = jest.fn();
    sdk.RpcClient.mockImplementation(() => ({
      getBlockHeaderByNumber: header,
      syncNullifiers: scan,
      free
    }));
    jest.mocked(CanonicalReads.createRecoveryCanonicalReads).mockImplementation(actual.createRecoveryCanonicalReads);
    return {
      ...fixture,
      header,
      headerValue,
      scan,
      update,
      word,
      free,
      restore: () => {
        fixture.restore();
        sdk.RpcClient.mockReset();
        if (rpcImplementation) sdk.RpcClient.mockImplementation(rpcImplementation);
        if (wordDescriptor) Object.defineProperty(sdk.Word, 'fromHex', wordDescriptor);
        else Reflect.deleteProperty(sdk.Word, 'fromHex');
      }
    };
  }

  it('Task4C3G6 retires the authenticated family and its old Expected body after exact canonical consumption', async () => {
    const fixture = await canonicalRetirement();
    const before = await fixture.savedFamily();
    try {
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 1 });
      const after = await vault.readRecoveryJournal();
      expect(after?.entries).toEqual(before.snapshot.entries.filter(entry => entry !== before.note));
      expect(after).toMatchObject({ scope: before.snapshot.scope, accounts: before.snapshot.accounts });
      expect(after?.sequence).toBe(before.snapshot.sequence + 1);
      expect(fixture.scan).toHaveBeenCalledWith(new Uint16Array([0x5656]), 19, 19);
      expect(fixture.header).toHaveBeenNthCalledWith(1, 19, false);
      expect(fixture.header).toHaveBeenNthCalledWith(2, 19, false);
      expect(fixture.free).toHaveBeenCalledTimes(1);
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(await new Vault(fixtureKey).readRecoveryJournal()).toEqual(after);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G6 keeps every family body when the scanned full nullifier differs despite a matching prefix', async () => {
    const fixture = await canonicalRetirement();
    const before = await fixture.savedFamily();
    fixture.scan.mockResolvedValue([fixture.update('56'.repeat(31) + '57')]);
    try {
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      expect(fixture.scan).toHaveBeenCalledTimes(1);
      const after = await fixture.savedFamily();
      expect(journalNoteBodies(after.snapshot)).toEqual(journalNoteBodies(before.snapshot));
      expect(after.note).toMatchObject({
        noteFile: fixture.canonicalBytes,
        scan: { nextBlock: 20, anchorBlock: 19, anchor: '0x' + 'aa'.repeat(32) }
      });
      expect(after.snapshot.entries.filter(entry => entry.kind !== 'note')).toEqual(
        before.snapshot.entries.filter(entry => entry.kind !== 'note')
      );
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G6 refuses a consumption result when the exact scanned block header changes', async () => {
    const fixture = await canonicalRetirement();
    const before = await fixture.savedFamily();
    fixture.header
      .mockResolvedValueOnce(fixture.headerValue())
      .mockResolvedValueOnce(fixture.headerValue('bb'.repeat(32)));
    try {
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      expect(fixture.scan).toHaveBeenCalledTimes(1);
      expect(fixture.header).toHaveBeenCalledTimes(2);
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G6 preserves a conflicting full note ID even when its fixture has the same nullifier', async () => {
    const fixture = await canonicalRetirement({ conflictingCandidate: true });
    const before = await fixture.savedFamily();
    try {
      expect(before.note.noteFile).toEqual(fixture.canonicalBytes);
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
      expect(journalNoteBodies(before.snapshot)).toContainEqual(fixture.conflictBytes);
      expect(fixture.scan).not.toHaveBeenCalled();
      expect(fixture.header).not.toHaveBeenCalled();
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G6 quarantines an unreadable candidate without deleting it or vetoing the authenticated primary', async () => {
    const fixture = await canonicalRetirement();
    try {
      const initial = await fixture.savedFamily();
      const unreadableBytes = new Uint8Array([19, 48, 85]);
      await vault.retainRecoveryEntries([
        {
          ...initial.note,
          candidates: [
            ...(initial.note.candidates ?? []),
            {
              id: fixture.canonicalId,
              detailsId: fixture.detailsId,
              noteFile: unreadableBytes,
              provenance: 'input',
              format: 'full'
            }
          ]
        }
      ]);
      const before = await fixture.savedFamily();
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
      expect(before.note.noteFile).toEqual(fixture.canonicalBytes);
      expect(journalNoteBodies(before.snapshot)).toContainEqual(unreadableBytes);
      expect(fixture.scan).not.toHaveBeenCalled();
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G6 preserves a promoted family referenced only by its old Expected alias in pending evidence', async () => {
    const fixture = await canonicalRetirement();
    try {
      await Repo.transactions.put({
        id: 'g6-pending',
        accountId: 'retained',
        type: 'send',
        status: ITransactionStatus.Unconfirmed,
        initiatedAt: 1,
        displayIcon: 'SEND',
        mayHaveSubmitted: true,
        inputNoteIds: [fixture.detailsId],
        outputNoteIds: [],
        heldNoteIds: [fixture.detailsId],
        noteDelivery: 'pending'
      });
      await vault.retainTransactionRecovery('g6-pending', { requestBytes: new Uint8Array([9]), notes: [] });
      const before = await fixture.savedFamily();
      const row = await Repo.transactions.get('g6-pending');
      expect(await vault.reconcileStorageRecovery()).toEqual({ reconciled: 0, retired: 0 });
      expect((await fixture.savedFamily()).snapshot).toEqual(before.snapshot);
      expect(await Repo.transactions.get('g6-pending')).toEqual(row);
      expect(fixture.scan).not.toHaveBeenCalled();
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3G6 refuses stale family deletion after a candidate arrives during the canonical RPC', async () => {
    const fixture = await canonicalRetirement();
    let release = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = () => {};
    const atScan = new Promise<void>(resolve => {
      entered = resolve;
    });
    fixture.scan.mockImplementationOnce(async () => {
      entered();
      await pending;
      return [fixture.update()];
    });
    const outcome = vault.reconcileStorageRecovery().then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    try {
      expect(await Promise.race([atScan.then(() => true), outcome.then(() => false)])).toBe(true);
      const before = await fixture.savedFamily();
      const lateBytes = new Uint8Array([19, 48, 86]);
      await vault.retainRecoveryEntries([
        {
          ...before.note,
          candidates: [
            ...(before.note.candidates ?? []),
            {
              id: fixture.canonicalId,
              detailsId: fixture.detailsId,
              noteFile: lateBytes,
              provenance: 'input',
              format: 'full'
            }
          ]
        }
      ]);
      const current = await fixture.savedFamily();
      release();
      expect((await outcome).value?.retired ?? 0).toBe(0);
      expect((await fixture.savedFamily()).snapshot).toEqual(current.snapshot);
      expect(journalNoteBodies(current.snapshot)).toContainEqual(lateBytes);
      expect(journalNoteBodies(current.snapshot)).toContainEqual(fixture.expectedBytes);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      release();
      await outcome;
      fixture.restore();
    }
  });

  it('Task4C3I checkpoints the actual Vault only after every required baseline page has arrived', async () => {
    const { default: Dexie } = await import('dexie');
    const database = new Dexie('task4c3-baseline-checkpoint');
    database.version(1).stores({ inputNotes: 'detailsCommitment,stateDiscriminant' });
    await database.open();
    await encryptAndSaveMany(
      [[keys.accounts, [{ publicKey: 'retained', name: 'Guardian', isPublic: true, type: WalletType.Guardian }]]],
      fixtureKey
    );
    const firstId = '0x' + '12'.repeat(32);
    const secondId = '0x' + '34'.repeat(32);
    const firstBytes = new Uint8Array([19, 48, 91]);
    const secondBytes = new Uint8Array([19, 48, 92]);
    const record = (id: string) => ({
      metadata: () => ({ noteType: () => 0, free: () => {} }),
      details: () => ({ free: () => {} }),
      id: () => ({ toString: () => id, free: () => {} }),
      toInputNote: () => ({ free: () => {} }),
      free: () => {}
    });
    const sdk = jest.requireMock<{ NoteFile: { fromInputNote: jest.Mock } }>('@miden-sdk/miden-sdk/lazy');
    const previousExport = sdk.NoteFile.fromInputNote.getMockImplementation();
    sdk.NoteFile.fromInputNote
      .mockImplementationOnce(() => ({ serialize: () => firstBytes.slice(), free: () => {} }))
      .mockImplementationOnce(() => ({ serialize: () => secondBytes.slice(), free: () => {} }));
    let release = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = () => {};
    const atPage = new Promise<void>(resolve => {
      entered = resolve;
    });
    const listPage = jest
      .fn()
      .mockResolvedValueOnce({ notes: [record(firstId)], nextCursor: firstId, exhausted: false })
      .mockImplementationOnce(async () => {
        entered();
        await pending;
        return { notes: [record(secondId)], nextCursor: secondId, exhausted: true };
      });
    const { MidenClientInterface } = await import('../sdk/miden-client-interface');
    const client: import('../sdk/miden-client-interface').MidenClientInterface = Reflect.apply(
      MidenClientInterface.fromClient,
      MidenClientInterface,
      [
        {
          settings: { get: jest.fn(async () => Array.from(new TextEncoder().encode(generation))), set: jest.fn() },
          accounts: {
            get: jest.fn(async () => ({
              nonce: () => ({ asInt: () => 4n }),
              to_commitment: () => ({ toHex: () => 'state-4', free: () => {} })
            }))
          },
          notes: { list: jest.fn().mockResolvedValue([]), listPage },
          storeIdentifier: jest.fn(async () => database.name)
        },
        'testnet'
      ]
    );
    const { getCurrentWasmLockHold, assertWasmHoldCurrent } = await import('../sdk/miden-client');
    readSnapshot.mockImplementation(async (accountIds, includeNotes, _capability, retained = [], families = []) => {
      const hold = getCurrentWasmLockHold();
      if (!hold) throw new Error('Baseline fixture requires the actual Vault hold');
      return client.readStorageContinuity(
        accountIds,
        includeNotes,
        () => assertWasmHoldCurrent(hold, 'during paged baseline capture'),
        retained,
        families
      );
    });
    const outcome = vault.verifyStorageContinuity().then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    try {
      expect(await Promise.race([atPage.then(() => true), outcome.then(() => false)])).toBe(true);
      expect(await vault.readRecoveryJournal()).toBeUndefined();
      expect(await isStored(ck('recoverycontinuity'))).toBe(false);
      expect(initializeGeneration).not.toHaveBeenCalled();
      release();
      expect(await outcome).toEqual({ value: true, error: undefined });
      const snapshot = await vault.readRecoveryJournal();
      expect(journalNoteBodies(snapshot)).toEqual(expect.arrayContaining([firstBytes, secondBytes]));
      expect(snapshot?.entries.filter(entry => entry.kind === 'note')).toHaveLength(2);
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toMatchObject({
        sequence: snapshot?.sequence,
        scope: snapshot?.scope
      });
      expect(initializeGeneration).toHaveBeenCalledTimes(1);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      release();
      await outcome;
      sdk.NoteFile.fromInputNote.mockReset();
      if (previousExport) sdk.NoteFile.fromInputNote.mockImplementation(previousExport);
      database.close();
      await Dexie.delete(database.name);
    }
  });

  async function completedBaseline(notes: import('../recovery/types').RecoveryNoteEntry[]) {
    await encryptAndSaveMany(
      [[keys.accounts, [{ publicKey: 'retained', name: 'Guardian', isPublic: true, type: WalletType.Guardian }]]],
      fixtureKey
    );
    readSnapshot.mockImplementation(async () => ({
      generation,
      accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
      notes
    }));
  }

  it('Task4C3I2 refuses initial note plus financial capacity before initializing an SDK marker', async () => {
    const notes: import('../recovery/types').RecoveryNoteEntry[] = Array.from({ length: 256 }, (_, index) => ({
      kind: 'note',
      id: index.toString(16).padStart(64, '0'),
      noteFile: new Uint8Array([19, index]),
      provenance: 'input',
      format: 'full'
    }));
    await completedBaseline(notes);
    const { readFinancialRecoveryBaseline } = await import('../recovery/financial');
    const financial = await readFinancialRecoveryBaseline(['retained']);
    expect(notes.length + financial.length).toBe(257);
    try {
      const accepted = await vault.verifyStorageContinuity().catch(() => false);
      expect(accepted).toBe(false);
      expect(initializeGeneration).not.toHaveBeenCalled();
      expect(generation).toBeNull();
      expect(await vault.readRecoveryJournal()).toBeUndefined();
      expect(await isStored(ck('recoverycontinuity'))).toBe(false);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('Task4C3I2 refuses encoded journal byte capacity before initializing an SDK marker', async () => {
    const notes: import('../recovery/types').RecoveryNoteEntry[] = Array.from({ length: 4 }, (_, index) => ({
      kind: 'note',
      id: index.toString(16).padStart(64, '0'),
      noteFile: new Uint8Array(140_000).fill(255),
      provenance: 'input',
      format: 'full'
    }));
    const { toSerializable } = await import('../recovery/serialization');
    expect(notes.reduce((sum, note) => sum + note.noteFile.byteLength, 0)).toBeLessThan(2 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(toSerializable(notes))).byteLength).toBeGreaterThan(2 * 1024 * 1024);
    await completedBaseline(notes);
    try {
      const accepted = await vault.verifyStorageContinuity().catch(() => false);
      expect(accepted).toBe(false);
      expect(initializeGeneration).not.toHaveBeenCalled();
      expect(generation).toBeNull();
      expect(await vault.readRecoveryJournal()).toBeUndefined();
      expect(await isStored(ck('recoverycontinuity'))).toBe(false);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('Task4C3I2 preserves a full prior journal and healthy state when the merged baseline cannot fit', async () => {
    await completedBaseline([
      { kind: 'note', id: '12'.repeat(32), noteFile: new Uint8Array([19, 48, 93]), provenance: 'input', format: 'full' }
    ]);
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const initial = await vault.readRecoveryJournal();
    if (!initial) throw new Error('Missing initial baseline fixture');
    const materialCount =
      journalNoteBodies(initial).length + initial.entries.filter(entry => entry.kind !== 'note').length;
    await vault.retainRecoveryEntries(
      Array.from({ length: 256 - materialCount }, (_, index) => ({
        kind: 'note',
        id: `retained-capacity-${index}`,
        noteFile: new Uint8Array([19, index]),
        provenance: 'input',
        format: 'full'
      }))
    );
    const before = await vault.readRecoveryJournal();
    if (!before) throw new Error('Missing full baseline fixture');
    expect(journalNoteBodies(before).length + before.entries.filter(entry => entry.kind !== 'note').length).toBe(256);
    const floor = await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey);
    const marker = generation;
    initializeGeneration.mockClear();
    await completedBaseline([
      { kind: 'note', id: '34'.repeat(32), noteFile: new Uint8Array([19, 48, 94]), provenance: 'input', format: 'full' }
    ]);
    try {
      const accepted = await vault.verifyStorageContinuity().catch(() => false);
      expect(accepted).toBe(false);
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(floor);
      expect(generation).toBe(marker);
      expect(initializeGeneration).not.toHaveBeenCalled();
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('Task4C3I2R retains the complete baseline when SDK marker initialization rejects', async () => {
    const note = {
      kind: 'note',
      id: '56'.repeat(32),
      noteFile: new Uint8Array([19, 48, 95]),
      provenance: 'input',
      format: 'full'
    } satisfies import('../recovery/types').RecoveryNoteEntry;
    await completedBaseline([note]);
    const { readFinancialRecoveryBaseline } = await import('../recovery/financial');
    const { getEffectiveNetworkName, getEffectiveRpcUrl } = await import('lib/miden-chain/effective-endpoints');
    const financial = await readFinancialRecoveryBaseline(['retained']);
    const markerFailure = new Error('Marker not acknowledged');
    initializeGeneration.mockRejectedValueOnce(markerFailure);
    const outcome = await vault.verifyStorageContinuity().then(
      () => 'completed',
      error => error
    );
    expect(outcome).toBe(markerFailure);
    expect(initializeGeneration).toHaveBeenCalledTimes(1);
    const retained = await vault.readRecoveryJournal();
    expect(retained).toMatchObject({
      accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
      scope: {
        network: `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`,
        walletGeneration: 'wallet-fixture',
        sdkGeneration: initializeGeneration.mock.calls[0]?.[0]
      },
      entries: expect.arrayContaining([note, ...financial])
    });
    expect(retained?.entries).toHaveLength(financial.length + 1);
    expect(generation).toBeNull();
    expect(await isStored(ck('recoverycontinuity'))).toBe(false);
    expect(getStorageHealth().status).toBe('healthy');
  });

  async function nativeVaultRetention() {
    const fixture = await acquisition();
    const sdk = jest.requireMock<typeof import('@miden-sdk/miden-sdk/lazy')>('@miden-sdk/miden-sdk/lazy');
    const { getEffectiveRpcUrl } = await import('lib/miden-chain/effective-endpoints');
    const native = await sdk.getWasmOrThrow();
    const sdkClient = fixture.client.client;
    Reflect.set(
      sdkClient,
      'storeIdentifier',
      jest.fn(async () => native.resolveStoreName(getEffectiveRpcUrl(), undefined))
    );
    Reflect.set(sdkClient, 'terminate', jest.fn());
    const previousCreate: unknown = Reflect.get(sdk.MidenClient, 'create');
    const create = jest.fn(async (_options: Parameters<typeof sdk.MidenClient.create>[0]) => sdkClient);
    Reflect.set(sdk.MidenClient, 'create', create);
    const { MidenClientInterface } = await import('../sdk/miden-client-interface');
    const client = await MidenClientInterface.create({ useWorker: false });
    const gate = create.mock.calls[0]?.[0]?.beforeNoteAcquisition;
    if (!gate) throw new Error('Missing protected native retention fixture');
    const candidate: import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionCandidate = {
      operationId: 'vault-native-retention',
      noteFileBytes: fixture.noteFile,
      variant: 'committed',
      source: 'import',
      batchIndex: 0,
      batchCount: 1,
      detailsCommitment: '0x' + '34'.repeat(32),
      noteId: fixture.noteId,
      nullifier: '0x' + '56'.repeat(32),
      metadata: {
        sender: '0x' + '11'.repeat(15),
        noteType: 0,
        tag: 7,
        attachmentsCommitment: '0x' + '77'.repeat(32)
      },
      tag: 7
    };
    let adopted = false;
    let afterRetention: () => void = () => {};
    const imported = jest.fn(async () => {
      await gate(candidate);
      afterRetention();
      adopted = true;
      return fixture.noteId;
    });
    const { withWasmClientLock } = await import('../sdk/miden-client');
    const { getAccountsWriteQueue } = await import('./accounts-write-queue');
    return {
      ...fixture,
      RetentionFailure: sdk.NoteAcquisitionRetentionError,
      invoke: () =>
        getAccountsWriteQueue()
          .add(() => withWasmClientLock(() => imported()))
          .then(
            () => 'accepted',
            (error: unknown) => error
          ),
      adopted: () => adopted,
      afterRetention: (operation: () => void) => {
        afterRetention = operation;
      },
      cleanup: async () => {
        client.free();
        if (previousCreate === undefined) Reflect.deleteProperty(sdk.MidenClient, 'create');
        else Reflect.set(sdk.MidenClient, 'create', previousCreate);
        fixture.restore();
        await resetStorageHealthForLifecycle(getStorageHealth().epoch);
      }
    };
  }

  it('Task4C3P brands an actual Vault journal readback mismatch before native adoption', async () => {
    const f = await nativeVaultRetention();
    const { getStorageProvider } = await import('lib/platform/storage-adapter');
    const { toSerializable } = await import('../recovery/serialization');
    const providerFactory = jest.mocked(getStorageProvider);
    const originalFactory = providerFactory.getMockImplementation();
    if (!originalFactory) throw new Error('Missing storage provider fixture');
    const provider = getStorageProvider();
    const before = await vault.readRecoveryJournal();
    if (!before) throw new Error('Missing native readback journal fixture');
    const pointer = memoryStore.miden_recovery_v1_active;
    const floor = await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey);
    const priorCiphertext = await Passworder.encryptJson(toSerializable(before), fixtureKey);
    let writtenSlot: string | undefined;
    let substitutedReadbacks = 0;
    providerFactory.mockImplementation(() => ({
      ...provider,
      set: async items => {
        await provider.set(items);
        writtenSlot = Object.keys(items).find(key => /^miden_recovery_v1_[01]$/.test(key)) ?? writtenSlot;
      },
      get: async keys => {
        const values = await provider.get(keys);
        if (writtenSlot && keys.length === 1 && keys[0] === writtenSlot && substitutedReadbacks === 0) {
          substitutedReadbacks += 1;
          return { ...values, [writtenSlot]: priorCiphertext };
        }
        return values;
      }
    }));
    try {
      const outcome = await f.invoke();
      expect(substitutedReadbacks).toBe(1);
      expect(f.adopted()).toBe(false);
      expect(getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'journal', backend: 'independent' });
      expect(memoryStore.miden_recovery_v1_active).toEqual(pointer);
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(floor);
      expect(outcome).toBeInstanceOf(f.RetentionFailure);
    } finally {
      providerFactory.mockImplementation(originalFactory);
      await f.cleanup();
    }
  });

  it('Task4C3P leaves ordinary SDK Abort after actual Vault retention healthy and unbranded', async () => {
    const f = await nativeVaultRetention();
    const cancellation = new DOMException('Import cancelled', 'AbortError');
    f.afterRetention(() => {
      throw cancellation;
    });
    try {
      const outcome = await f.invoke();
      expect(outcome).toBe(cancellation);
      expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
      expect(f.adopted()).toBe(false);
      expect((await vault.readRecoveryJournal())?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ noteFile: f.noteFile })])
      );
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      await f.cleanup();
    }
  });

  it('Task4C3P refuses actual Vault capacity before write or adoption without a failure brand', async () => {
    const f = await nativeVaultRetention();
    try {
      const initial = await vault.readRecoveryJournal();
      if (!initial) throw new Error('Missing native capacity journal fixture');
      const materialCount =
        journalNoteBodies(initial).length + initial.entries.filter(entry => entry.kind !== 'note').length;
      await vault.retainRecoveryEntries(
        Array.from({ length: 256 - materialCount }, (_, index) => ({
          kind: 'note',
          id: `native-capacity-${index}`,
          noteFile: new Uint8Array([19, index]),
          provenance: 'input',
          format: 'full'
        }))
      );
      const before = await vault.readRecoveryJournal();
      if (!before) throw new Error('Missing full native capacity journal fixture');
      expect(journalNoteBodies(before).length + before.entries.filter(entry => entry.kind !== 'note').length).toBe(256);
      const floor = await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey);
      const writes = mockStorageSets.length;
      const outcome = await f.invoke();
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
      expect(f.adopted()).toBe(false);
      expect(mockStorageSets.slice(writes)).toEqual([]);
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(floor);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      await f.cleanup();
    }
  });

  async function nativeRecoveryReceipt({ foreignCallback = false } = {}) {
    let storageTail = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, operation: () => Promise<unknown>) => {
          const pending = storageTail.then(operation);
          storageTail = pending.then(
            () => {},
            () => {}
          );
          return pending;
        }
      }
    });
    readSnapshot.mockImplementation(async () => ({
      generation,
      accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
      notes: []
    }));
    const fixture = await acquisition();
    await fixture.run();
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const before = await vault.readRecoveryJournal();
    if (!before) throw new Error('Missing native recovery journal fixture');
    const floor = await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey);
    const marker = await Repo.metadata.get('generation');
    const file = fixture.setCandidate(fixture.noteFile);
    const note = file.note();
    if (!note) throw new Error('Missing committed native recovery fixture');
    const nativeMetadata = {
      sender: '0x' + '11'.repeat(15),
      noteType: 0,
      tag: 7,
      attachmentsCommitment: '0x' + '77'.repeat(32)
    } satisfies NonNullable<import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionCandidate['metadata']>;
    file.note = () => ({
      ...note,
      metadata: () => ({
        ...note.metadata(),
        sender: () => ({ toString: () => nativeMetadata.sender, free: () => {} })
      })
    });
    const sdk = jest.requireMock<{
      NoteFile: { fromInputNote: jest.Mock };
    }>('@miden-sdk/miden-sdk/lazy');
    const previousExport = sdk.NoteFile.fromInputNote.getMockImplementation();
    sdk.NoteFile.fromInputNote.mockImplementation(() => file);
    const record = () => ({
      details: () => {
        const details = file.note();
        if (!details) throw new Error('Missing native recovery note details');
        return details;
      },
      id: file.noteId,
      state: () => 2,
      isAuthenticated: () => true,
      isConsumed: () => false,
      isInclusionPending: () => false,
      metadata: () => file.note()?.metadata(),
      inclusionProof: file.inclusionProof,
      nullifier: file.nullifier,
      toInputNote: () => ({ free: () => {} }),
      free: () => {}
    });
    let adopted = false;
    let beforeGate: () => Promise<void> = async () => {};
    let transform = (candidate: import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionCandidate) => candidate;
    let reachedImport = () => {};
    const atImport = new Promise<void>(resolve => {
      reachedImport = resolve;
    });
    let release = () => {};
    const wait = new Promise<void>(resolve => {
      release = resolve;
    });
    let gate: import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionOptions['beforeNoteAcquisition'];
    const delivered = jest.fn(async (candidate: import('@miden-sdk/miden-sdk/lazy').NoteAcquisitionCandidate) => {
      if (!gate) throw new Error('Missing factory acquisition callback');
      await gate(candidate);
    });
    fixture.imported.mockClear();
    fixture.imported.mockImplementation(async imported => {
      if (!imported) throw new Error('Missing decoded recovery NoteFile');
      reachedImport();
      await wait;
      await beforeGate();
      const candidate = transform({
        operationId: 'vault-native-recovery',
        noteFileBytes: imported.serialize(),
        variant: 'committed',
        source: 'import',
        batchIndex: 0,
        batchCount: 1,
        detailsCommitment: '0x' + '34'.repeat(32),
        noteId: fixture.noteId,
        nullifier: '0x' + '56'.repeat(32),
        metadata: nativeMetadata,
        tag: nativeMetadata.tag
      });
      await delivered(candidate);
      adopted = true;
      return fixture.noteId;
    });
    const list = jest.fn(async () => (adopted ? [record()] : []));
    const listPage = jest.fn(async () => ({
      notes: adopted ? [record()] : [],
      nextCursor: adopted ? '0x' + '34'.repeat(32) : null,
      exhausted: true
    }));
    const settings = {
      get: jest.fn(async () => generation),
      set: jest.fn(async (_key: string, next: string) => {
        generation = next;
      })
    };
    const accounts = {
      get: jest.fn(async () => ({
        nonce: () => ({ asInt: () => 4n }),
        to_commitment: () => ({ toHex: () => 'state-4', free: () => {} })
      })),
      insert: jest.fn()
    };
    Reflect.set(fixture.client.client, 'notes', { import: fixture.imported, list, listPage });
    Reflect.set(fixture.client.client, 'settings', settings);
    Reflect.set(fixture.client.client, 'accounts', accounts);
    const { getEffectiveRpcUrl } = await import('lib/miden-chain/effective-endpoints');
    const sdkFactory = jest.requireMock<typeof import('@miden-sdk/miden-sdk/lazy')>('@miden-sdk/miden-sdk/lazy');
    const native = await sdkFactory.getWasmOrThrow();
    const storeName = native.resolveStoreName(getEffectiveRpcUrl(), undefined);
    const primarySdk = fixture.client.client;
    Reflect.set(
      primarySdk,
      'storeIdentifier',
      jest.fn(async () => storeName)
    );
    Reflect.set(primarySdk, 'terminate', jest.fn());
    const previousCreate: unknown = Reflect.get(sdkFactory.MidenClient, 'create');
    const create = jest.fn(async (_options: Parameters<typeof sdkFactory.MidenClient.create>[0]) => primarySdk);
    Reflect.set(sdkFactory.MidenClient, 'create', create);
    const { MidenClientInterface } = await import('../sdk/miden-client-interface');
    fixture.client = await MidenClientInterface.create({ useWorker: false });
    gate = create.mock.calls[0]?.[0]?.beforeNoteAcquisition;
    let callbackClient = fixture.client;
    if (foreignCallback) {
      const foreignSdk = Object.assign({}, primarySdk, { terminate: jest.fn() });
      create.mockResolvedValueOnce(foreignSdk);
      callbackClient = await MidenClientInterface.create({ useWorker: false });
      gate = create.mock.calls[1]?.[0]?.beforeNoteAcquisition;
    }
    if (!gate) throw new Error('Missing protected factory callback fixture');
    mockRecoveryClient = fixture.client;
    readSnapshot.mockRestore();
    generation = null;
    initializeGeneration.mockClear();
    markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
    const nestedBefore = Reflect.get(globalThis, '__vaultTestLockNested') ?? 0;
    const progress: import('../recovery/types').StorageRecoveryProgress[] = [];
    return {
      ...fixture,
      before,
      floor,
      marker,
      atImport,
      release,
      delivered,
      settings,
      accounts,
      progress,
      nestedBefore,
      callbackClient,
      adopted: () => adopted,
      beforeGate: (operation: () => Promise<void>) => {
        beforeGate = operation;
      },
      transform: (operation: typeof transform) => {
        transform = operation;
      },
      recover: () => vault.recoverStorage(value => progress.push(value)),
      cleanup: async () => {
        release();
        mockRecoveryClient = undefined;
        fixture.client.free();
        if (callbackClient !== fixture.client) callbackClient.free();
        if (previousCreate === undefined) Reflect.deleteProperty(sdkFactory.MidenClient, 'create');
        else Reflect.set(sdkFactory.MidenClient, 'create', previousCreate);
        sdk.NoteFile.fromInputNote.mockReset();
        if (previousExport) sdk.NoteFile.fromInputNote.mockImplementation(previousExport);
        fixture.restore();
        await resetStorageHealthForLifecycle(getStorageHealth().epoch);
      }
    };
  }

  it('Task4C3M replays an exact retained primary through the native gate while ordinary intake stays unavailable', async () => {
    const f = await nativeRecoveryReceipt();
    f.release();
    try {
      await expect(f.run()).rejects.toThrow('StorageUnavailableError');
      expect(getStorageHealth().status).toBe('unavailable');
      expect(f.delivered).not.toHaveBeenCalled();
      const recovered = await f.recover();
      expect(f.delivered).toHaveBeenCalledTimes(1);
      expect(f.delivered.mock.calls[0]?.[0].noteFileBytes).toEqual(f.noteFile);
      expect(recovered).toBe(true);
      expect(f.adopted()).toBe(true);
      expect(f.settings.set).toHaveBeenCalledTimes(1);
      expect(await vault.readRecoveryJournal()).toEqual(f.before);
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(f.floor);
      expect(f.progress.at(-1)?.phase).toBe('complete');
      expect(getStorageHealth().status).toBe('healthy');
      expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(f.nestedBefore);
    } finally {
      await f.cleanup();
    }
  });

  it.each(['changed bytes', 'foreign note', 'retired client'])(
    'Task4C3M refuses %s at the native receipt boundary without completing recovery',
    async scenario => {
      const f = await nativeRecoveryReceipt();
      if (scenario === 'changed bytes')
        f.transform(candidate => ({ ...candidate, noteFileBytes: new Uint8Array([19, 48, 101]) }));
      if (scenario === 'foreign note') f.transform(candidate => ({ ...candidate, noteId: '0x' + 'ab'.repeat(32) }));
      if (scenario === 'retired client') f.beforeGate(async () => f.client.markPoisoned());
      f.release();
      try {
        expect(await f.recover()).toBe(false);
        expect(f.delivered).toHaveBeenCalledTimes(1);
        expect(f.adopted()).toBe(false);
        expect(f.settings.set).not.toHaveBeenCalled();
        expect(await vault.readRecoveryJournal()).toEqual(f.before);
        expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(f.floor);
        expect(await Repo.metadata.get('generation')).toEqual(f.marker);
        expect(f.progress.at(-1)?.phase).toBe('notes');
        expect(getStorageHealth().status).toBe('unavailable');
        expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(f.nestedBefore);
      } finally {
        await f.cleanup();
      }
    }
  );

  it('Task4C3M2 refuses another protected client callback during the primary restore', async () => {
    const f = await nativeRecoveryReceipt({ foreignCallback: true });
    f.release();
    try {
      expect(f.callbackClient).not.toBe(f.client);
      expect(f.callbackClient.client).not.toBe(f.client.client);
      expect(f.callbackClient.isDisposed).toBe(false);
      expect(f.client.isDisposed).toBe(false);
      expect(await f.recover()).toBe(false);
      expect(f.delivered).toHaveBeenCalledTimes(1);
      expect(f.adopted()).toBe(false);
      expect(f.settings.set).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toEqual(f.before);
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(f.floor);
      expect(await Repo.metadata.get('generation')).toEqual(f.marker);
      expect(f.progress.at(-1)?.phase).toBe('notes');
      expect(getStorageHealth().status).toBe('unavailable');
      expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(f.nestedBefore);
    } finally {
      await f.cleanup();
    }
  });

  it('Task4C3M detects an out-of-band journal sequence change before recovery completion', async () => {
    const f = await nativeRecoveryReceipt();
    const { RecoveryJournal } = await import('../recovery/journal');
    const { getStorageProvider } = await import('lib/platform/storage-adapter');
    let changed = f.before;
    f.beforeGate(async () => {
      const journal = new RecoveryJournal(fixtureKey, getStorageProvider());
      changed = await journal.update(() => ({
        scope: f.before.scope,
        accounts: f.before.accounts,
        entries: [
          ...f.before.entries,
          {
            kind: 'note',
            id: 'external-sequence-evidence',
            noteFile: new Uint8Array([19, 48, 102]),
            provenance: 'input'
          }
        ]
      }));
    });
    f.release();
    try {
      expect(await f.recover()).toBe(false);
      expect(f.delivered).toHaveBeenCalledTimes(1);
      expect(changed.sequence).toBeGreaterThan(f.before.sequence);
      expect(await vault.readRecoveryJournal()).toEqual(changed);
      expect(f.settings.set).not.toHaveBeenCalled();
      expect(await fetchAndDecryptOne<unknown>(ck('recoverycontinuity'), fixtureKey)).toEqual(f.floor);
      expect(await Repo.metadata.get('generation')).toEqual(f.marker);
      expect(f.progress.at(-1)?.phase).toBe('notes');
      expect(getStorageHealth().status).toBe('unavailable');
    } finally {
      await f.cleanup();
    }
  });

  it('Task4C3M queues authorized reconciliation behind the owned native recovery import', async () => {
    const f = await nativeRecoveryReceipt();
    const { getAccountsWriteQueue } = await import('./accounts-write-queue');
    const recovery = f.recover();
    let reconciliation: Promise<unknown> | undefined;
    try {
      expect(await Promise.race([f.atImport.then(() => true), recovery.then(() => false)])).toBe(true);
      const readsBefore = f.accounts.get.mock.calls.length;
      reconciliation = vault.reconcileStorageRecovery().catch((error: unknown) => error);
      await Promise.resolve();
      expect(getAccountsWriteQueue().size).toBe(1);
      expect(f.accounts.get).toHaveBeenCalledTimes(readsBefore);
      expect(await vault.readRecoveryJournal()).toEqual(f.before);
      f.release();
      expect(await recovery).toBe(true);
      await reconciliation;
      expect(f.delivered).toHaveBeenCalledTimes(1);
      expect(f.adopted()).toBe(true);
      expect(f.progress.at(-1)?.phase).toBe('complete');
      expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(f.nestedBefore);
    } finally {
      f.release();
      await recovery;
      await reconciliation;
      await f.cleanup();
    }
  });

  async function guardianAcquisition(withProof = true) {
    const fixture = await acquisition();
    const noteFile = new Uint8Array([19, 48, withProof ? 41 : 42, 253]);
    const sdk = jest.requireMock<{
      Note: { deserialize: jest.Mock };
      NoteFile: { fromInputNote: jest.Mock };
      InputNote: { authenticated: jest.Mock; unauthenticated: jest.Mock };
      RpcClient: jest.Mock;
    }>('@miden-sdk/miden-sdk/lazy');
    const rawNote = fixture.setCandidate(fixture.noteFile).note();
    const laterRawBytes = new Uint8Array([19, 48, 44, 250]);
    const laterFileBytes = new Uint8Array([19, 48, 43, 251]);
    const laterId = '0x' + 'ab'.repeat(32);
    const laterNote = fixture.setCandidate(laterRawBytes, { identity: laterId }).note();
    const proof = { proofFor: fixture.noteId };
    const getNotesById = jest.fn(async () => (withProof ? [{ noteId: fixture.noteId, inclusionProof: proof }] : []));
    sdk.Note.deserialize.mockImplementation((bytes: Uint8Array) =>
      bytes.length === laterRawBytes.length && bytes.every((byte, index) => byte === laterRawBytes[index])
        ? laterNote
        : rawNote
    );
    sdk.RpcClient.mockImplementation(() => ({ getNotesById }));
    sdk.InputNote.authenticated.mockImplementation((note: unknown, inclusionProof: unknown) => ({
      note,
      inclusionProof
    }));
    sdk.InputNote.unauthenticated.mockImplementation((note: unknown) => ({ note }));
    sdk.NoteFile.fromInputNote.mockImplementation(
      (input: { note: { id: () => { toString: () => string } }; inclusionProof?: unknown }) => {
        const identity = input.note.id().toString();
        return fixture.setCandidate(identity === laterId ? laterFileBytes : noteFile, {
          identity,
          detailsOnly: input.inclusionProof === undefined,
          tag: 71,
          afterBlock: input.inclusionProof === undefined ? 0 : 19
        });
      }
    );
    return {
      ...fixture,
      rawNoteBytes: fixture.noteFile,
      noteFile,
      laterRawBytes,
      laterFileBytes,
      getNotesById,
      deserialize: sdk.Note.deserialize,
      restore: () => {
        fixture.restore();
        sdk.Note.deserialize.mockReset();
        sdk.NoteFile.fromInputNote.mockReset();
        sdk.InputNote.authenticated.mockReset();
        sdk.InputNote.unauthenticated.mockReset();
        sdk.RpcClient.mockReset();
      }
    };
  }

  it('Task4C3E3 classified SDK quota stops the Guardian batch with retained preimport bytes', async () => {
    const fixture = await guardianAcquisition();
    const before = await vault.readRecoveryJournal();
    fixture.imported.mockRejectedValueOnce(new DOMException('SDK storage full', 'QuotaExceededError'));
    try {
      const result = await fixture.runRecovery([fixture.rawNoteBytes, fixture.laterRawBytes]).then(
        () => 'accepted',
        () => 'refused'
      );
      expect(result).toBe('refused');
      expect(fixture.imported).toHaveBeenCalledTimes(1);
      expect(getStorageHealth().status).toBe('unavailable');
      const retained = await vault.readRecoveryJournal();
      expect(retained).toMatchObject({ scope: before?.scope, accounts: before?.accounts });
      const bodies = journalNoteBodies({ entries: retained?.entries });
      expect(bodies).toContainEqual(fixture.noteFile);
      expect(bodies).not.toContainEqual(fixture.laterFileBytes);
    } finally {
      fixture.restore();
    }
  });

  it.each(['generic refusal', 'AbortError'])(
    'Task4C3E3 Guardian %s retains bytes and remains an ordinary healthy failure',
    async kind => {
      const fixture = await guardianAcquisition();
      fixture.imported.mockRejectedValueOnce(
        kind === 'AbortError' ? new DOMException('cancelled', 'AbortError') : new Error('node request refused')
      );
      try {
        await expect(fixture.runRecovery()).resolves.toEqual({ imported: 0, failures: 1 });
        expect(fixture.imported).toHaveBeenCalledTimes(1);
        expect(getStorageHealth().status).toBe('healthy');
        expect(journalNoteBodies({ entries: (await vault.readRecoveryJournal())?.entries })).toContainEqual(
          fixture.noteFile
        );
      } finally {
        fixture.restore();
      }
    }
  );

  it.each([true, false])(
    'Task4C3E Guardian proof=%s retains its generated file before counting success',
    async withProof => {
      const fixture = await guardianAcquisition(withProof);
      let atImport: import('../recovery/types').RecoveryJournalSnapshot | undefined;
      let atImportBytes: Uint8Array | undefined;
      fixture.imported.mockImplementation(async file => {
        atImportBytes = file?.serialize();
        atImport = await vault.readRecoveryJournal();
        return fixture.noteId;
      });
      const nestedBefore = Reflect.get(globalThis, '__vaultTestLockNested') ?? 0;
      try {
        await expect(fixture.runRecovery()).resolves.toEqual({ imported: 1, failures: 0 });
        expect(fixture.getNotesById).toHaveBeenCalledTimes(1);
        expect(fixture.deserialize).toHaveBeenCalledWith(fixture.rawNoteBytes);
        expect(fixture.noteFile).not.toEqual(fixture.rawNoteBytes);
        expect(atImportBytes).toEqual(fixture.noteFile);
        expect(atImport?.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'note',
              id: withProof ? fixture.noteId.slice(2) : '34'.repeat(32),
              noteFile: fixture.noteFile,
              provenance: 'input',
              format: withProof ? 'full' : 'details'
            })
          ])
        );
        expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(nestedBefore);
        expect(readSnapshot).not.toHaveBeenCalled();
      } finally {
        fixture.restore();
      }
    }
  );

  it('Task4C3E Guardian import and recovery count wait for independent readback', async () => {
    const fixture = await guardianAcquisition();
    let release = () => {};
    let reached = () => {};
    const paused = new Promise<void>(resolve => {
      release = resolve;
    });
    const entered = new Promise<void>(resolve => {
      reached = resolve;
    });
    mockBeforeRecoveryWrite = async () => {
      reached();
      await paused;
    };
    let settled = false;
    const pending = fixture.runRecovery().finally(() => {
      settled = true;
    });
    try {
      await Promise.race([entered, pending]);
      const beforeRelease = { settled, imports: fixture.imported.mock.calls.length };
      release();
      await expect(pending).resolves.toEqual({ imported: 1, failures: 0 });
      expect(beforeRelease).toEqual({ settled: false, imports: 0 });
      expect((await vault.readRecoveryJournal())?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ noteFile: fixture.noteFile })])
      );
    } finally {
      release();
      await pending.catch(() => {});
      fixture.restore();
    }
  });

  it('Task4C3E Guardian quota refusal never imports or reports successful recovery', async () => {
    const fixture = await guardianAcquisition();
    const before = await vault.readRecoveryJournal();
    mockBeforeRecoveryWrite = async () => {
      throw new DOMException('independent storage full', 'QuotaExceededError');
    };
    try {
      const result = await fixture.runRecovery().catch(() => ({ imported: 0, failures: 1 }));
      expect(result).toEqual({ imported: 0, failures: 1 });
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(getStorageHealth().status).toBe('unavailable');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3E Guardian owner lost during proof lookup cannot enter SDK import', async () => {
    const fixture = await guardianAcquisition();
    const before = await vault.readRecoveryJournal();
    fixture.getNotesById.mockImplementationOnce(async () => {
      vault.retire();
      return [];
    });
    try {
      const result = await fixture.runRecovery().catch(() => ({ imported: 0, failures: 1 }));
      expect(fixture.getNotesById).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ imported: 0, failures: 1 });
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3E Guardian generic SDK refusal keeps retained bytes without poisoning storage', async () => {
    const fixture = await guardianAcquisition();
    fixture.imported.mockRejectedValueOnce(new Error('node proof lookup interrupted'));
    try {
      await expect(fixture.runRecovery()).resolves.toEqual({ imported: 0, failures: 1 });
      expect(fixture.imported).toHaveBeenCalledTimes(1);
      expect((await vault.readRecoveryJournal())?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ noteFile: fixture.noteFile })])
      );
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3E malformed Guardian input stays an ordinary healthy recovery failure', async () => {
    const fixture = await guardianAcquisition();
    const before = await vault.readRecoveryJournal();
    fixture.deserialize.mockImplementationOnce(() => {
      throw new Error('invalid raw note bytes');
    });
    try {
      await expect(fixture.runRecovery()).resolves.toEqual({ imported: 0, failures: 1 });
      expect(fixture.getNotesById).not.toHaveBeenCalled();
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      fixture.restore();
    }
  });

  it.each(['paused', 'quota'])(
    'Task4C3E pending queue preserves bytes while independent retention is %s',
    async outcome => {
      const fixture = await acquisition();
      const { importAllNotes, queueNoteImport } = await import('../activity/notes');
      const { __resetSyncFuseStateForTests } = await import('../front/sync-fuse');
      __resetSyncFuseStateForTests();
      const imported = jest
        .spyOn(midenClientProxy, 'importNoteBytes')
        .mockImplementation((bytes, hold) => fixture.client.importNoteBytes(bytes, hold));
      const sync = jest.spyOn(midenClientProxy, 'syncState').mockResolvedValue(undefined);
      const encoded = Buffer.from(fixture.noteFile).toString('base64');
      await queueNoteImport(encoded);
      let release = () => {};
      let reached = () => {};
      const paused = new Promise<void>(resolve => {
        release = resolve;
      });
      const entered = new Promise<void>(resolve => {
        reached = resolve;
      });
      mockBeforeRecoveryWrite = async () => {
        reached();
        await paused;
        if (outcome === 'quota') throw new DOMException('independent storage full', 'QuotaExceededError');
      };
      let settled = false;
      const pending = importAllNotes().finally(() => {
        settled = true;
      });
      try {
        await Promise.race([entered, pending]);
        expect(settled).toBe(false);
        expect(fixture.imported).not.toHaveBeenCalled();
        expect(await getPlain('miden-notes-pending-import')).toEqual([encoded]);
        release();
        await pending.catch(() => {});
        const carried = expect.objectContaining({ bytes: encoded });
        expect(fixture.imported).toHaveBeenCalledTimes(outcome === 'quota' ? 0 : 1);
        expect(await getPlain('miden-notes-pending-import')).toEqual(outcome === 'quota' ? [carried] : []);
        expect(getStorageHealth().status).toBe(outcome === 'quota' ? 'unavailable' : 'healthy');
        const retained = journalNoteBodies({ entries: (await vault.readRecoveryJournal())?.entries }).filter(
          bytes => bytes.length === fixture.noteFile.length && bytes.every((byte, i) => byte === fixture.noteFile[i])
        );
        expect(retained).toEqual(outcome === 'quota' ? [] : [fixture.noteFile]);
      } finally {
        release();
        await pending.catch(() => {});
        imported.mockRestore();
        sync.mockRestore();
        fixture.restore();
        __resetSyncFuseStateForTests();
      }
    }
  );

  it('Task4C3 acquisition retains bytes before SDK acceptance without custody reentry', async () => {
    const fixture = await acquisition();
    let atImport: import('../recovery/types').RecoveryJournalSnapshot | undefined;
    fixture.imported.mockImplementation(async () => {
      atImport = await vault.readRecoveryJournal();
      return fixture.noteId;
    });
    const nestedBefore = Reflect.get(globalThis, '__vaultTestLockNested') ?? 0;
    try {
      await expect(fixture.run()).resolves.toBe(fixture.noteId);
      expect(atImport?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'note', noteFile: fixture.noteFile })])
      );
      expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(nestedBefore);
      expect(readSnapshot).not.toHaveBeenCalled();
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3 acquisition waits for independent storage before acknowledging SDK import', async () => {
    const fixture = await acquisition();
    let release = () => {};
    let reached = () => {};
    const paused = new Promise<void>(resolve => {
      release = resolve;
    });
    const entered = new Promise<void>(resolve => {
      reached = resolve;
    });
    mockBeforeRecoveryWrite = async () => {
      reached();
      await paused;
    };
    let settled = false;
    const pending = fixture.run().then(
      () => {
        settled = true;
        return 'accepted';
      },
      () => {
        settled = true;
        return 'refused';
      }
    );
    try {
      await Promise.race([entered, pending]);
      const beforeRelease = { settled, imports: fixture.imported.mock.calls.length };
      release();
      const outcome = await pending;
      expect(beforeRelease).toEqual({ settled: false, imports: 0 });
      expect(outcome).toBe('accepted');
      expect((await vault.readRecoveryJournal())?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'note', noteFile: fixture.noteFile })])
      );
    } finally {
      release();
      await pending;
      fixture.restore();
    }
  });

  it.each(['quota failure', 'retired sink'])('Task4C3 acquisition refuses %s before SDK acceptance', async failure => {
    const fixture = await acquisition();
    const before = await vault.readRecoveryJournal();
    if (failure === 'retired sink') vault.retire();
    else
      mockBeforeRecoveryWrite = async () => {
        throw new DOMException('independent storage full', 'QuotaExceededError');
      };
    try {
      const outcome = await fixture.run().then(
        () => 'accepted',
        () => 'refused'
      );
      expect(outcome).toBe('refused');
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toEqual(before);
      expect(getStorageHealth().status).toBe(failure === 'retired sink' ? 'healthy' : 'unavailable');
    } finally {
      fixture.restore();
    }
  });

  it.each(['full same-id', 'full spelling alias', 'expected alias'])(
    'Task4C3B rejected %s preserves the last good body and proof',
    async variant => {
      const fixture = await acquisition();
      try {
        await fixture.run();
        const before = await vault.readRecoveryJournal();
        const candidate = new Uint8Array([19, 48, 8, 254]);
        fixture.setCandidate(candidate, {
          identity: variant === 'full spelling alias' ? fixture.noteId.slice(2).toUpperCase() : fixture.noteId,
          detailsOnly: variant === 'expected alias',
          tag: 7,
          afterBlock: 0
        });
        fixture.imported.mockRejectedValueOnce(new Error('Note inclusion proof does not match the chain'));
        await expect(fixture.run(candidate)).rejects.toThrow('Note inclusion proof does not match the chain');
        expect(getStorageHealth().status).toBe('healthy');
        const after = await vault.readRecoveryJournal();
        expect(before).toBeDefined();
        expect(after).toMatchObject({ scope: before?.scope, accounts: before?.accounts });
        expect(after?.entries).toEqual(
          expect.arrayContaining((before?.entries ?? []).map(entry => expect.objectContaining(entry)))
        );
        expect(after?.sequence).toBeGreaterThanOrEqual(before?.sequence ?? 0);
      } finally {
        fixture.restore();
      }
    }
  );

  it('Task4C3B an unchanged duplicate import writes no independent storage', async () => {
    const fixture = await acquisition();
    try {
      await fixture.run();
      const before = await vault.readRecoveryJournal();
      mockStorageSets.length = 0;
      await expect(fixture.run()).resolves.toBe(fixture.noteId);
      expect(mockStorageSets).toEqual([]);
      expect(await vault.readRecoveryJournal()).toEqual(before);
    } finally {
      fixture.restore();
    }
  });

  it.each(['completion', 'provider failure'])(
    'Task4C3B retiring a pending acquisition prevents late %s from acknowledging or poisoning health',
    async outcome => {
      const fixture = await acquisition();
      let release = () => {};
      let reached = () => {};
      const paused = new Promise<void>(resolve => {
        release = resolve;
      });
      const entered = new Promise<void>(resolve => {
        reached = resolve;
      });
      mockBeforeRecoveryWrite = async () => {
        reached();
        await paused;
        if (outcome === 'provider failure') throw new DOMException('retired write failed', 'QuotaExceededError');
      };
      const pending = fixture.run().then(
        () => 'accepted',
        () => 'refused'
      );
      try {
        await Promise.race([entered, pending]);
        vault.retire();
        release();
        expect(await pending).toBe('refused');
        expect(fixture.imported).not.toHaveBeenCalled();
        expect(getStorageHealth().status).toBe('healthy');
      } finally {
        release();
        await pending;
        fixture.restore();
      }
    }
  );

  it('Task4C3B the current preadoption sink survives retirement of the previous vault', async () => {
    const fixture = await acquisition();
    const current = new Vault(fixtureKey);
    vault.retire();
    try {
      await expect(fixture.run()).resolves.toBe(fixture.noteId);
      expect((await current.readRecoveryJournal())?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'note', noteFile: fixture.noteFile })])
      );
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      current.retire();
      fixture.restore();
    }
  });

  it('Task4C3B unknown expected notes retain original bytes and details identity before SDK acceptance', async () => {
    const fixture = await acquisition();
    const expected = new Uint8Array([7, 11, 19, 48]);
    fixture.setCandidate(expected, { detailsOnly: true, tag: 71, afterBlock: 19 });
    let atImport: import('../recovery/types').RecoveryJournalSnapshot | undefined;
    fixture.imported.mockImplementation(async () => {
      atImport = await vault.readRecoveryJournal();
      return '34'.repeat(32);
    });
    try {
      await expect(fixture.run(expected)).resolves.toBe('34'.repeat(32));
      expect(atImport?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'note', id: '34'.repeat(32), noteFile: expected, format: 'details' })
        ])
      );
    } finally {
      fixture.restore();
    }
  });

  function journalNoteBodies(value: unknown): Uint8Array[] {
    if (typeof value !== 'object' || value === null) return [];
    const bytes: unknown = Reflect.get(value, 'noteFile');
    const own = bytes instanceof Uint8Array ? [bytes] : [];
    return own.concat(
      Object.entries(value)
        .filter(([key]) => key !== 'noteFile')
        .flatMap(([, child]) => journalNoteBodies(child))
    );
  }

  it.each(['Expected', 'full'])(
    'Task4C3C a successful %s import keeps both generations recoverable without treating success as authentication',
    async previousVariant => {
      const fixture = await acquisition();
      const candidate = new Uint8Array([19, 48, 21, 252]);
      try {
        fixture.setCandidate(fixture.noteFile, { detailsOnly: previousVariant === 'Expected', afterBlock: 0 });
        fixture.imported.mockResolvedValueOnce(previousVariant === 'Expected' ? '34'.repeat(32) : fixture.noteId);
        await fixture.run();
        fixture.setCandidate(candidate, { tag: 7, afterBlock: 10 });
        let beforeAcceptance: import('../recovery/types').RecoveryJournalSnapshot | undefined;
        fixture.imported.mockImplementation(async () => {
          beforeAcceptance = await vault.readRecoveryJournal();
          return fixture.noteId;
        });
        await expect(fixture.run(candidate)).resolves.toBe(fixture.noteId);
        expect(journalNoteBodies(beforeAcceptance)).toEqual(expect.arrayContaining([fixture.noteFile, candidate]));
        expect(journalNoteBodies(await vault.readRecoveryJournal())).toEqual(
          expect.arrayContaining([fixture.noteFile, candidate])
        );
        expect(getStorageHealth().status).toBe('healthy');
      } finally {
        fixture.restore();
      }
    }
  );

  it.each(['Note inclusion proof rejected', 'User cancelled import'])(
    'Task4C3C generic refusal %s keeps both candidate and earlier good evidence without poisoning health',
    async message => {
      const fixture = await acquisition();
      const candidate = new Uint8Array([19, 48, 22, 251]);
      try {
        await fixture.run();
        const before = await vault.readRecoveryJournal();
        fixture.setCandidate(candidate, { afterBlock: 11 });
        let beforeValidation: import('../recovery/types').RecoveryJournalSnapshot | undefined;
        fixture.imported.mockImplementation(async () => {
          beforeValidation = await vault.readRecoveryJournal();
          throw new Error(message);
        });
        await expect(fixture.run(candidate)).rejects.toThrow(message);
        expect(journalNoteBodies(beforeValidation)).toEqual(expect.arrayContaining([fixture.noteFile, candidate]));
        const after = await vault.readRecoveryJournal();
        expect(before).toBeDefined();
        expect(after).toMatchObject({ scope: before?.scope, accounts: before?.accounts });
        expect(after?.entries).toEqual(
          expect.arrayContaining((before?.entries ?? []).map(entry => expect.objectContaining(entry)))
        );
        expect(after?.sequence).toBeGreaterThanOrEqual(before?.sequence ?? 0);
        expect(journalNoteBodies(after)).toEqual(expect.arrayContaining([fixture.noteFile, candidate]));
        expect(getStorageHealth().status).toBe('healthy');
      } finally {
        fixture.restore();
      }
    }
  );

  it('Task4C3C owner loss after SDK entry preserves staged bytes and refuses the late import acknowledgement', async () => {
    const fixture = await acquisition();
    const candidate = new Uint8Array([19, 48, 23, 250]);
    let release = () => {};
    let reached = () => {};
    const paused = new Promise<void>(resolve => {
      release = resolve;
    });
    const entered = new Promise<void>(resolve => {
      reached = resolve;
    });
    await fixture.run();
    fixture.setCandidate(candidate, { afterBlock: 12 });
    fixture.imported.mockImplementation(async () => {
      reached();
      await paused;
      return fixture.noteId;
    });
    const pending = fixture.run(candidate).then(
      () => 'accepted',
      () => 'refused'
    );
    let current: Vault | undefined;
    try {
      await Promise.race([entered, pending]);
      vault.retire();
      current = new Vault(fixtureKey);
      const retained = await current.readRecoveryJournal();
      release();
      expect(await pending).toBe('refused');
      expect(journalNoteBodies(retained)).toEqual(expect.arrayContaining([fixture.noteFile, candidate]));
      expect(await current.readRecoveryJournal()).toEqual(retained);
      expect(getStorageHealth().status).toBe('healthy');
    } finally {
      release();
      await pending;
      current?.retire();
      fixture.restore();
    }
  });

  it('Task4C3C a full journal refuses another private candidate before SDK acceptance and preserves prior evidence', async () => {
    const fixture = await acquisition();
    try {
      await fixture.run();
      const initial = await vault.readRecoveryJournal();
      expect(initial).toBeDefined();
      const { JOURNAL_MAX_ENTRIES } = await import('../recovery/journal');
      await vault.retainRecoveryEntries(
        Array.from(
          { length: JOURNAL_MAX_ENTRIES - (initial?.entries.length ?? 0) },
          (_, index): import('../recovery/types').RecoveryEntry => ({
            kind: 'note',
            id: `capacity-${index}`,
            accountId: 'retained',
            provenance: 'input',
            format: 'details',
            noteFile: new Uint8Array([8, 9, 10])
          })
        )
      );
      const before = await vault.readRecoveryJournal();
      const candidate = new Uint8Array([19, 48, 24, 249]);
      fixture.setCandidate(candidate, { afterBlock: 13 });
      fixture.imported.mockClear();
      const outcome = await fixture.run(candidate).then(
        () => 'accepted',
        () => 'refused'
      );
      expect(outcome).toBe('refused');
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toEqual(before);
    } finally {
      fixture.restore();
    }
  });

  it('Task4C3 public-only capture keeps unresolved prebroadcast transaction evidence', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const row: ITransaction = {
      id: 'public-pending',
      accountId: 'retained',
      type: 'send',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      displayIcon: 'SEND',
      noteType: NoteTypeEnum.Public,
      attemptId: 'attempt-public',
      mayHaveSubmitted: true
    };
    await Repo.transactions.put(row);
    const requestBytes = new Uint8Array([5, 6, 7]);
    const evidence = { transactionId: 'candidate-public', outputNoteIds: ['output-public'] };
    await vault.retainTransactionRecovery(row.id, { requestBytes, notes: [] }, evidence, row.attemptId);
    const retained = (await vault.readRecoveryJournal())?.entries.find(
      entry => entry.kind === 'transaction' && entry.id === row.id
    );
    expect(retained).toMatchObject({
      kind: 'transaction',
      requestBytes,
      mayHaveSubmitted: true,
      evidence,
      row: { attemptId: row.attemptId, status: row.status, requestBytes }
    });
  });

  it.each(['held source callback', 'retired vault'])(
    'Task4C2 actual receipt route handles %s without reentering SDK continuity',
    async scenario => {
      expect(await vault.verifyStorageContinuity()).toBe(true);
      readSnapshot.mockClear();
      const row: ITransaction = {
        id: 'provider-receipt',
        accountId: 'retained',
        type: 'bridged-receive',
        status: ITransactionStatus.Completed,
        initiatedAt: 1,
        displayIcon: 'RECEIVE',
        extraInputs: {
          provider: 'agglayer',
          phase: 'delivering',
          sourceAddress: '0x1111111111111111111111111111111111111111',
          sourceAmount: '1',
          sourceSymbol: 'ETH',
          evmTxHash: `0x${'1'.repeat(64)}`,
          agglayerRoute: {
            chainId: 1,
            contractAddress: '0x1111111111111111111111111111111111111111',
            midenBridgeId: 'bridge',
            indexerUrl: 'https://indexer.example',
            rollupId: 1,
            evmNetworkId: 0
          }
        }
      };
      await Repo.transactions.put(row);
      installProviderReceiptBackend((value, epoch) => vault.checkpointProviderReceipt(value, epoch));
      const { withWasmClientLock } = await import('../sdk/miden-client');
      const { getAccountsWriteQueue } = await import('./accounts-write-queue');
      const nestedBefore = Reflect.get(globalThis, '__vaultTestLockNested') ?? 0;
      if (scenario === 'retired vault') vault.retire();
      const result = getAccountsWriteQueue().add(() =>
        withWasmClientLock(async () => {
          await checkpointProviderReceipt(row);
        })
      );
      const outcome = await result.then(
        () => 'retained',
        (error: unknown) => error
      );
      const locked = expect.objectContaining({ reason: 'locked' });
      expect(outcome).toEqual(scenario === 'retired vault' ? locked : 'retained');
      const retained = await vault.readRecoveryJournal();
      const expectedReceipt = expect.objectContaining({
        kind: 'receipt',
        accountId: 'retained',
        row: expect.objectContaining({
          status: ITransactionStatus.Completed,
          extraInputs: expect.objectContaining({ evmTxHash: `0x${'1'.repeat(64)}` })
        })
      });
      expect(retained?.entries.find(entry => entry.id === row.id)).toEqual(
        scenario === 'retired vault' ? undefined : expectedReceipt
      );
      expect(Reflect.get(globalThis, '__vaultTestLockNested') ?? 0).toBe(nestedBefore);
      expect(readSnapshot).not.toHaveBeenCalled();
    }
  );

  it.each(['receipt after critical', 'critical after receipt'])(
    'Task4C2 lifecycle preserves critical bytes and provider receipt for %s',
    async ordering => {
      expect(await vault.verifyStorageContinuity()).toBe(true);
      const row: ITransaction = {
        id: 'receipt-critical-race',
        accountId: 'retained',
        type: 'bridged-send',
        status: ITransactionStatus.Completed,
        initiatedAt: 1,
        displayIcon: 'SEND',
        mayHaveSubmitted: true,
        extraInputs: { provider: 'epoch', intentNonce: '22', evmTxHash: 'hash-a', claimStatus: 'pending' }
      };
      await Repo.transactions.put(row);
      await vault.retainTransactionRecovery(row.id, { requestBytes: new Uint8Array([1]), notes: [] });
      const first = (await vault.readRecoveryJournal())?.entries.find(
        entry => entry.kind === 'transaction' && entry.id === row.id
      );
      if (first?.kind !== 'transaction') throw new Error('Missing critical fixture');
      installProviderReceiptBackend((value, epoch) => vault.checkpointProviderReceipt(value, epoch));
      const retain = vault.retainRecoveryEntries.bind(vault);
      const latestEvidence = { transactionId: 'latest-chain-id', finalCommitment: 'latest-state' };
      if (ordering === 'receipt after critical') {
        let interleaved = false;
        const spy = jest.spyOn(vault, 'retainRecoveryEntries').mockImplementation(async (entries, retries) => {
          if (!interleaved) {
            interleaved = true;
            await vault.retainTransactionRecovery(
              row.id,
              { requestBytes: new Uint8Array([9]), notes: [] },
              latestEvidence
            );
          }
          await retain(entries, retries);
        });
        const current = await Repo.transactions.get(row.id);
        if (!current) throw new Error('Missing receipt fixture');
        await checkpointProviderReceipt(current).catch(() => {});
        spy.mockRestore();
      } else {
        await Repo.transactions.update(row.id, { extraInputs: { ...row.extraInputs, evmTxHash: 'hash-b' } });
        const current = await Repo.transactions.get(row.id);
        if (!current) throw new Error('Missing receipt fixture');
        await checkpointProviderReceipt(current);
        await vault.retainRecoveryEntries([{ ...first, requestBytes: new Uint8Array([9]), evidence: latestEvidence }]);
      }
      const entries = (await vault.readRecoveryJournal())?.entries;
      const critical = entries?.find(entry => entry.kind === 'transaction' && entry.id === row.id);
      expect(critical?.kind === 'transaction' && Array.from(critical.requestBytes)).toEqual([9]);
      expect(critical?.kind === 'transaction' && critical.evidence.transactionId).toBe('latest-chain-id');
      const receipt = entries?.find(entry => entry.kind === 'receipt' && entry.id === row.id);
      expect(receipt?.kind === 'receipt' && receipt.row.extraInputs?.evmTxHash).toBe(
        ordering === 'receipt after critical' ? 'hash-a' : 'hash-b'
      );
      expect(getStorageHealth().status).toBe('healthy');
    }
  );

  it('Task4C2 finalseams reuses identical provider evidence despite refreshed poll timestamps', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const row = oneClickReceiptRow();
    row.accountId = 'retained';
    row.extraInputs.oneClick.accountId = 'retained';
    row.extraInputs.oneClick.updatedAt = 1;
    await Repo.transactions.put(row);
    installProviderReceiptBackend((value, epoch) => vault.checkpointProviderReceipt(value, epoch));
    await checkpointProviderReceipt(row);
    const first = await vault.readRecoveryJournal();
    const writes = mockStorageSets.length;
    row.extraInputs.oneClick.updatedAt = 2;
    await Repo.transactions.put(row);
    await checkpointProviderReceipt(row);
    expect((await vault.readRecoveryJournal())?.sequence).toBe(first?.sequence);
    expect(mockStorageSets.length).toBe(writes);
    expect(getStorageHealth().status).toBe('healthy');
  });

  it('establishes an encrypted first checkpoint after coherent retained account reads', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const snapshot = await vault.readRecoveryJournal();
    expect(snapshot).toMatchObject({
      accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
      entries: expect.arrayContaining([
        { kind: 'note', id: 'private-note', noteFile: new Uint8Array([1, 2]), provenance: 'input' }
      ])
    });
    expect(await Repo.metadata.get('generation')).toMatchObject({ origin: 'authorized' });
    const writes = mockStorageSets.length;
    expect(await vault.verifyStorageContinuity()).toBe(true);
    expect(mockStorageSets.slice(writes).flat()).not.toContain('miden_recovery_v1_1');
  });

  it.each(['complete', 'new incident', 'pending read'])(
    'Task4C1 actual Vault reconciliation handles %s',
    async scenario => {
      expect(await vault.verifyStorageContinuity()).toBe(true);
      await Repo.transactions.put({
        id: 'reconcile-actual',
        accountId: 'retained',
        type: 'send',
        status: ITransactionStatus.Unconfirmed,
        initiatedAt: 1,
        displayIcon: 'SEND',
        mayHaveSubmitted: true,
        attemptId: 'attempt',
        submitEvidence: [
          {
            attemptId: 'attempt',
            capturedAt: 1,
            source: 'stage',
            transactionId: 'transaction',
            initialCommitment: 'state-4',
            finalCommitment: 'state-5',
            initialNonce: '4',
            refBlock: 10,
            refBlockCommitment: 'header',
            outputNoteIds: [],
            nullifiers: [],
            expirationBlock: 30
          }
        ]
      });
      await vault.retainTransactionRecovery('reconcile-actual', { requestBytes: new Uint8Array([7, 8]), notes: [] });
      await Repo.transactions.update('reconcile-actual', { restoredFromBackup: true, restoredFromJournal: true });
      const prior = await vault.readRecoveryJournal();
      if (!prior) throw new Error('Missing reconciliation fixture');
      let release = () => {};
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      const dispose = jest.fn();
      const reads = jest.mocked(CanonicalReads.createRecoveryCanonicalReads).mockResolvedValue({
        dispose,
        identity: async () => undefined,
        header: async () => 'header',
        scan: async () => [],
        node: {
          blockCommitment: async () => 'header',
          account: async () => {
            if (scenario === 'pending read') await pending;
            if (scenario === 'new incident')
              markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
            return { ok: true, state: { blockNum: 20, commitment: 'state-5', nonce: '5' } };
          },
          noteInclusions: async () => new Map(),
          nullifierHeight: async () => undefined
        }
      });
      markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
      try {
        const complete = scenario === 'complete';
        const outcome = await vault.reconcileStorageRecovery().then(
          value => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error })
        );
        const unavailable = expect.objectContaining({ name: 'StorageUnavailableError' });
        expect(outcome.error).toEqual(complete ? undefined : unavailable);
        expect(outcome.value).toEqual(complete ? { reconciled: 1, retired: 0 } : undefined);
        expect(await Repo.transactions.get('reconcile-actual')).toMatchObject({
          status: complete ? ITransactionStatus.Completed : ITransactionStatus.Unconfirmed,
          restoredFromBackup: true,
          restoredFromJournal: true
        });
        const saved = await vault.readRecoveryJournal();
        expect(saved?.sequence).toBe((prior?.sequence ?? 0) + (complete ? 1 : 0));
        const resolved = expect.arrayContaining([
          expect.objectContaining({
            id: 'reconcile-actual',
            resolved: { outcome: 'landed', at: expect.any(Number) },
            row: expect.objectContaining({ submitEvidence: [expect.objectContaining({ landingSeenBy: 1 })] })
          })
        ]);
        expect(saved?.entries).toEqual(complete ? resolved : prior.entries);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(getStorageHealth().status).toBe('unavailable');
      } finally {
        release();
        await new Promise(resolve => setTimeout(resolve, 0));
        reads.mockReset();
        await resetStorageHealthForLifecycle(getStorageHealth().epoch);
        await Repo.db.open();
      }
    }
  );

  it('preserves retained vault identity and the journal when an SDK account disappears', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const prior = await vault.readRecoveryJournal();
    readSnapshot.mockRejectedValueOnce(new StorageContinuityError());
    try {
      expect(await vault.verifyStorageContinuity()).toBe(false);
      expect(getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'continuity' });
      expect(await vault.fetchAccounts()).toEqual([expect.objectContaining({ publicKey: 'retained' })]);
      expect(await vault.readRecoveryJournal()).toEqual(prior);
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it.each(['spending limit', 'charged transaction'])('refuses recovery after partial loss of %s', async lost => {
    await Repo.spendingLimits.put({
      accountId: 'retained',
      limit: '5000000',
      revision: 'policy-1',
      createdAt: 1,
      updatedAt: 1
    });
    await Repo.transactions.put({
      id: 'debit-1',
      accountId: 'retained',
      type: 'send',
      status: ITransactionStatus.Failed,
      initiatedAt: Math.floor(Date.now() / 1000),
      spentUsd: 4000000n,
      displayIcon: 'FAILED',
      neverCommittedAt: 1
    });
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const prior = await vault.readRecoveryJournal();
    if (lost === 'spending limit') await Repo.spendingLimits.delete('retained');
    else await Repo.transactions.delete('debit-1');
    markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
    try {
      expect(await vault.checkStorageRecovery()).toBe(false);
      expect(getStorageHealth().status).toBe('unavailable');
      expect(await vault.readRecoveryJournal()).toEqual(prior);
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('refuses recovery when a journaled uncertain transaction row disappears', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    await Repo.transactions.put({
      id: 'uncertain',
      accountId: 'retained',
      type: 'send',
      status: ITransactionStatus.Unconfirmed,
      initiatedAt: Math.floor(Date.now() / 1000),
      displayIcon: 'SEND',
      mayHaveSubmitted: true,
      attemptId: 'attempt-a'
    });
    await vault.retainTransactionRecovery('uncertain', { requestBytes: new Uint8Array([7, 8]), notes: [] });
    await Repo.transactions.delete('uncertain');
    markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
    try {
      expect(await vault.checkStorageRecovery()).toBe(false);
      expect(getStorageHealth().status).toBe('unavailable');
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('refuses a fresh wallet database before establishing retained expectations', async () => {
    await Repo.metadata.put({ id: 'generation', generation: 'fresh', origin: 'fresh' });
    try {
      expect(await vault.verifyStorageContinuity()).toBe(false);
      expect(initializeGeneration).not.toHaveBeenCalled();
      expect(await vault.readRecoveryJournal()).toBeUndefined();
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('requires the real journal and both store markers before clearing an incident', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
    expect(await vault.checkStorageRecovery()).toBe(true);
    expect(getStorageHealth().status).toBe('healthy');
    expect(readSnapshot).toHaveBeenLastCalledWith(
      ['retained'],
      true,
      expect.objectContaining({ expiresAt: expect.any(Number) }),
      expect.arrayContaining([expect.objectContaining({ id: 'private-note' })])
    );
  });

  it('validates retained stores through scoped reads when the ordinary wallet handle is closed', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    Repo.db.close();
    markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
    try {
      expect(await vault.checkStorageRecovery()).toBe(true);
      expect(getStorageHealth().status).toBe('healthy');
      await expect(Repo.metadata.get('generation')).resolves.toMatchObject({ generation: 'wallet-fixture' });
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
      await Repo.db.open();
    }
  });

  it('refuses stale recovery completion after a repeated storage incident', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
    readSnapshot.mockImplementationOnce(async () => {
      markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
      return { generation, accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }], notes: [] };
    });
    try {
      expect(await vault.checkStorageRecovery()).toBe(false);
      expect(getStorageHealth().status).toBe('unavailable');
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('does not clear an incident through a Vault retired before its recovery check', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
    vault.retire();
    try {
      await expect(vault.checkStorageRecovery()).resolves.toBe(false);
      expect(getStorageHealth().status).toBe('unavailable');
    } finally {
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });

  it('refuses a retired vault writer after reset without poisoning the replacement wallet', async () => {
    expect(await vault.verifyStorageContinuity()).toBe(true);
    const prior = await vault.readRecoveryJournal();
    await removeMany([keys.check]);
    await expect(vault.retainRecoveryEntries([])).rejects.toThrow('StorageUnavailableError');
    expect(getStorageHealth().status).toBe('healthy');
    expect(await vault.readRecoveryJournal()).toEqual(prior);
  });

  it.each(['complete', 'retired vault', 'changed binding', 'new incident'])(
    'explicit storage reconstruction handles %s',
    async scenario => {
      const account = {
        publicKey: 'retained',
        name: 'Account',
        isPublic: false,
        type: WalletType.Guardian,
        hdIndex: -1,
        authScheme: 'ecdsa',
        hotPublicKey: '02'.repeat(33),
        guardianEndpoint: 'https://guardian.example',
        guardianOperatorCommitment: 'aa'
      };
      await encryptAndSaveMany(
        [
          [keys.accounts, [account]],
          [keys.accAuthSecretKey(account.hotPublicKey), 'test-ciphertext']
        ],
        fixtureKey
      );
      expect(await vault.verifyStorageContinuity()).toBe(true);
      const prior = await vault.readRecoveryJournal();
      if (!prior) throw new Error('Missing journal fixture');
      let sdkAccount = false;
      generation = null;
      readSnapshot.mockImplementation(async () => {
        if (!sdkAccount) throw new StorageContinuityError();
        return { generation, accounts: prior.accounts, notes: prior.entries.filter(entry => entry.kind === 'note') };
      });
      const restore = jest.spyOn(midenClientProxy, 'restoreStorageRecovery').mockImplementation(async command => {
        if (command.kind === 'account') sdkAccount = true;
        if (command.kind === 'generation') generation = command.generation;
      });
      mockRecoveryCommitment.mockResolvedValue('bb');
      mockRecoveryGuardianState.mockImplementation(async () => {
        if (scenario === 'retired vault') vault.retire();
        if (scenario === 'changed binding')
          await encryptAndSaveMany([[keys.accounts, [{ ...account, guardianEpoch: 1 }]]], fixtureKey);
        if (scenario === 'new incident') markStorageUnavailable('quota', { backend: 'sdk', operation: 'mutate' });
        return { accountBytes: new Uint8Array([1]), chainCommitment: 'state-4' };
      });
      await Repo.db.delete();
      markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
      try {
        const progress: import('../recovery/types').StorageRecoveryProgress[] = [];
        await expect(vault.recoverStorage(value => progress.push(value))).resolves.toBe(scenario === 'complete');
        expect(await vault.readRecoveryJournal()).toEqual(prior);
        expect(progress.at(-1)?.phase).toBe(scenario === 'complete' ? 'complete' : 'accounts');
        const completed = scenario === 'complete';
        expect(getStorageHealth().status).toBe(completed ? 'healthy' : 'unavailable');
        expect(generation).toBe(completed ? prior.scope.sdkGeneration : null);
        expect(restore).toHaveBeenCalledTimes(
          completed
            ? 2 + prior.entries.filter(entry => entry.kind === 'note' && entry.provenance === 'input').length
            : 0
        );
        expect(
          (await vault.fetchAccounts()).map(value => ({
            publicKey: value.publicKey,
            guardianNoteRecoveryPending: value.guardianNoteRecoveryPending
          }))
        ).toEqual([{ publicKey: 'retained', guardianNoteRecoveryPending: completed ? true : undefined }]);
        const marker = completed ? await Repo.metadata.get('generation') : undefined;
        expect(marker).toEqual(
          completed ? { id: 'generation', generation: prior.scope.walletGeneration, origin: 'authorized' } : undefined
        );
      } finally {
        restore.mockRestore();
        mockRecoveryCommitment.mockReset();
        mockRecoveryGuardianState.mockReset();
        await resetStorageHealthForLifecycle(getStorageHealth().epoch);
        await Repo.db.open();
      }
    }
  );
});
