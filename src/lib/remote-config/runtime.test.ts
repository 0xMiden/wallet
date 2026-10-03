import type { FeatureAvailability, UnavailableReason } from './availability';
import type { DerivedBridgeConfig } from './derive';
import { failedDerivation } from './derived-snapshot';
import {
  _resetBridgeConfigRuntimeForTest,
  type BridgeConfigSnapshot,
  DEGRADED_POLL_MS,
  DEGRADED_VISIBLE_POLL_MS,
  FOREGROUND_STALE_MS,
  getBridgeConfigSnapshot,
  HEALTHY_POLL_MS,
  holdFastPoll,
  loadBridgeConfig,
  MAX_BACKOFF_MS,
  _refreshBridgeConfigForTest,
  subscribeBridgeConfig
} from './runtime';
import type { BridgeConfig } from './schema';
import type { StoredBridgeConfig } from './source';

let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));

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
jest.mock('./derive', () => ({ deriveBridgeConfig: (config: BridgeConfig) => mockDerive(config) }));

const AVAILABLE: FeatureAvailability = { state: 'available' };
let mockAvailability: Partial<Record<string, FeatureAvailability>> = {};
const mockFeatureAvailability = jest.fn(
  (feature: string, _snapshot: unknown, _overrides: unknown): FeatureAvailability =>
    mockAvailability[feature] ?? AVAILABLE
);
jest.mock('./availability', () => ({
  BRIDGE_FEATURES: ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn', 'bridgeIn', 'bridgeOut'],
  featureAvailability: (feature: string, snapshot: unknown, overrides: unknown) =>
    mockFeatureAvailability(feature, snapshot, overrides)
}));

const mockOverrides = { earnCollateralFaucet: null };
jest.mock('./e2e-overrides', () => ({ getE2eOverrides: () => mockOverrides }));

const NOW = 1_800_000_000_000;
const CACHE = 'bridge_config_v1:testnet';
const DERIVED = 'bridge_config_derived_v1:testnet';

