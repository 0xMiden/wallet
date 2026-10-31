import { TEST_EARN_VAULT_INFO } from 'lib/epoch/testing/bridge-config';
import { _resetGuardianRegistryForTest, getNetworkGuardians } from 'lib/miden-chain/guardian-registry';
import { FOREGROUND_STALE_MS, MAX_BACKOFF_MS } from 'lib/versioned-document';

import type { FeatureAvailability, UnavailableReason } from './availability';
import type { BridgeToken, DerivedBridgeConfig, DerivedChainConfig, EpochTokenRead } from './derive';
import { failedDerivation } from './derived-snapshot';
import type { FeatureEligibility } from './geo';
import {
  _resetBridgeConfigRuntimeForTest,
  type BridgeConfigSnapshot,
  DEGRADED_POLL_MS,
  DEGRADED_VISIBLE_POLL_MS,
  followEffectiveNetwork,
  getBridgeConfigSnapshot,
  HEALTHY_POLL_MS,
  holdFastPoll,
  initBridgeConfig,
  initFeatureEligibility,
  _refreshBridgeConfigForTest,
  subscribeBridgeConfig
} from './runtime';
import type { BridgeConfig, GuardianConfig } from './schema';
import type { StoredBridgeConfig } from './source';
import type { SwapPairs } from './swap-pairs';
import { selectEarnVaultCatalog, selectEpochDepositTokens, selectNativeEthFaucet, selectSwapPairs } from './values';

let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork,
  getEffectiveRpcUrl: () => `https://rpc.${mockNetwork}.example`
}));

// One map stands in for platform storage: the mocked source keeps documents in it, the runtime its derivations.
const mockStorage = new Map<string, unknown>();
const mockChangeHandlers = new Map<string, Set<() => void>>();
const mockRereads: Array<() => Promise<void>> = [];
const mockGet = jest.fn(async (key: string): Promise<unknown> => mockStorage.get(key) ?? null);
const mockPut = jest.fn(async (key: string, value: unknown): Promise<void> => {
  mockStorage.set(key, value);
});
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: (key: string) => mockGet(key),
  putToStorage: (key: string, value: unknown) => mockPut(key, value),
  registerStorageReread: (reread: () => Promise<void>) => mockRereads.push(reread),
  onStorageChanged: (key: string, handler: () => void) => {
    const handlers = mockChangeHandlers.get(key) ?? new Set<() => void>();
    handlers.add(handler);
    mockChangeHandlers.set(key, handlers);
    return () => handlers.delete(handler);
  }
}));

const readEntry = (network: string): unknown => mockStorage.get(`bridge_config_v1:${network}`) ?? null;
const mockReadStored = jest.fn(async (network: string): Promise<unknown> => readEntry(network));
const mockFetch = jest.fn<Promise<StoredBridgeConfig>, [string]>();
jest.mock('./source', () => ({
  bridgeConfigCacheKey: (network: string) => `bridge_config_v1:${network}`,
  readStoredBridgeConfig: (network: string) => mockReadStored(network),
  fetchAndStoreBridgeConfig: (network: string) => mockFetch(network)
}));

const mockDerive = jest.fn<Promise<DerivedBridgeConfig>, [BridgeConfig]>();
// The Miden RPC each derivation reads, as derive itself resolves it when it starts.
const mockDerivedRpc = jest.fn<void, [string | undefined]>();
jest.mock('./derive', () => ({
  deriveBridgeConfig: (config: BridgeConfig, deps?: { midenRpcUrl?: () => string }) => {
    mockDerivedRpc(deps?.midenRpcUrl?.());
    return mockDerive(config);
  }
}));

const mockLookup = jest.fn<
  Promise<FeatureEligibility | null>,
  [
    string,
    number,
    {
      onFailure?: (reason: string, requestFailure?: string) => void;
    }?
  ]
>();
jest.mock('./geo-lookup', () => ({
  lookupFeatureEligibility: (
    network: string,
    version: number,
    options?: {
      onFailure?: (reason: string, requestFailure?: string) => void;
    }
  ) => mockLookup(network, version, options)
}));

const AVAILABLE: FeatureAvailability = { state: 'available' };
let mockAvailability: Partial<Record<string, FeatureAvailability>> = {};
const mockFeatureAvailability = jest.fn(
  (feature: string, _snapshot: unknown, _overrides: unknown): FeatureAvailability =>
    mockAvailability[feature] ?? AVAILABLE
);
jest.mock('./availability', () => ({
  BRIDGE_FEATURES: ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn', 'bridgeIn', 'bridgeOut'],
  geoFeatureGate: jest.requireActual('./availability').geoFeatureGate,
  featureAvailability: (feature: string, snapshot: unknown, overrides: unknown) =>
    mockFeatureAvailability(feature, snapshot, overrides)
}));

const mockOverrides = { earnCollateralFaucet: null };
jest.mock('./e2e-overrides', () => ({ getE2eOverrides: () => mockOverrides }));

const NOW = 1_800_000_000_000;
const CACHE = 'bridge_config_v1:testnet';
const DERIVED = 'bridge_config_derived_v2:testnet';

const config = (version: number, network = 'testnet'): BridgeConfig => ({
  network,
  version,
  'bridge-providers': { epoch: { allocatorUrl: 'https://allocator.example' }, agglayer: {}, usdcx: {} },
  supportedEvmChains: {
    sepolia: {
      chainId: 11155111,
      bridges: {
        agglayer: {
          depositEnabled: true,
          withdrawalEnabled: true,
          contractAddress: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
          midenBridgeId: '0x3b66e20b5088f25133b69216484652'
        }
      }
    }
  },
  features: { earn: true, nearIntents: false }
});
const SEPOLIA_SKIPPED: DerivedChainConfig = {
  agglayer: {
    rollupId: { state: 'skipped' },
    tokens: { state: 'skipped' },
    evmNetworkId: { state: 'skipped' },
    l1BridgeCode: { state: 'skipped' },
    depositTokens: { state: 'skipped' }
  },
  epoch: { tokens: {} }
};
const derivedFor = (source: BridgeConfig, derivedAt: number): DerivedBridgeConfig => ({
  network: source.network,
  version: source.version,
  derivedAt,
  chains: { 11155111: SEPOLIA_SKIPPED },
  agglayer: { indexer: { state: 'skipped' } },
  epoch: {
    allocator: { state: 'ok', value: true },
    market: { state: 'skipped' },
    midenUsdcFaucet: { state: 'skipped' },
    vaults: { state: 'skipped' }
  },
  swap: { pairs: { state: 'skipped' } }
});
// What the source stores on a fetch, or another realm leaves behind.
const storeEntry = (network: string, version: number, fetchedAt = Date.now()): StoredBridgeConfig => {
  const entry = { config: config(version, network), fetchedAt };
  mockStorage.set(`bridge_config_v1:${network}`, entry);
  return entry;
};
const seed = (
  version: number,
  {
    fetchedAt = NOW,
    derivedAt = fetchedAt,
    network = 'testnet'
  }: { fetchedAt?: number; derivedAt?: number; network?: string } = {}
) => {
  const entry = storeEntry(network, version, fetchedAt);
  mockStorage.set(`bridge_config_derived_v2:${network}`, derivedFor(entry.config, derivedAt));
};
const serve = (version: number) => mockFetch.mockImplementation(async network => storeEntry(network, version));
const failFetch = (message = 'HTTP 503') => mockFetch.mockRejectedValue(new Error(message));
const fireChange = (key: string) => mockChangeHandlers.get(key)?.forEach(handler => handler());
const rereadAfterWipe = () => Promise.all(mockRereads.map(reread => reread()));
const flush = () => jest.advanceTimersByTimeAsync(0);
const gate = () => {
  let release!: () => void;
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  return { opened, release };
};
const unavailable = (reason: UnavailableReason): FeatureAvailability => ({
  state: 'unavailable',
  reason,
  detail: 'test'
});

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterAll(() => {
  Reflect.deleteProperty(document, 'visibilityState');
});

