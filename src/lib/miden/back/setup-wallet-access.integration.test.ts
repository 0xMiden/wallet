/** @jest-environment node */
import { withWalletRequestAccess } from 'lib/intercom/wallet-request-access';
import { PENDING_ADMISSION_STORAGE_KEY } from 'lib/miden/reset';
import type { DerivedBridgeConfig } from 'lib/remote-config/derive';
import type { FeatureEligibility } from 'lib/remote-config/geo';
import { _resetBridgeConfigRuntimeForTest, initBridgeConfig } from 'lib/remote-config/runtime';
import type { BridgeConfig } from 'lib/remote-config/schema';
import {
  assertWalletAccessAllowed,
  ensureWalletAccessAllowed,
  getWalletAccessGeneration,
  getWalletAccessSnapshot,
  invalidateWalletAccess,
  type WalletAccessSnapshot
} from 'lib/remote-config/wallet-access';
import { WalletMessageType, WalletStatus, type WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { lock, registerImportedWallet, registerNewWallet, registerWalletFromHotKey, unlock } from './actions';
import { inited, locked, store, unlocked } from './store';
import { Vault } from './vault';

jest.unmock('lib/remote-config/wallet-access');
jest.unmock('lib/miden/back/vault');
jest.unmock('./vault');

const mockStorage = new Map<string, unknown>();
const mockRereads = new Set<() => Promise<void>>();
const mockChanges = new Map<string, Set<() => void>>();
const mockWrites: string[] = [];
const mockWipes: number[] = [];
let mockNetwork = 'testnet';
let mockNow = 1_000;
type KeySink = (key: Uint8Array, secret: Uint8Array) => Promise<void>;
let mockSink: KeySink | null = null;
let mockHold: object | null = null;
let mockAfterWipe: (() => void) | undefined;
let mockImportGate: (() => Promise<void>) | undefined;

// The barrier changes scheduling only; vault keys and every cryptographic operation stay real.
jest.mock('lib/miden/passworder', () => {
  const actual = jest.requireActual<typeof import('lib/miden/passworder')>('lib/miden/passworder');
  return {
    ...actual,
    importVaultKey: async (bytes: Uint8Array) => {
      const key = await actual.importVaultKey(bytes);
      await mockImportGate?.();
      return key;
    }
  };
});

jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isDesktop: () => false,
  isExtension: () => false,
  isIOS: () => true,
  isAndroid: () => false
}));
jest.mock('lib/platform/storage-adapter', () => ({
  DESKTOP_STORAGE_PREFIX: '',
  getStorageProvider: () => ({
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter(key => mockStorage.has(key)).map(key => [key, mockStorage.get(key)])),
    set: async (items: Record<string, unknown>) => {
      Object.entries(items).forEach(([key, value]) => {
        mockWrites.push(key);
        mockStorage.set(key, value);
      });
    },
    remove: async (keys: string[]) => keys.forEach(key => mockStorage.delete(key))
  })
}));
jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    keys: async () => {
      mockWipes.push(getWalletAccessGeneration());
      return { keys: [...mockStorage.keys()] };
    },
    remove: async ({ key }: { key: string }) => mockStorage.delete(key)
  }
}));
jest.mock('lib/biometric', () => ({
  isHardwareSecurityAvailable: async () => true,
  hasHardwareKey: async () => true,
  generateHardwareKey: async () => undefined,
  encryptWithHardwareKey: async (value: string) => `hardware:${value}`,
  decryptWithHardwareKey: async (value: string) => value.slice('hardware:'.length)
}));
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => mockStorage.get(key) ?? null,
  putToStorage: async (key: string, value: unknown) => mockStorage.set(key, value),
  registerStorageReread: (read: () => Promise<void>) => mockRereads.add(read),
  rereadStorageCache: async () => Promise.all([...mockRereads].map(read => read())),
  onStorageChanged: (key: string, read: () => void) => {
    const callbacks = mockChanges.get(key) ?? new Set<() => void>();
    callbacks.add(read);
    mockChanges.set(key, callbacks);
    const stop = () => {
      callbacks.delete(read);
    };
    return Object.assign(stop, { attached: Promise.resolve() });
  }
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ENDPOINT_OVERRIDE_STORAGE_KEY: 'endpoint_override',
  getEffectiveNetworkName: () => mockNetwork,
  getEffectiveRpcUrl: () => 'https://rpc.example',
  getEffectiveDefaultGuardianEndpoint: () => 'https://guardian.example',
  loadEndpointOverrides: async () => undefined
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  resetNativeAssetCache: async () => {
    mockAfterWipe?.();
  },
  primeNativeAssetId: () => undefined
}));
jest.mock('lib/remote-config/source', () => ({
  BRIDGE_CONFIG_FLOOR_KEY: 'bridge_config_floor_v1',
  bridgeConfigCacheKey: (network: string) => `bridge_config_v1:${network}`,
  readStoredBridgeConfig: async (network: string) => mockStorage.get(`bridge_config_v1:${network}`) ?? null,
  fetchAndStoreBridgeConfig: async (network: string) => mockStorage.get(`bridge_config_v1:${network}`) ?? null
}));
jest.mock('lib/remote-config/derive', () => ({
  deriveBridgeConfig: async (config: BridgeConfig) => derived(config)
}));
const mockLookup = jest.fn<Promise<FeatureEligibility | null>, [string, number]>();
jest.mock('lib/remote-config/geo-lookup', () => ({
  lookupFeatureEligibility: (network: string, version: number) => mockLookup(network, version)
}));
jest.mock('lib/remote-config/e2e-overrides', () => ({ getE2eOverrides: () => ({ earnCollateralFaucet: null }) }));