const config = (version: number, network = 'testnet'): BridgeConfig => ({
  network,
  version,
  evm: { chainId: 11155111 },
  agglayer: {},
  epoch: { allocatorUrl: 'https://allocator.example' },
  features: { earn: true, fastBridge: true, bridgeIn: false, bridgeOut: false }
});
const derivedFor = (source: BridgeConfig, derivedAt: number): DerivedBridgeConfig => ({
  network: source.network,
  version: source.version,
  derivedAt,
  agglayer: {
    rollupId: { state: 'skipped' },
    tokens: { state: 'skipped' },
    evmNetworkId: { state: 'skipped' },
    l1BridgeCode: { state: 'skipped' },
    indexer: { state: 'skipped' }
  },
  epoch: {
    allocator: { state: 'ok', value: true },
    midenUsdcFaucet: { state: 'skipped' },
    evmUsdc: { state: 'skipped' }
  }
});
// What the source stores on a fetch, or another realm leaves behind.
const storeEntry = (network: string, version: number, fetchedAt = Date.now()): StoredBridgeConfig => {
  const entry = { config: config(version, network), fetchedAt };
  mockStorage.set(`bridge_config_v1:${network}`, entry);
  return entry;
};
const seed = (version: number, { fetchedAt = NOW, derivedAt = fetchedAt, network = 'testnet' } = {}) => {
  const entry = storeEntry(network, version, fetchedAt);
  mockStorage.set(`bridge_config_derived_v1:${network}`, derivedFor(entry.config, derivedAt));
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
  mockAvailability = {};
  visibility = 'visible';
  mockGet.mockReset().mockImplementation(async key => mockStorage.get(key) ?? null);
  mockPut.mockReset().mockImplementation(async (key, value) => {
    mockStorage.set(key, value);
  });
  mockReadStored.mockReset().mockImplementation(async network => readEntry(network));
  mockFetch.mockReset().mockRejectedValue(new Error('unexpected fetch'));
  mockDerive.mockReset().mockImplementation(async source => derivedFor(source, Date.now()));
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

  it('serves the stored document with its derivation, ready, without fetching a fresh copy', async () => {
    seed(3, { fetchedAt: NOW - 60_000 });
    const snapshot = await loadBridgeConfig();
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
    expect(await loadBridgeConfig()).toMatchObject({ status: 'loading', config: config(3), derived: null });
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
    await loadBridgeConfig();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('derived snapshot'), expect.any(Error));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('with nothing stored, waits for the first fetch and resolves with the document and its derivation', async () => {
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 1);
    });
    let settled = false;
    const loading = loadBridgeConfig().then(snapshot => {
      settled = true;
      return snapshot;
    });
    await flush();
    expect(settled).toBe(false);
    expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'loading', config: null });
    fetched.release();
    await expect(loading).resolves.toEqual({
      network: 'testnet',
      status: 'ready',
      config: config(1),
      derived: derivedFor(config(1), NOW),
      lastFetch: { at: NOW, ok: true }
    });
    await flush();
    expect(mockStorage.get(DERIVED)).toEqual(derivedFor(config(1), NOW));
  });

  it('with a stored document, resolves from storage without waiting for the refresh it starts', async () => {
    seed(1, { fetchedAt: NOW - HEALTHY_POLL_MS });
    mockFetch.mockImplementation(() => new Promise<StoredBridgeConfig>(() => undefined));
    let resolved: BridgeConfigSnapshot | undefined;
    void loadBridgeConfig().then(snapshot => {
      resolved = snapshot;
    });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({ status: 'ready', config: config(1) });
  });

  it('keeps the last accepted document when a fetch fails, records why, and still re-runs the checks', async () => {
    seed(2, { fetchedAt: NOW - HEALTHY_POLL_MS });
    failFetch('HTTP 503');
    await loadBridgeConfig();
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

  it('with nothing stored and a failed first fetch, resolves ready with no document instead of throwing', async () => {
    failFetch();
    await expect(loadBridgeConfig()).resolves.toEqual({
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
    await loadBridgeConfig();
    await expect(_refreshBridgeConfigForTest()).resolves.toMatchObject({
      config: config(2),
      derived: derivedFor(config(2), NOW),
      lastFetch: { at: NOW, ok: true }
    });
  });

  it('treats a copy stamped later than the clock as stale', async () => {
    seed(1, { fetchedAt: NOW + 60_000 });
    serve(1);
    await loadBridgeConfig();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads a derivation that throws as every check failed, and keeps it out of storage', async () => {
    mockDerive.mockRejectedValue(new Error('wasm init failed'));
    serve(1);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
    mockNetwork = 'devnet';
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'devnet',
      status: 'loading',
      config: null,
      derived: null,
      lastFetch: null
    });
    await expect(loadBridgeConfig()).resolves.toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
    mockNetwork = 'testnet';
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
    const pending = loadBridgeConfig();
    mockNetwork = 'devnet';
    read.release();
    await expect(pending).resolves.toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
  });

  it('lands a first fetch that finishes after a switch on its own network, and resolves with the new one', async () => {
    const fetched = gate();
    mockFetch.mockImplementationOnce(async network => {
      await fetched.opened;
      return storeEntry(network, 2);
    });
    const first = loadBridgeConfig();
    await flush();
    mockNetwork = 'devnet';
    seed(5, { network: 'devnet' });
    await loadBridgeConfig();
    fetched.release();
    await expect(first).resolves.toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'devnet', config: config(5, 'devnet') });
    mockNetwork = 'testnet';
    expect(getBridgeConfigSnapshot()).toMatchObject({ network: 'testnet', config: config(2) });
  });
});