let warn: jest.SpyInstance;

beforeEach(() => {
  _resetBridgeConfigRuntimeForTest();
  jest.useFakeTimers({ now: NOW });
  mockNetwork = 'testnet';
  mockStorage.clear();
  mockLookup.mockReset().mockImplementation(async (network, version) => ({
    network,
    version,
    allowed: { wallet: true, earn: false, swap: true }
  }));
  mockAvailability = {};
  visibility = 'visible';
  mockGet.mockReset().mockImplementation(async key => mockStorage.get(key) ?? null);
  mockPut.mockReset().mockImplementation(async (key, value) => {
    mockStorage.set(key, value);
  });
  mockReadStored.mockReset().mockImplementation(async network => readEntry(network));
  mockFetch.mockReset().mockRejectedValue(new Error('unexpected fetch'));
  mockDerive.mockReset().mockImplementation(async source => derivedFor(source, Date.now()));
  mockDerivedRpc.mockClear();
  mockFeatureAvailability.mockClear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('the store', () => {
  it('starts as loading, with one snapshot object, and reads nothing until something loads it', () => {
    const first = getBridgeConfigSnapshot();
    expect(first).toEqual({ network: 'testnet', status: 'loading', config: null, derived: null, lastFetch: null });
    expect(getBridgeConfigSnapshot()).toBe(first);
    expect(mockReadStored).not.toHaveBeenCalled();
  });

  it('revalidates a legacy allocator admission instead of trusting its warm derived cache', async () => {
    const entry = storeEntry('testnet', 1, NOW);
    const legacy = derivedFor(entry.config, NOW);
    mockStorage.set('bridge_config_derived_v1:testnet', legacy);
    serve(1);

    const snapshot = await initBridgeConfig();

    expect(snapshot.config).toEqual(entry.config);
    expect(snapshot.derived?.epoch.allocator).not.toEqual({ state: 'ok', value: true });
    expect(mockStorage.get('bridge_config_derived_v1:testnet')).toEqual(legacy);
    await flush();
    expect(mockDerive).toHaveBeenCalledWith(entry.config);
  });

  it('serves the stored document with its derivation, ready, without fetching a fresh copy', async () => {
    seed(3, { fetchedAt: NOW - 60_000 });
    const snapshot = await initBridgeConfig();
    await flush();
    expect(snapshot).toEqual({
      network: 'testnet',
      status: 'ready',
      config: config(3),
      derived: derivedFor(config(3), NOW - 60_000),
      lastFetch: { at: NOW - 60_000, ok: true }
    });
    expect(getBridgeConfigSnapshot()).toBe(snapshot);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('discards a stored derivation of another version and refreshes at once', async () => {
    seed(3);
    mockStorage.set(DERIVED, derivedFor(config(2), NOW));
    serve(3);
    expect(await initBridgeConfig()).toMatchObject({ status: 'loading', config: config(3), derived: null });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDerive).toHaveBeenCalledWith(config(3));
    expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'ready', derived: derivedFor(config(3), NOW) });
    expect(mockStorage.get(DERIVED)).toEqual(derivedFor(config(3), NOW));
  });

  it('reads a derivation storage cannot return as missing, and refreshes', async () => {
    seed(1);
    mockGet.mockRejectedValueOnce(new Error('storage unavailable'));
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('derived snapshot'), expect.any(Error));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('with nothing stored, resolves at once while loading and publishes the first fetch when it lands', async () => {
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 1);
    });
    await expect(initBridgeConfig()).resolves.toMatchObject({ status: 'loading', config: null });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    fetched.release();
    await flush();
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'testnet',
      status: 'ready',
      config: config(1),
      derived: derivedFor(config(1), NOW),
      lastFetch: { at: NOW, ok: true }
    });
    expect(mockStorage.get(DERIVED)).toEqual(derivedFor(config(1), NOW));
  });

  it('starts one hydration and one fetch however often it is called', async () => {
    mockFetch.mockImplementation(() => new Promise<StoredBridgeConfig>(() => undefined));
    await Promise.all([initBridgeConfig(), initBridgeConfig()]);
    await initBridgeConfig();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('with a stored document, resolves from storage without waiting for the refresh it starts', async () => {
    seed(1, { fetchedAt: NOW - HEALTHY_POLL_MS });
    mockFetch.mockImplementation(() => new Promise<StoredBridgeConfig>(() => undefined));
    let resolved: BridgeConfigSnapshot | undefined;
    void initBridgeConfig().then(snapshot => {
      resolved = snapshot;
    });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({ status: 'ready', config: config(1) });
  });

  it('keeps the last accepted document when a fetch fails, records why, and still re-runs the checks', async () => {
    seed(2, { fetchedAt: NOW - HEALTHY_POLL_MS });
    failFetch('HTTP 503');
    await initBridgeConfig();
    await flush();
    expect(mockDerive).toHaveBeenCalledWith(config(2));
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'testnet',
      status: 'ready',
      config: config(2),
      derived: derivedFor(config(2), NOW),
      lastFetch: { at: NOW, ok: false, error: 'HTTP 503' }
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('testnet'),
      expect.objectContaining({ message: 'HTTP 503' })
    );
  });

  it('with nothing stored and a failed first fetch, publishes ready with no document instead of throwing', async () => {
    failFetch();
    await expect(initBridgeConfig()).resolves.toMatchObject({ status: 'loading', config: null });
    await flush();
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'testnet',
      status: 'ready',
      config: null,
      derived: null,
      lastFetch: { at: NOW, ok: false, error: 'HTTP 503' }
    });
    expect(mockDerive).not.toHaveBeenCalled();
  });

  it('shares one refresh between concurrent callers', async () => {
    serve(1);
    await Promise.all([_refreshBridgeConfigForTest(), _refreshBridgeConfigForTest()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes on demand even when the copy is fresh, and resolves with the result', async () => {
    seed(1);
    serve(2);
    await initBridgeConfig();
    await expect(_refreshBridgeConfigForTest()).resolves.toMatchObject({
      config: config(2),
      derived: derivedFor(config(2), NOW),
      lastFetch: { at: NOW, ok: true }
    });
  });

  it('treats a copy stamped later than the clock as stale', async () => {
    seed(1, { fetchedAt: NOW + 60_000 });
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads a derivation that throws as every check failed, and keeps it out of storage', async () => {
    mockDerive.mockRejectedValue(new Error('wasm init failed'));
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({
      status: 'ready',
      config: config(1),
      derived: failedDerivation(config(1), 'wasm init failed', NOW)
    });
    expect(mockStorage.has(DERIVED)).toBe(false);
  });

  it('still shows a derivation that storage refuses to keep', async () => {
    mockPut.mockRejectedValueOnce(new Error('quota exceeded'));
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ derived: derivedFor(config(1), NOW) });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('derived snapshot'),
      expect.objectContaining({ message: 'quota exceeded' })
    );
  });

  it('notifies subscribers of each change until they unsubscribe', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeBridgeConfig(listener);
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    await _refreshBridgeConfigForTest();
    expect(listener).not.toHaveBeenCalled();
  });
  it('logs why a feature is unavailable once per change, and again once it changes', async () => {
    const logged = () =>
      warn.mock.calls.filter(([message]) => String(message).includes('fastBridgeOut is unavailable'));
    mockAvailability = { fastBridgeOut: unavailable('service-down') };
    seed(1);
    serve(1);
    await initBridgeConfig();
    await _refreshBridgeConfigForTest();
    expect(logged()).toEqual([['[remote-config] fastBridgeOut is unavailable on testnet (service-down: test)']]);
    mockAvailability = {};
    await _refreshBridgeConfigForTest();
    mockAvailability = { fastBridgeOut: unavailable('off') };
    await _refreshBridgeConfigForTest();
    expect(logged()).toHaveLength(2);
    expect(logged()[1]).toEqual(['[remote-config] fastBridgeOut is unavailable on testnet (off: test)']);
  });
});