const mockSdkWrites: string[] = [];
const mockCreate = async () => {
  mockSdkWrites.push('create');
  await mockSink?.(new Uint8Array([2, 3]), new Uint8Array([4, 5]));
  return 'fixture-account';
};
const mockClient = {
  network: 'testnet',
  createMidenWallet: mockCreate,
  importPublicMidenWalletFromSeed: mockCreate,
  syncState: async () => undefined,
  recoverGuardianAccountByHotKey: async () => {
    mockSdkWrites.push('hot-key recovery');
    return [{ accountId: 'fixture-account', hotPublicKey: 'dead' }];
  },
  getAccounts: async () => [{ id: () => 'fixture-account' }],
  getAccount: async () => ({ id: () => 'fixture-account', isFaucet: () => false }),
  client: {
    keystore: {
      insert: async () => {
        mockSdkWrites.push('file key');
        await mockSink?.(new Uint8Array([2, 3]), new Uint8Array([4, 5]));
      }
    }
  }
};
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: async () => mockClient,
  getCurrentWasmLockHold: () => mockHold,
  assertWasmHoldCurrent: (hold: object) => {
    if (hold !== mockHold) throw new Error('Lost fixture hold');
  },
  installRealmKeystore: (callbacks: { insertKey?: KeySink | null }) => {
    if ('insertKey' in callbacks) mockSink = callbacks.insertKey ?? null;
  },
  uninstallRealmKeystore: (callbacks: { insertKey: KeySink }) => {
    if (mockSink === callbacks.insertKey) mockSink = null;
  },
  isRealmKeystoreInstalled: (callbacks: { insertKey: KeySink }) => mockSink === callbacks.insertKey,
  withWasmClientLock: async <T>(run: (hold: object) => Promise<T>) => {
    if (mockHold) throw new Error('Nested fixture hold');
    const hold = {};
    mockHold = hold;
    try {
      return await run(hold);
    } finally {
      mockHold = null;
    }
  }
}));
jest.mock('../sdk/miden-client', () => jest.requireMock('lib/miden/sdk/miden-client'));
jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: string) => id,
  sameWalletAccountId: (left: string, right: string) => left === right
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
  AuthSecretKey: { ecdsaWithRNG: () => ({}) }
}));
jest.mock('../guardian/hot-key-import', () => ({
  deserializeHotSecretKey: () => ({
    getEcdsaK256KeccakSecretKeyAsFelts: () => [],
    publicKey: () => ({ serialize: () => new Uint8Array([2, 0xde, 0xad]), free: () => undefined }),
    serialize: () => new Uint8Array([1, 2, 3]),
    free: () => undefined
  })
}));
jest.mock('./miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../guardian/account', () => ({
  resolveGuardianEndpoint: () => 'https://guardian.example'
}));
jest.mock('../guardian/operator-map', () => ({
  normalizeHex: (value: string) => value.replace(/^0x/, '').toLowerCase()
}));
jest.mock('app/defaults', () => ({ ACCOUNT_NAME_PATTERN: /^[a-z]+$/ }));
jest.mock('lib/i18n', () => ({ getMessage: (key: string) => key }));
jest.mock('lib/miden/activity', () => ({ importAllNotes: jest.fn(), retryDeadletteredNotes: jest.fn() }));
jest.mock('./dapp', () => ({}));
jest.mock('./guardian-drift', () => ({}));
jest.mock('./guardian-recovery', () => ({ releaseGuardianRecoveriesOnLock: () => undefined }));
jest.mock('lib/telemetry/sink', () => ({ sendEvent: jest.fn() }));
jest.mock('lib/usdcx/burn-fee', () => ({}));
jest.mock('lib/miden/spending-limits/valuation', () => ({}));
const mockRedeem = jest.fn<Promise<'granted' | 'rejected'>, []>();
jest.mock('lib/mainnet-access', () => ({
  redeemMainnetAccessCode: () => mockRedeem(),
  isMainnetAccountAdmitted: async () => true
}));

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HOT_PAIR = `${'01'.repeat(32)}:${'02'.repeat(32)}`;
const restoredAccount: WalletAccount = {
  publicKey: 'fixture-account',
  name: 'Fixture',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: 0,
  authScheme: 'ecdsa',
  keyDerivation: 'v1'
};
const flows = [
  { name: 'new wallet', run: (password?: string) => registerNewWallet(WalletType.OnChain, password) },
  {
    name: 'mnemonic restore',
    run: (password?: string) => registerNewWallet(WalletType.OnChain, password, MNEMONIC, true)
  },
  {
    name: 'hot-key import',
    run: (password?: string) => registerWalletFromHotKey(password, HOT_PAIR, 'https://guardian.example')
  },
  {
    name: 'encrypted-file restore',
    run: (password?: string) => registerImportedWallet(password, MNEMONIC, [restoredAccount], [])
  }
];
function derived(config: BridgeConfig): DerivedBridgeConfig {
  const skipped: { state: 'skipped' } = { state: 'skipped' };
  return {
    network: config.network,
    version: config.version,
    derivedAt: Date.now(),
    chains: {},
    agglayer: { indexer: skipped },
    epoch: { allocator: skipped, market: skipped, midenUsdcFaucet: skipped },
    swap: { pairs: skipped }
  };
}
function answer(wallet = true): FeatureEligibility {
  return { network: mockNetwork, version: 13, allowed: { wallet, earn: true, swap: true } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function settled(run: Promise<unknown>) {
  return run.then(
    () => 'resolved',
    (error: unknown) => error
  );
}
const publications: Array<{ access: WalletAccessSnapshot; generation: number }> = [];
let stopWatching: () => void;

beforeEach(async () => {
  _resetBridgeConfigRuntimeForTest();
  jest.restoreAllMocks();
  mockNow = 1_000;
  jest.spyOn(performance, 'now').mockImplementation(() => mockNow);
  mockNetwork = 'testnet';
  mockStorage.clear();
  mockWrites.length = 0;
  mockWipes.length = 0;
  mockSdkWrites.length = 0;
  publications.length = 0;
  mockSink = null;
  mockAfterWipe = undefined;
  mockImportGate = undefined;
  mockLookup.mockReset().mockImplementation(async () => answer());
  mockRedeem.mockReset().mockResolvedValue('granted');
  const config: BridgeConfig = {
    network: mockNetwork,
    version: 13,
    'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
    supportedEvmChains: {},
    features: { earn: false },
    geo: { wallet: [{ country: 'IR' }] }
  };
  mockStorage.set(`bridge_config_v1:${mockNetwork}`, { config, fetchedAt: Date.now() });
  mockStorage.set(`bridge_config_derived_v1:${mockNetwork}`, derived(config));
  locked();
  inited(false);
  await initBridgeConfig();
  await ensureWalletAccessAllowed();
  stopWatching = unlocked.watch(() => {
    publications.push({ access: getWalletAccessSnapshot(), generation: getWalletAccessGeneration() });
  });
});
afterEach(async () => {
  stopWatching();
  store.getState().vault?.retire();
  locked();
  _resetBridgeConfigRuntimeForTest();
  jest.restoreAllMocks();
});

describe.each(flows)('$name current permission at publication', ({ run }) => {
  it('renews after the real wipe before publishing allowed private state', async () => {
    const initialGeneration = getWalletAccessGeneration();
    await run();
    expect(mockWipes).toHaveLength(1);
    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(publications).toEqual([
      { access: { status: 'allowed', expiresAt: 61_000 }, generation: initialGeneration + 1 }
    ]);
    expect(store.getState().status).toBe(WalletStatus.Ready);
    expect(mockStorage.has('vault_key_hardware')).toBe(true);
  });

  it.each([false, null])('refuses post-wipe decision %s before private setup', async decision => {
    mockLookup.mockImplementation(async () => (decision === null ? null : answer(decision)));
    const outcome = await settled(run());
    expect(outcome).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
    expect(publications).toHaveLength(0);
    expect(store.getState().status).not.toBe(WalletStatus.Ready);
    expect(mockWrites).toHaveLength(0);
    expect(mockSdkWrites).toHaveLength(0);
    expect(mockSink).toBeNull();
  });

  it('waits for fresh permission before protector writes and publication', async () => {
    const pending = deferred<FeatureEligibility | null>();
    const entered = deferred<void>();
    mockLookup.mockImplementation(async () => {
      entered.resolve();
      return pending.promise;
    });
    const outcome = settled(run());
    try {
      expect(await Promise.race([entered.promise.then(() => 'lookup'), outcome.then(() => 'finished')])).toBe('lookup');
      expect(publications).toHaveLength(0);
      expect(mockWrites).toHaveLength(0);
      expect(mockSdkWrites).toHaveLength(0);
    } finally {
      pending.resolve(answer());
      await outcome;
    }
    expect(publications).toHaveLength(1);
    expect(publications[0]?.access.status).toBe('allowed');
  });

  it('cannot publish from a lookup started before the wipe retired its scope', async () => {
    const imported = deferred<void>();
    const releaseImport = deferred<void>();
    mockImportGate = async () => {
      imported.resolve();
      await releaseImport.promise;
    };
    const obsolete = deferred<FeatureEligibility | null>();
    const fresh = deferred<FeatureEligibility | null>();
    const obsoleteEntered = deferred<void>();
    const wiped = deferred<void>();
    mockAfterWipe = () => wiped.resolve();
    mockLookup
      .mockImplementationOnce(async () => {
        obsoleteEntered.resolve();
        return obsolete.promise;
      })
      .mockImplementation(async () => fresh.promise);
    const outcome = settled(run());
    await imported.promise;
    invalidateWalletAccess();
    const oldRefresh = settled(ensureWalletAccessAllowed());
    await obsoleteEntered.promise;
    releaseImport.resolve();
    try {
      await wiped.promise;
      obsolete.resolve(answer());
      expect(await oldRefresh).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
      expect(await outcome).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
      expect(publications).toHaveLength(0);
      expect(getWalletAccessSnapshot().status).not.toBe('allowed');
    } finally {
      obsolete.resolve(answer());
      fresh.resolve(answer());
      releaseImport.resolve();
      await Promise.all([oldRefresh, outcome]);
    }
  });

  it.each([true, false])('renews expiry after the last seed-status read, decision %s', async allowed => {
    const readStatus = Vault.prototype.fetchSeedPhraseStatus;
    jest.spyOn(Vault.prototype, 'fetchSeedPhraseStatus').mockImplementationOnce(async function (this: Vault) {
      const status = await readStatus.call(this);
      mockNow += 60_001;
      mockLookup.mockImplementation(async () => answer(allowed));
      return status;
    });
    const outcome = await settled(run());
    expect(typeof outcome === 'string' ? { result: outcome } : outcome).toMatchObject(
      allowed ? { result: 'resolved' } : { code: 'WALLET_ACCESS_DENIED' }
    );
    expect(publications.map(publication => publication.access.status)).toEqual(allowed ? ['allowed'] : []);
    expect(mockStorage.has('vault_key_hardware')).toBe(allowed);
    expect(mockSink === null).toBe(!allowed);
  });

  it('publishes with current permission using the unchanged password protector', async () => {
    await run('fixture password');
    expect(mockStorage.has('vault_key_password')).toBe(true);
    expect(publications).toHaveLength(1);
    expect(publications[0]?.access.status).toBe('allowed');
  });
});

it('returns setup success through the actual request boundary after the wipe', async () => {
  await expect(
    withWalletRequestAccess({ type: WalletMessageType.NewWalletRequest, walletType: WalletType.OnChain }, () =>
      registerNewWallet(WalletType.OnChain)
    )
  ).resolves.toBeUndefined();
  expect(publications).toHaveLength(1);
  expect(publications[0]?.access.status).toBe('allowed');
});

describe('ordinary unlock publication', () => {
  async function prepare(ready: boolean) {
    const vault = await Vault.spawn(WalletType.OnChain, '', MNEMONIC);
    await ensureWalletAccessAllowed();
    if (ready) {
      unlocked({
        vault,
        accounts: await vault.fetchAccounts(),
        settings: await vault.fetchSettings(),
        currentAccount: await vault.getCurrentAccount(),
        ownMnemonic: false,
        seedPhraseStatus: 'stored'
      });
    } else {
      vault.retire();
      locked();
    }
    publications.length = 0;
    return { saved: new Map(mockStorage), original: ready ? vault : null };
  }

  it.each([false, true])('denial after the final read preserves existing data, already Ready=%s', async ready => {
    const { saved, original } = await prepare(ready);
    const readStatus = Vault.prototype.fetchSeedPhraseStatus;
    let reads = 0;
    jest.spyOn(Vault.prototype, 'fetchSeedPhraseStatus').mockImplementation(async function (this: Vault) {
      const status = await readStatus.call(this);
      reads += 1;
      if (reads === 2) {
        invalidateWalletAccess();
        mockLookup.mockResolvedValue(answer(false));
      }
      return status;
    });
    const outcome = await settled(unlock());
    expect(outcome).toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
    expect(publications).toHaveLength(0);
    expect(mockStorage).toEqual(saved);
    expect(store.getState().vault).toBe(original);
    expect(mockSink).toBe(original?.insertKeySink ?? null);
  });

  it('renews a lease expiring after credentials before adopting the unlocked vault', async () => {
    await prepare(false);
    const readStatus = Vault.prototype.fetchSeedPhraseStatus;
    let reads = 0;
    jest.spyOn(Vault.prototype, 'fetchSeedPhraseStatus').mockImplementation(async function (this: Vault) {
      const status = await readStatus.call(this);
      reads += 1;
      if (reads === 2) mockNow += 60_001;
      return status;
    });
    await unlock();
    expect(publications).toHaveLength(1);
    expect(publications[0]?.access.status).toBe('allowed');
    expect(store.getState().status).toBe(WalletStatus.Ready);
    await lock();
    expect(mockSink).toBeNull();
  });
});

it('cached admission retry keeps the same candidate but waits for current permission', async () => {
  mockRedeem.mockRejectedValueOnce(new Error('Admission unavailable'));
  const invoke = () => registerNewWallet(WalletType.OnChain, undefined, MNEMONIC, false, undefined, 'fixture-code');
  expect(await settled(invoke())).toBeInstanceOf(Error);
  expect(mockStorage.get(PENDING_ADMISSION_STORAGE_KEY)).toEqual(['fixture-account']);
  await ensureWalletAccessAllowed();
  const wipesBeforeRetry = mockWipes.length;
  const sdkWritesBeforeRetry = mockSdkWrites.length;
  const pending = deferred<FeatureEligibility | null>();
  const entered = deferred<void>();
  mockRedeem.mockImplementationOnce(async () => {
    invalidateWalletAccess();
    mockLookup.mockImplementation(async () => {
      entered.resolve();
      return pending.promise;
    });
    return 'granted';
  });
  const outcome = settled(invoke());
  try {
    expect(await Promise.race([entered.promise.then(() => 'lookup'), outcome.then(() => 'finished')])).toBe('lookup');
    expect(publications).toHaveLength(0);
    expect(mockWipes).toHaveLength(wipesBeforeRetry);
    expect(mockSdkWrites).toHaveLength(sdkWritesBeforeRetry);
  } finally {
    pending.resolve(answer());
    await outcome;
  }
  expect(publications).toHaveLength(1);
  expect(publications[0]?.access.status).toBe('allowed');
  expect(mockStorage.has(PENDING_ADMISSION_STORAGE_KEY)).toBe(false);
  assertWalletAccessAllowed();
});