describe('commits from another realm', () => {
  it('adopts a newer document together with its derivation', async () => {
    seed(1);
    await loadBridgeConfig();
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
    const loading = loadBridgeConfig();
    await flush();
    seed(1);
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'ready', config: config(1) });
    fetched.release();
    await expect(loading).resolves.toMatchObject({ config: config(1) });
  });

  it('waits for the derivation before taking a newer document', async () => {
    seed(1);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
    const before = getBridgeConfigSnapshot();
    mockStorage.clear();
    fireChange(CACHE);
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
  });

  it('ignores an older document', async () => {
    seed(3);
    await loadBridgeConfig();
    const before = getBridgeConfigSnapshot();
    seed(2, { fetchedAt: NOW + 1 });
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
  });

  it('ignores a derivation of the same version that is not newer', async () => {
    seed(3);
    await loadBridgeConfig();
    const before = getBridgeConfigSnapshot();
    mockStorage.set(DERIVED, derivedFor(config(3), NOW));
    fireChange(DERIVED);
    await flush();
    expect(getBridgeConfigSnapshot()).toBe(before);
  });

  it('takes a fresher derivation of the same version, and its fetch ends the backoff here', async () => {
    seed(3);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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

describe('a wipe in this realm', () => {
  it('drops the copy in memory and reads again at once', async () => {
    seed(1);
    await loadBridgeConfig();
    mockStorage.clear();
    const refetch = gate();
    mockFetch.mockImplementationOnce(async network => {
      await refetch.opened;
      return storeEntry(network, 1);
    });
    await rereadAfterWipe();
    expect(getBridgeConfigSnapshot()).toEqual({
      network: 'testnet',
      status: 'loading',
      config: null,
      derived: null,
      lastFetch: null
    });
    refetch.release();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'ready', config: config(1) });
  });

  it('lands nothing from a refresh that was out across it', async () => {
    const first = gate();
    mockFetch.mockImplementationOnce(async network => {
      await first.opened;
      return storeEntry(network, 1);
    });
    const firstLoad = loadBridgeConfig();
    await flush();
    serve(2);
    await rereadAfterWipe();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ config: config(2) });
    first.release();
    await flush();
    expect(getBridgeConfigSnapshot()).toMatchObject({ config: config(2) });
    await expect(firstLoad).resolves.toMatchObject({ config: config(2) });
  });
});

describe('the poll schedule', () => {
  it('re-checks a healthy wallet every hour', async () => {
    seed(1);
    serve(1);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('on open, leaves a healthy copy younger than 15 minutes', async () => {
    seed(1, { fetchedAt: NOW - FOREGROUND_STALE_MS + 1 });
    await loadBridgeConfig();
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['not-deployed', 'service-down'] as const)(
    're-checks every 5 minutes while a feature is %s',
    async reason => {
      mockAvailability = { bridgeIn: unavailable(reason) };
      seed(1);
      serve(1);
      await loadBridgeConfig();
      await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS - 1);
      expect(mockFetch).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['off', 'not-configured'] as const)(
    'keeps the hourly cadence while a feature is only %s and no control holds it',
    async reason => {
      mockAvailability = { earnDeposit: unavailable(reason), bridgeOut: unavailable(reason) };
      seed(1);
      serve(1);
      await loadBridgeConfig();
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
      await loadBridgeConfig();
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

  it('re-checks every 60 s while a greyed-out control holds it, and every 5 minutes once released', async () => {
    mockAvailability = { fastBridgeOut: unavailable('service-down') };
    seed(1);
    serve(1);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
    await jest.advanceTimersByTimeAsync(3 * DEGRADED_VISIBLE_POLL_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    holdFastPoll();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a hold while every feature is available', async () => {
    seed(1);
    serve(1);
    await loadBridgeConfig();
    holdFastPoll();
    await jest.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('backs off failed fetches from 60 s, doubling to a 15-minute cap, and a success resets it', async () => {
    seed(1);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(3 * HEALTHY_POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('installs one foreground listener per realm', async () => {
    const addListener = jest.spyOn(document, 'addEventListener');
    seed(1);
    await Promise.all([loadBridgeConfig(), loadBridgeConfig()]);
    await loadBridgeConfig();
    expect(addListener.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
    addListener.mockRestore();
  });

  it('picks up a network switch on its next tick', async () => {
    seed(1);
    serve(5);
    await loadBridgeConfig();
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
    await loadBridgeConfig();
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
    await loadBridgeConfig();
    await flush();
    expect(mockFeatureAvailability).toHaveBeenCalledWith('earnDeposit', getBridgeConfigSnapshot(), mockOverrides);
  });
});