describe('networks', () => {
  it('never shows one network document for another', async () => {
    seed(1);
    seed(5, { network: 'devnet' });
    await initBridgeConfig();
    mockNetwork = 'devnet';
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'devnet',
      status: 'loading',
      config: null,
      derived: null,
      lastFetch: null
    });
    await expect(initBridgeConfig()).resolves.toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
    mockNetwork = 'testnet';
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'testnet', config: config(1) });
  });

  it('notifies subscribers and hydrates the new network when followEffectiveNetwork is called after a switch', async () => {
    seed(1);
    seed(5, { network: 'devnet' });
    await initBridgeConfig();
    await flush();
    const listener = jest.fn();
    subscribeBridgeConfig(listener);
    mockNetwork = 'devnet';
    followEffectiveNetwork();
    expect(listener).toHaveBeenCalledTimes(1);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
  });

  it('notifies again on a return to a network this realm already hydrated', async () => {
    seed(1);
    seed(5, { network: 'devnet' });
    await initBridgeConfig();
    mockNetwork = 'devnet';
    followEffectiveNetwork();
    await flush();
    const listener = jest.fn();
    subscribeBridgeConfig(listener);
    mockNetwork = 'testnet';
    followEffectiveNetwork();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'testnet', config: config(1) });
  });

  it('resolves with the network current when the read lands, not the one it started on', async () => {
    seed(1);
    seed(5, { network: 'devnet' });
    const read = gate();
    mockReadStored.mockImplementationOnce(async network => {
      await read.opened;
      return readEntry(network);
    });
    const pending = initBridgeConfig();
    mockNetwork = 'devnet';
    read.release();
    await expect(pending).resolves.toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
  });

  it('lands nothing from a first fetch that finishes after a switch on either network', async () => {
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 2);
    });
    await expect(initBridgeConfig()).resolves.toMatchObject({ network: 'testnet', status: 'loading' });
    mockNetwork = 'devnet';
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'devnet', status: 'loading', config: null });
    seed(5, { network: 'devnet' });
    await initBridgeConfig();
    fetched.release();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
    mockNetwork = 'testnet';
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'testnet', status: 'loading', config: null });
    serve(2);
    await initBridgeConfig();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'testnet', status: 'ready', config: config(2) });
  });

  it('derives against the RPC current when a refresh started, and stores nothing once the network moved', async () => {
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 2);
    });
    await initBridgeConfig();
    mockNetwork = 'devnet';
    fetched.release();
    await flush();
    expect(mockStorage.get(DERIVED)).toBeUndefined();
    expect(mockDerivedRpc).toHaveBeenCalledWith('https://rpc.testnet.example');
    expect(mockStorage.get(CACHE)).toEqual({ config: config(2), fetchedAt: NOW });
  });

  it('after a switch back, derives a document a dropped refresh stored, though the next fetch fails', async () => {
    seed(1);
    await initBridgeConfig();
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 2);
    });
    const dropped = _refreshBridgeConfigForTest();
    await flush();
    mockNetwork = 'devnet';
    failFetch();
    fetched.release();
    await dropped;
    mockNetwork = 'testnet';
    await _refreshBridgeConfigForTest();
    expect(getBridgeConfigSnapshot().config?.version).toBe(2);
    expect(getBridgeConfigSnapshot()).toMatchObject({
      config: config(2),
      derived: derivedFor(config(2), NOW),
      lastFetch: { ok: false, error: 'HTTP 503' }
    });
  });
});

describe('commits from another realm', () => {
  it('adopts a newer document together with its derivation', async () => {
    seed(1);
    await initBridgeConfig();
    seed(2, { fetchedAt: NOW + 1, derivedAt: NOW + 2 });
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'testnet',
      status: 'ready',
      config: config(2),
      derived: derivedFor(config(2), NOW + 2),
      lastFetch: { at: NOW + 1, ok: true }
    });
  });

  it('takes a document another realm stored while this realm had none', async () => {
    const fetched = gate();
    mockFetch.mockImplementationOnce(async () => {
      await fetched.opened;
      throw new Error('HTTP 503');
    });
    const loading = initBridgeConfig();
    await flush();
    seed(1);
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'ready', config: config(1) });
    fetched.release();
    // The call itself never waited for the fetch.
    await expect(loading).resolves.toMatchObject({ status: 'loading', config: null });
  });

  it('waits for the derivation before taking a newer document', async () => {
    seed(1);
    await initBridgeConfig();
    storeEntry('testnet', 2);
    fireChange(CACHE);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ config: config(1), derived: derivedFor(config(1), NOW) });
    mockStorage.set(DERIVED, derivedFor(config(2), NOW + 5));
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ config: config(2), derived: derivedFor(config(2), NOW + 5) });
  });

  it('fills in a missing derivation from a commit of the same version', async () => {
    seed(3);
    mockStorage.set(DERIVED, derivedFor(config(2), NOW));
    mockFetch.mockImplementation(() => new Promise<StoredBridgeConfig>(() => undefined));
    await initBridgeConfig();
    mockStorage.set(DERIVED, derivedFor(config(3), NOW + 5));
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({
      status: 'ready',
      config: config(3),
      derived: derivedFor(config(3), NOW + 5)
    });
  });

  it('ignores a removal: the copy in memory stays', async () => {
    seed(1);
    await initBridgeConfig();
    const before = getBridgeConfigSnapshot();
    mockStorage.clear();
    fireChange(CACHE);
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
  });

  it('ignores an older document', async () => {
    seed(3);
    await initBridgeConfig();
    const before = getBridgeConfigSnapshot();
    seed(2, { fetchedAt: NOW + 1 });
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
  });

  it('ignores a derivation of the same version that is not newer', async () => {
    seed(3);
    await initBridgeConfig();
    const before = getBridgeConfigSnapshot();
    mockStorage.set(DERIVED, derivedFor(config(3), NOW));
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
  });

  it('takes a fresher derivation of the same version, and its fetch ends the backoff here', async () => {
    seed(3);
    await initBridgeConfig();
    failFetch();
    await _refreshBridgeConfigForTest();
    expect(getBridgeConfigSnapshot().lastFetch).toEqual({ at: NOW, ok: false, error: 'HTTP 503' });
    seed(3, { fetchedAt: NOW + 10, derivedAt: NOW + 20 });
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({
      derived: derivedFor(config(3), NOW + 20),
      lastFetch: { at: NOW + 10, ok: true }
    });
    // Healthy again, so no retry at the 60 s backoff.
    await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer document adopted while a failed refresh was out, and checks that one', async () => {
    seed(1);
    await initBridgeConfig();
    const fetched = gate();
    mockFetch.mockImplementationOnce(async () => {
      await fetched.opened;
      throw new Error('HTTP 503');
    });
    const refreshing = _refreshBridgeConfigForTest();
    seed(3);
    fireChange(DERIVED);
    await flush();
    fetched.release();
    await expect(refreshing).resolves.toMatchObject({
      config: config(3),
      derived: { version: 3 },
      lastFetch: { ok: false, error: 'HTTP 503' }
    });
    expect(mockDerive).toHaveBeenLastCalledWith(config(3));
  });

  it('keeps a newer document adopted while a fetch of an older one was out', async () => {
    seed(2);
    await initBridgeConfig();
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 3);
    });
    const refreshing = _refreshBridgeConfigForTest();
    await flush();
    seed(4, { derivedAt: NOW + 1 });
    fireChange(DERIVED);
    await flush();
    fetched.release();
    await expect(refreshing).resolves.toMatchObject({ config: config(4), lastFetch: { at: NOW, ok: true } });
    expect(mockDerive).toHaveBeenLastCalledWith(config(4));
  });

  it('does not replace a newer document adopted while its derivation ran, nor store that derivation', async () => {
    seed(2);
    await initBridgeConfig();
    serve(3);
    const derived = gate();
    mockDerive.mockImplementationOnce(async source => {
      await derived.opened;
      return derivedFor(source, Date.now());
    });
    const refreshing = _refreshBridgeConfigForTest();
    await flush();
    seed(4, { derivedAt: NOW + 1 });
    fireChange(DERIVED);
    await flush();
    derived.release();
    await expect(refreshing).resolves.toMatchObject({ config: config(4), derived: derivedFor(config(4), NOW + 1) });
    await flush();
    expect(mockStorage.get(DERIVED)).toEqual(derivedFor(config(4), NOW + 1));
  });
});

describe('a re-derivation that cannot read a value', () => {
  const ETH_FAUCET = '0x0a0b0c0d0e0f101112131415161700';
  const ETH: BridgeToken = {
    midenFaucetId: ETH_FAUCET,
    originToken: `0x${'0'.repeat(40)}`,
    originNetwork: 0,
    scale: 10
  };
  const USDC = { symbol: 'USDC', decimals: 18 };
  const SWAP_PAIRS: SwapPairs = {
    tokens: [
      { faucetId: '0xe33498f1176661512b5ac4ded86ec7', ticker: 'IETH', decimals: 8, binanceAsset: 'ETH' },
      { faucetId: '0x094698fc4bc531d136db0866f38902', ticker: 'IUSDT', decimals: 8 }
    ],
    pairs: [{ faucetIds: ['0xe33498f1176661512b5ac4ded86ec7', '0x094698fc4bc531d136db0866f38902'] }]
  };
  const down = { state: 'error', message: 'timeout' } as const;
  const read = (source: BridgeConfig): DerivedBridgeConfig => {
    const base = derivedFor(source, Date.now());
    const agglayer: DerivedChainConfig['agglayer'] = {
      ...SEPOLIA_SKIPPED.agglayer,
      tokens: { state: 'ok', value: [ETH] },
      l1BridgeCode: { state: 'ok', value: true }
    };
    return {
      ...base,
      chains: { 11155111: { agglayer, epoch: { tokens: { USDC: { state: 'ok', value: USDC } } } } },
      epoch: { ...base.epoch, vaults: { state: 'ok', value: [TEST_EARN_VAULT_INFO] } },
      swap: { pairs: { state: 'ok', value: SWAP_PAIRS } }
    };
  };
  const unread = (source: BridgeConfig): DerivedBridgeConfig => {
    const base = derivedFor(source, Date.now());
    const agglayer: DerivedChainConfig['agglayer'] = {
      ...SEPOLIA_SKIPPED.agglayer,
      tokens: down,
      l1BridgeCode: { state: 'absent' }
    };
    return {
      ...base,
      chains: { 11155111: { agglayer, epoch: { tokens: { USDC: down } } } },
      epoch: { ...base.epoch, allocator: down, vaults: down },
      swap: { pairs: down }
    };
  };
  // The Sepolia reads with the shared allocator probe, as one flat object.
  const sepoliaReads = (derived: DerivedBridgeConfig | null) => ({
    ...derived?.chains[11155111]?.agglayer,
    epochUsdc: derived?.chains[11155111]?.epoch.tokens.USDC,
    allocator: derived?.epoch.allocator
  });

  it('keeps value probes a failed re-derivation could not read', async () => {
    serve(1);
    mockDerive.mockImplementationOnce(async source => read(source));
    await initBridgeConfig();
    await flush();
    mockDerive.mockImplementationOnce(async source => unread(source));
    await _refreshBridgeConfigForTest();
    await flush();
    expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBe(ETH_FAUCET);
    const kept = {
      tokens: { state: 'ok', value: [ETH] },
      epochUsdc: { state: 'ok', value: USDC },
      allocator: down,
      l1BridgeCode: { state: 'absent' }
    };
    const { derived } = getBridgeConfigSnapshot();
    expect(sepoliaReads(derived)).toMatchObject(kept);
    // A solver that is down for one check does not empty the swap registry.
    expect(selectSwapPairs(getBridgeConfigSnapshot())).toEqual(SWAP_PAIRS);
    // Nor does a positions host that is down for one check empty the Earn vault catalogue.
    expect(selectEarnVaultCatalog(getBridgeConfigSnapshot())).toEqual([TEST_EARN_VAULT_INFO]);
    const stored = mockStorage.get(DERIVED);
    expect(stored).toEqual(derived);
    serve(2);
    mockDerive.mockImplementationOnce(async source => unread(source));
    await _refreshBridgeConfigForTest();
    expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBeNull();
    expect(selectSwapPairs(getBridgeConfigSnapshot())).toBeNull();
    expect(selectEarnVaultCatalog(getBridgeConfigSnapshot())).toBeNull();
    expect(getBridgeConfigSnapshot().derived?.chains[11155111]?.epoch.tokens.USDC).toEqual(down);
  });

  it('keeps them through a fresher same-version commit from another realm, and not across a version', async () => {
    serve(1);
    mockDerive.mockImplementationOnce(async source => read(source));
    await initBridgeConfig();
    await flush();
    mockStorage.set(DERIVED, { ...unread(config(1)), derivedAt: NOW + 5 });
    fireChange(DERIVED);
    await flush();
    expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBe(ETH_FAUCET);
    const { derived } = getBridgeConfigSnapshot();
    expect(derived?.derivedAt).toBe(NOW + 5);
    expect(sepoliaReads(derived)).toMatchObject({
      tokens: { state: 'ok', value: [ETH] },
      epochUsdc: { state: 'ok', value: USDC },
      allocator: down,
      l1BridgeCode: { state: 'absent' }
    });
    storeEntry('testnet', 2, NOW + 10);
    mockStorage.set(DERIVED, { ...unread(config(2)), derivedAt: NOW + 10 });
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot().config).toEqual(config(2));
    expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBeNull();
  });

  const SOLVER = 'https://quotes.example';
  // A fetch of `version` that names the solver at `etaUrl`.
  const serveNaming = (version: number, etaUrl: string) =>
    mockFetch.mockImplementation(async network => {
      const entry = { config: { ...config(version, network), swap: { etaUrl } }, fetchedAt: Date.now() };
      mockStorage.set(`bridge_config_v1:${network}`, entry);
      return entry;
    });

  it.each([
    ['keeps', 'the same solver', SOLVER, SWAP_PAIRS],
    ['does not keep', 'another solver', 'https://quotes.other.example', null]
  ])(
    "%s the solver's pairs across a version that names %s when its read fails",
    async (_keeps, _label, etaUrl, pairs) => {
      serveNaming(1, SOLVER);
      mockDerive.mockImplementationOnce(async source => read(source));
      await initBridgeConfig();
      await flush();
      serveNaming(2, etaUrl);
      mockDerive.mockImplementationOnce(async source => unread(source));
      await _refreshBridgeConfigForTest();
      expect(getBridgeConfigSnapshot().config?.version).toBe(2);
      expect(selectSwapPairs(getBridgeConfigSnapshot())).toEqual(pairs);
      // Every other value is the new version's own read.
      expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBeNull();
      expect(getBridgeConfigSnapshot().derived?.chains[11155111]?.epoch.tokens.USDC).toEqual(down);
    }
  );

  it('keeps them across a version another realm commits, when it names the same solver', async () => {
    serveNaming(1, SOLVER);
    mockDerive.mockImplementationOnce(async source => read(source));
    await initBridgeConfig();
    await flush();
    const next = { ...config(2), swap: { etaUrl: SOLVER } };
    mockStorage.set(CACHE, { config: next, fetchedAt: NOW + 10 });
    mockStorage.set(DERIVED, { ...unread(next), derivedAt: NOW + 10 });
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot().config).toEqual(next);
    expect(selectSwapPairs(getBridgeConfigSnapshot())).toEqual(SWAP_PAIRS);
    expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBeNull();
  });

  it('keeps values another realm stored for this version, though this realm never read them', async () => {
    seed(1);
    await initBridgeConfig();
    mockStorage.set(DERIVED, { ...read(config(1)), derivedAt: NOW - 1 });
    serve(1);
    mockDerive.mockImplementationOnce(async source => unread(source));
    await _refreshBridgeConfigForTest();
    await flush();
    expect(selectNativeEthFaucet(getBridgeConfigSnapshot())).toBe(ETH_FAUCET);
    const { derived } = getBridgeConfigSnapshot();
    expect(derived?.chains[11155111]?.agglayer.tokens).toEqual({ state: 'ok', value: [ETH] });
    expect(derived?.epoch.allocator).toEqual(down);
    // The catalogue the other realm stored reads back whole.
    expect(derived?.epoch.vaults).toEqual({ state: 'ok', value: [TEST_EARN_VAULT_INFO] });
    expect(mockStorage.get(DERIVED)).toEqual(derived);
  });

  it('keeps the last scaled read of a faucet the same document reads again with no scale', async () => {
    const FAUCET = '0x537c15a622074e91188aa894456c52';
    const OTHER_FAUCET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const scaled: EpochTokenRead = {
      symbol: 'USDC',
      decimals: 18,
      midenFaucetId: FAUCET,
      midenSymbol: 'USDC',
      midenDecimals: 6
    };
    const unscaled = (midenFaucetId: string): EpochTokenRead => ({ symbol: 'USDC', decimals: 18, midenFaucetId });
    const epochDocument = (version: number, network = 'testnet'): BridgeConfig => {
      const source = config(version, network);
      const sepolia = source.supportedEvmChains.sepolia;
      if (!sepolia) throw new Error('missing sepolia');
      return {
        ...source,
        supportedEvmChains: {
          ...source.supportedEvmChains,
          sepolia: {
            ...sepolia,
            bridges: {
              ...sepolia.bridges,
              epoch: {
                depositEnabled: true,
                withdrawalEnabled: true,
                tokens: {
                  USDC: { contractAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69', outputs: [] }
                }
              }
            }
          }
        }
      };
    };
    const epochRead = (source: BridgeConfig, value: EpochTokenRead): DerivedBridgeConfig => {
      const base = derivedFor(source, Date.now());
      return {
        ...base,
        chains: {
          11155111: { ...SEPOLIA_SKIPPED, epoch: { tokens: { USDC: { state: 'ok', value } } } }
        }
      };
    };
    const serveEpoch = (version: number) =>
      mockFetch.mockImplementation(async network => {
        const entry = { config: epochDocument(version, network), fetchedAt: Date.now() };
        mockStorage.set(`bridge_config_v1:${network}`, entry);
        return entry;
      });

    serveEpoch(1);
    mockDerive.mockImplementationOnce(async source => epochRead(source, scaled));
    await initBridgeConfig();
    await flush();
    expect(selectEpochDepositTokens(getBridgeConfigSnapshot(), 11155111)).toEqual([
      expect.objectContaining({ key: 'USDC', midenFaucetId: FAUCET, midenSymbol: 'USDC', midenDecimals: 6 })
    ]);

    serveEpoch(1);
    mockDerive.mockImplementationOnce(async source => epochRead(source, unscaled(FAUCET)));
    await _refreshBridgeConfigForTest();
    await flush();
    expect(selectEpochDepositTokens(getBridgeConfigSnapshot(), 11155111)).toEqual([
      expect.objectContaining({ key: 'USDC', midenDecimals: 6 })
    ]);

    serveEpoch(1);
    mockDerive.mockImplementationOnce(async source => epochRead(source, unscaled(OTHER_FAUCET)));
    await _refreshBridgeConfigForTest();
    await flush();
    expect(selectEpochDepositTokens(getBridgeConfigSnapshot(), 11155111)).toEqual([]);
    const replaced = getBridgeConfigSnapshot().derived;
    expect(replaced?.chains[11155111]?.epoch.tokens.USDC).toEqual({ state: 'ok', value: unscaled(OTHER_FAUCET) });
    expect(mockStorage.get(DERIVED)).toEqual(replaced);

    serveEpoch(2);
    mockDerive.mockImplementationOnce(async source => epochRead(source, unscaled(FAUCET)));
    await _refreshBridgeConfigForTest();
    await flush();
    expect(selectEpochDepositTokens(getBridgeConfigSnapshot(), 11155111)).toEqual([]);
    expect(getBridgeConfigSnapshot().derived?.chains[11155111]?.epoch.tokens.USDC).toEqual({
      state: 'ok',
      value: unscaled(FAUCET)
    });
  });
});

// A reset keeps every network's stored document and its derivation, so what this realm holds stays valid.
describe('a wipe in this realm', () => {
  it('keeps the copy in memory and fetches nothing', async () => {
    seed(1);
    await initBridgeConfig();
    await flush();
    const before = getBridgeConfigSnapshot();
    await rereadAfterWipe();
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lands a refresh that was out across it', async () => {
    const first = gate();
    mockFetch.mockImplementationOnce(async network => {
      await first.opened;
      return storeEntry(network, 1);
    });
    void initBridgeConfig();
    await flush();
    await rereadAfterWipe();
    first.release();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'ready', config: config(1) });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('the poll schedule', () => {
  it('re-checks a healthy wallet every hour', async () => {
    seed(1);
    serve(1);
    await initBridgeConfig();
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 1);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('on open, refreshes a healthy copy 15 minutes old at once', async () => {
    seed(1, { fetchedAt: NOW - FOREGROUND_STALE_MS });
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('on open, leaves a healthy copy younger than 15 minutes', async () => {
    seed(1, { fetchedAt: NOW - FOREGROUND_STALE_MS + 1 });
    await initBridgeConfig();
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['not-deployed', 'service-down'] as const)(
    're-checks every 5 minutes while a feature is %s',
    async reason => {
      mockAvailability = { bridgeIn: unavailable(reason) };
      seed(1);
      serve(1);
      await initBridgeConfig();
      await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS - 1);
      expect(mockFetch).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  );

  it("re-checks every 5 minutes while the read of the solver's swap pairs has failed", async () => {
    seed(1);
    mockStorage.set(DERIVED, {
      ...derivedFor(config(1), NOW),
      swap: { pairs: { state: 'error', message: 'HTTP 503' } }
    });
    serve(1);
    await initBridgeConfig();
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS - 1);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['has failed', { state: 'error', message: 'HTTP 503' }],
    ['was stored in a form that does not read back', { state: 'ok', value: [{ marketUid: 'damaged' }] }]
  ])('re-checks every 5 minutes while the read of the Earn vault catalogue %s', async (_label, vaults) => {
    seed(1);
    const stored = derivedFor(config(1), NOW);
    mockStorage.set(DERIVED, { ...stored, epoch: { ...stored.epoch, vaults } });
    serve(1);
    await initBridgeConfig();
    expect(getBridgeConfigSnapshot().derived?.epoch.vaults.state).toBe('error');
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS - 1);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-arms for the network it returns to, on that network's own degraded cadence", async () => {
    mockFeatureAvailability.mockImplementation((_feature, snapshot) =>
      (snapshot as BridgeConfigSnapshot).network === 'testnet' ? unavailable('service-down') : AVAILABLE
    );
    try {
      seed(1);
      seed(5, { network: 'devnet' });
      serve(1);
      await initBridgeConfig();
      mockNetwork = 'devnet';
      followEffectiveNetwork();
      await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
      expect(mockFetch).not.toHaveBeenCalled();
      mockNetwork = 'testnet';
      followEffectiveNetwork();
      await flush();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith('testnet');
    } finally {
      mockFeatureAvailability.mockImplementation(
        (feature: string): FeatureAvailability => mockAvailability[feature] ?? AVAILABLE
      );
    }
  });

  it.each(['off', 'not-configured', 'pending'] as const)(
    'keeps the hourly cadence while a feature is only %s and no control holds it',
    async reason => {
      mockAvailability = { earnDeposit: unavailable(reason), bridgeOut: unavailable(reason) };
      seed(1);
      serve(1);
      await initBridgeConfig();
      await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 1);
      expect(mockFetch).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['off', 'not-configured'] as const)(
    're-checks every 60 s while a control greyed for %s is held, and hourly once released',
    async reason => {
      mockAvailability = { earnDeposit: unavailable(reason) };
      seed(1);
      serve(1);
      await initBridgeConfig();
      const release = holdFastPoll();
      await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS - 1);
      expect(mockFetch).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      release();
      await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps the hourly cadence while a held control waits only for the startup decision', async () => {
    mockAvailability = { earnDeposit: unavailable('pending') };
    seed(1);
    serve(1);
    await initBridgeConfig();
    holdFastPoll();
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 1);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the hourly cadence after a failed startup lookup', async () => {
    mockAvailability = { earnDeposit: unavailable('service-down') };
    seed(1);
    serve(1);
    mockLookup.mockResolvedValueOnce(null);
    await initFeatureEligibility();
    // The version retry's refresh is the only fetch; no document can clear the failed decision.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    holdFastPoll();
    await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the hourly cadence while a held control is only geo-restricted', async () => {
    mockAvailability = { earnDeposit: unavailable('restricted') };
    seed(1);
    serve(1);
    await initFeatureEligibility();
    holdFastPoll();
    await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still re-checks every 5 minutes for a document outage while the startup lookup is failed', async () => {
    mockAvailability = { earnDeposit: unavailable('service-down'), fastBridgeOut: unavailable('service-down') };
    seed(1);
    serve(1);
    mockLookup.mockResolvedValueOnce(null);
    await initFeatureEligibility();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('still re-checks every 5 minutes when Earn itself is down and the startup decision allows it', async () => {
    mockLookup.mockImplementation(async (network, version) => ({
      network,
      version,
      allowed: { wallet: true, earn: true, swap: true }
    }));
    mockAvailability = { earnDeposit: unavailable('service-down') };
    seed(1);
    serve(1);
    await initFeatureEligibility();
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('re-checks every 60 s while a greyed-out control holds it, and every 5 minutes once released', async () => {
    mockAvailability = { fastBridgeOut: unavailable('service-down') };
    seed(1);
    serve(1);
    await initBridgeConfig();
    const release = holdFastPoll();
    await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    release();
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('counts a released hold once, however often it is released', async () => {
    mockAvailability = { fastBridgeOut: unavailable('service-down') };
    seed(1);
    serve(1);
    await initBridgeConfig();
    const first = holdFastPoll();
    holdFastPoll();
    first();
    first();
    await jest.advanceTimersByTimeAsync(DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes at once when a hold lands after the fast interval has passed', async () => {
    mockAvailability = { bridgeIn: unavailable('service-down') };
    seed(1);
    serve(1);
    await initBridgeConfig();
    await jest.advanceTimersByTimeAsync(3 * DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    holdFastPoll();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a hold while every feature is available', async () => {
    seed(1);
    serve(1);
    await initBridgeConfig();
    holdFastPoll();
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('backs off failed fetches from 60 s, doubling to a 15-minute cap, and a success resets it', async () => {
    seed(1);
    await initBridgeConfig();
    failFetch();
    await _refreshBridgeConfigForTest();
    let calls = 1;
    for (const delay of [60_000, 120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(mockFetch).toHaveBeenCalledTimes(calls);
      await jest.advanceTimersByTimeAsync(1);
      calls += 1;
      expect(mockFetch).toHaveBeenCalledTimes(calls);
    }
    serve(1);
    await jest.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(mockFetch).toHaveBeenCalledTimes(calls + 1);
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(calls + 1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(calls + 2);
  });

  it('stops while hidden and, back in the foreground, refreshes a copy older than 15 minutes', async () => {
    seed(1);
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(jest.getTimerCount()).toBe(1);
    setVisibility('hidden');
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(2 * HEALTHY_POLL_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    setVisibility('visible');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('back in the foreground within 15 minutes, keeps the hourly timer from the last check', async () => {
    seed(1);
    serve(1);
    await initBridgeConfig();
    await flush();
    setVisibility('hidden');
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    setVisibility('visible');
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 10 * 60_000 - 1);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('in a document that is never shown, refreshes only on load and never sets a timer', async () => {
    visibility = 'hidden';
    seed(1, { fetchedAt: NOW - HEALTHY_POLL_MS });
    serve(1);
    await initBridgeConfig();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(3 * HEALTHY_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('installs one foreground listener per realm', async () => {
    const addListener = jest.spyOn(document, 'addEventListener');
    seed(1);
    await Promise.all([initBridgeConfig(), initBridgeConfig()]);
    await initBridgeConfig();
    expect(addListener.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
    addListener.mockRestore();
  });

  it('picks up a network switch on its next tick', async () => {
    seed(1);
    serve(5);
    await initBridgeConfig();
    await flush();
    mockNetwork = 'devnet';
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS - 1);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledWith('devnet');
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
  });

  it('reads a newly current network as soon as anything re-arms the timer', async () => {
    seed(1);
    seed(5, { network: 'devnet' });
    await initBridgeConfig();
    await flush();
    mockNetwork = 'devnet';
    holdFastPoll();
    await flush();
    expect(mockReadStored).toHaveBeenCalledWith('devnet');
    expect(getBridgeConfigSnapshot()).toMatchObject({
      network: 'devnet',
      status: 'ready',
      config: config(5, 'devnet')
    });
  });

  it('judges health with the E2E overrides applied', async () => {
    seed(1);
    await initBridgeConfig();
    await flush();
    expect(mockFeatureAvailability).toHaveBeenCalledWith('earnDeposit', getBridgeConfigSnapshot(), mockOverrides);
  });
});

describe('the Guardian operators', () => {
  const KODA = { id: 'kodax', name: 'Koda', operatedBy: 'Koda', location: 'Asia', endpoint: 'https://koda.example' };
  const NEW = { id: 'new-one', name: 'New', operatedBy: 'New Co', location: 'EU', endpoint: 'https://new.example' };
  const BUNDLED_TESTNET = ['open-zeppelin', 'gateway', 'lambda-class', 'kodax', 'para'];
  // A stored document of `version` that lists `guardians`, with its derivation, as a fetch leaves them.
  const seedGuardians = (version: number, guardians: GuardianConfig[] | undefined, network = 'testnet') => {
    const document = { ...config(version, network), ...(guardians === undefined ? {} : { guardians }) };
    mockStorage.set(`bridge_config_v1:${network}`, { config: document, fetchedAt: NOW });
    mockStorage.set(`bridge_config_derived_v2:${network}`, derivedFor(document, NOW));
  };
  const ids = (network = 'testnet') => getNetworkGuardians(network).map(option => option.id);

  beforeEach(() => _resetGuardianRegistryForTest());
  afterAll(() => _resetGuardianRegistryForTest());

  it('are the bundled list until a document is read', () => {
    expect(ids()).toEqual(BUNDLED_TESTNET);
  });

  it('become the stored document list once the realm hydrates, with no fetch', async () => {
    seedGuardians(3, [KODA, NEW]);
    await initBridgeConfig();
    expect(getNetworkGuardians('testnet')).toEqual([KODA, NEW]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stay the bundled list under a document that has no guardians section', async () => {
    seedGuardians(3, undefined);
    await initBridgeConfig();
    expect(ids()).toEqual(BUNDLED_TESTNET);
  });

  it('follow a newer document that a fetch brings', async () => {
    seedGuardians(3, [KODA]);
    await initBridgeConfig();
    mockFetch.mockImplementation(async network => {
      seedGuardians(4, [NEW, KODA], network);
      return { config: { ...config(4, network), guardians: [NEW, KODA] }, fetchedAt: Date.now() };
    });
    await _refreshBridgeConfigForTest();
    expect(ids()).toEqual(['new-one', 'kodax']);
  });

  it('go back to the bundled list when a newer document drops the section', async () => {
    seedGuardians(3, [NEW]);
    await initBridgeConfig();
    mockFetch.mockImplementation(async network => storeEntry(network, 4));
    await _refreshBridgeConfigForTest();
    expect(ids()).toEqual(BUNDLED_TESTNET);
  });

  it('keep the document list when a fetch fails', async () => {
    seedGuardians(3, [NEW]);
    await initBridgeConfig();
    failFetch();
    await _refreshBridgeConfigForTest();
    expect(ids()).toEqual(['new-one']);
  });

  it('follow a newer document another realm committed', async () => {
    seedGuardians(3, [KODA]);
    await initBridgeConfig();
    seedGuardians(4, [NEW]);
    fireChange(CACHE);
    await flush();
    expect(ids()).toEqual(['new-one']);
  });

  it('keep the document list across a wipe, which keeps the document', async () => {
    seedGuardians(3, [NEW]);
    await initBridgeConfig();
    await rereadAfterWipe();
    await flush();
    expect(getBridgeConfigSnapshot().config?.guardians).toEqual([NEW]);
    expect(ids()).toEqual(['new-one']);
  });

  it('give each network its own document list', async () => {
    seedGuardians(3, [NEW]);
    seedGuardians(5, [KODA], 'devnet');
    await initBridgeConfig();
    expect(ids('devnet')).toEqual(['open-zeppelin']);
    mockNetwork = 'devnet';
    await initBridgeConfig();
    expect(ids('devnet')).toEqual(['kodax']);
    expect(ids('testnet')).toEqual(['new-one']);
  });
});

describe('startup eligibility', () => {
  it('does not check eligibility during ordinary config initialization or refresh', async () => {
    seed(13);
    serve(14);
    await initBridgeConfig();
    await _refreshBridgeConfigForTest();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(getBridgeConfigSnapshot().geo).toBeUndefined();
  });

  it('coalesces simultaneous startup calls into one request against the accepted startup document', async () => {
    seed(13);
    const pending = gate();
    mockLookup.mockImplementationOnce(async (network, version) => {
      await pending.opened;
      return { network, version, allowed: { wallet: true, earn: false, swap: true } };
    });
    const first = initFeatureEligibility();
    const second = initFeatureEligibility();
    expect(second).toBe(first);
    await flush();
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith(
      'testnet',
      13,
      expect.objectContaining({ onFailure: expect.any(Function) })
    );
    expect(getBridgeConfigSnapshot().geo).toEqual({ state: 'loading' });
    pending.release();
    const result = await first;
    expect(result).toEqual({
      state: 'ready',
      network: 'testnet',
      version: 13,
      allowed: { wallet: true, earn: false, swap: true }
    });
    expect(getBridgeConfigSnapshot().geo).toBe(result);
  });

  it.each([
    { wallet: true, earn: false, swap: true },
    { wallet: false, earn: true, swap: false }
  ])('retains the independent startup feature decisions $wallet/$earn/$swap', async allowed => {
    seed(13);
    mockLookup.mockResolvedValueOnce({ network: 'testnet', version: 13, allowed });
    const result = await initFeatureEligibility();
    expect(result).toEqual({ state: 'ready', network: 'testnet', version: 13, allowed });
    expect(await initFeatureEligibility()).toBe(result);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it('retries startup eligibility when refresh replaces the document after a version mismatch', async () => {
    seed(13);
    serve(14);
    mockLookup.mockResolvedValueOnce(null).mockImplementationOnce(async (network, version) => ({
      network,
      version,
      allowed: { wallet: true, earn: true, swap: true }
    }));

    const result = await initFeatureEligibility();

    expect(result).toEqual({
      state: 'ready',
      network: 'testnet',
      version: 14,
      allowed: { wallet: true, earn: true, swap: true }
    });
    expect(mockLookup).toHaveBeenNthCalledWith(
      1,
      'testnet',
      13,
      expect.objectContaining({ onFailure: expect.any(Function) })
    );
    expect(mockLookup).toHaveBeenNthCalledWith(
      2,
      'testnet',
      14,
      expect.objectContaining({ onFailure: expect.any(Function) })
    );
    expect(getBridgeConfigSnapshot().config?.version).toBe(14);
  });

  it('never rechecks after time, foreground, document changes, storage clearing or recovery initialization', async () => {
    seed(13);
    serve(14);
    const result = await initFeatureEligibility();
    const first = getBridgeConfigSnapshot();
    await _refreshBridgeConfigForTest();
    expect(getBridgeConfigSnapshot().config?.version).toBe(14);
    expect(getBridgeConfigSnapshot().geo).toBe(result);
    expect(getBridgeConfigSnapshot()).not.toBe(first);
    await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS * 2);
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    mockStorage.clear();
    fireChange(CACHE);
    fireChange(DERIVED);
    await flush();
    await rereadAfterWipe();
    await initBridgeConfig();
    expect(await initFeatureEligibility()).toBe(result);
    expect(getBridgeConfigSnapshot().geo).toBe(result);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the startup decision when the page later changes its effective network', async () => {
    seed(13);
    seed(4, { network: 'devnet' });
    const result = await initFeatureEligibility();
    mockNetwork = 'devnet';
    followEffectiveNetwork();
    await initBridgeConfig();
    await flush();
    expect(getBridgeConfigSnapshot().network).toBe('devnet');
    expect(getBridgeConfigSnapshot().geo).toBe(result);
    expect(await initFeatureEligibility()).toBe(result);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it('keeps an unavailable startup result without retrying when later initialization recovers', async () => {
    seed(13);
    mockLookup.mockResolvedValueOnce(null);
    const result = await initFeatureEligibility();
    await initBridgeConfig();
    expect(result).toMatchObject({ state: 'failed' });
    expect(await initFeatureEligibility()).toBe(result);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it('fails closed when startup has no accepted document without sending an unversioned lookup', async () => {
    failFetch();
    const result = await initFeatureEligibility();
    expect(result).toMatchObject({ state: 'failed' });
    expect(mockLookup).not.toHaveBeenCalled();
    serve(13);
    await _refreshBridgeConfigForTest();
    expect(await initFeatureEligibility()).toBe(result);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('settles a rejected startup lookup as unavailable once', async () => {
    seed(13);
    mockLookup.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await initFeatureEligibility()).toMatchObject({ state: 'failed' });
    expect(await initFeatureEligibility()).toMatchObject({ state: 'failed' });
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
  it('binds an unavailable-config failure to the startup attempt without guessing a parse cause', async () => {
    failFetch();
    expect(await initFeatureEligibility()).toEqual({
      state: 'failed',
      diagnostics: {
        startupEligibilityStage: 'config_initialization',
        startupEligibilityReason: 'config_unavailable',
        startupEligibilityRetry: 'not_attempted'
      }
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('records the second lookup failure against the refreshed startup attempt and never retries again', async () => {
    seed(13);
    serve(14);
    mockLookup
      .mockImplementationOnce(async (_network, _version, options) => {
        options?.onFailure?.('version_mismatch');
        return null;
      })
      .mockImplementationOnce(async (_network, _version, options) => {
        options?.onFailure?.('request_failed', 'timeout');
        return null;
      });
    const result = await initFeatureEligibility();
    expect(result).toEqual({
      state: 'failed',
      diagnostics: {
        startupEligibilityStage: 'eligibility_retry',
        startupEligibilityReason: 'request_failed',
        startupEligibilityRetry: 'retry_failed',
        startupEligibilityRequestFailure: 'timeout'
      }
    });
    expect(await initFeatureEligibility()).toBe(result);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed refresh distinct from the initial eligibility response and does not borrow a later failure', async () => {
    seed(13);
    failFetch();
    let observed: ((reason: string, requestFailure?: string) => void) | undefined;
    mockLookup.mockImplementationOnce(async (_network, _version, options) => {
      observed = options?.onFailure;
      observed?.('version_mismatch');
      return null;
    });
    const result = await initFeatureEligibility();
    expect(result).toEqual({
      state: 'failed',
      diagnostics: {
        startupEligibilityStage: 'config_refresh',
        startupEligibilityReason: 'config_unavailable',
        startupEligibilityRetry: 'refresh_failed'
      }
    });
    observed?.('endpoint_missing');
    expect(result).toMatchObject({ diagnostics: { startupEligibilityReason: 'config_unavailable' } });
  });

  it('preserves the original reason when a successful refresh does not advance the config', async () => {
    seed(13);
    serve(13);
    mockLookup.mockImplementationOnce(async (_network, _version, options) => {
      options?.onFailure?.('version_mismatch');
      return null;
    });
    expect(await initFeatureEligibility()).toEqual({
      state: 'failed',
      diagnostics: {
        startupEligibilityStage: 'eligibility_lookup',
        startupEligibilityReason: 'version_mismatch',
        startupEligibilityRetry: 'config_not_advanced'
      }
    });
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
  it('names a rejected configuration initialization without forwarding its error', async () => {
    mockReadStored.mockRejectedValueOnce(new Error('private state failed'));
    expect(await initFeatureEligibility()).toEqual({
      state: 'failed',
      diagnostics: {
        startupEligibilityStage: 'config_initialization',
        startupEligibilityReason: 'config_initialization_failed',
        startupEligibilityRetry: 'not_attempted'
      }
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
