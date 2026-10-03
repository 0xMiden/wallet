/**
 * @jest-environment node
 */

// The service worker has no document, so nothing here schedules: a load that finds its copy an hour old is the only
// way this realm fetches. A node environment has no document at all, which a jsdom global deleted at runtime
// would not reproduce.
import type { FeatureAvailability } from './availability';
import type { DerivedBridgeConfig } from './derive';
import {
  _resetBridgeConfigRuntimeForTest,
  getBridgeConfigSnapshot,
  HEALTHY_POLL_MS,
  holdFastPoll,
  initBridgeConfig
} from './runtime';
import type { BridgeConfig } from './schema';
import type { StoredBridgeConfig } from './source';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

const mockStorage = new Map<string, unknown>();
const mockRereads: Array<() => Promise<void>> = [];
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => mockStorage.get(key) ?? null,
  putToStorage: async (key: string, value: unknown) => {
    mockStorage.set(key, value);
  },
  registerStorageReread: (reread: () => Promise<void>) => mockRereads.push(reread),
  onStorageChanged: () => () => undefined
}));

const mockFetch = jest.fn<Promise<StoredBridgeConfig>, [string]>();
jest.mock('./source', () => ({
  bridgeConfigCacheKey: (network: string) => `bridge_config_v1:${network}`,
  readStoredBridgeConfig: async (network: string) => mockStorage.get(`bridge_config_v1:${network}`) ?? null,
  fetchAndStoreBridgeConfig: (network: string) => mockFetch(network)
}));

const mockDerive = jest.fn<Promise<DerivedBridgeConfig>, [BridgeConfig]>();
jest.mock('./derive', () => ({ deriveBridgeConfig: (config: BridgeConfig) => mockDerive(config) }));

let mockDegraded = false;
const mockDown: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'allocator' };
jest.mock('./availability', () => ({
  BRIDGE_FEATURES: ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn', 'bridgeIn', 'bridgeOut'],
  featureAvailability: () => (mockDegraded ? mockDown : { state: 'available' })
}));
jest.mock('./e2e-overrides', () => ({ getE2eOverrides: () => ({ earnCollateralFaucet: null }) }));

const NOW = 1_800_000_000_000;

const config = (version: number): BridgeConfig => ({
  network: 'testnet',
  version,
  evm: {},
  agglayer: {},
  epoch: {},
  features: { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false }
});
const derivedFor = (source: BridgeConfig, derivedAt: number): DerivedBridgeConfig => {
  const skipped = { state: 'skipped' } as const;
  return {
    network: source.network,
    version: source.version,
    derivedAt,
    agglayer: { rollupId: skipped, tokens: skipped, evmNetworkId: skipped, l1BridgeCode: skipped, indexer: skipped },
    epoch: { allocator: skipped, midenUsdcFaucet: skipped, evmUsdc: skipped }
  };
};
const storeEntry = (version: number, fetchedAt = Date.now()): StoredBridgeConfig => {
  const entry = { config: config(version), fetchedAt };
  mockStorage.set('bridge_config_v1:testnet', entry);
  return entry;
};
const seed = (version: number, fetchedAt = NOW) => {
  const entry = storeEntry(version, fetchedAt);
  mockStorage.set('bridge_config_derived_v1:testnet', derivedFor(entry.config, fetchedAt));
};
const flush = () => jest.advanceTimersByTimeAsync(0);

let warn: jest.SpyInstance;

beforeEach(() => {
  _resetBridgeConfigRuntimeForTest();
  jest.useFakeTimers({ now: NOW });
  mockStorage.clear();
  mockDegraded = false;
  mockFetch.mockReset().mockImplementation(async () => storeEntry(1));
  mockDerive.mockReset().mockImplementation(async source => derivedFor(source, Date.now()));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

it('never sets a timer, whatever the health or the holds', async () => {
  mockDegraded = true;
  seed(1);
  await initBridgeConfig();
  const release = holdFastPoll();
  await flush();
  expect(jest.getTimerCount()).toBe(0);
  release();
  expect(jest.getTimerCount()).toBe(0);
});

it('refreshes on load once the copy is an hour old, and not before', async () => {
  seed(1, NOW - HEALTHY_POLL_MS + 1);
  await initBridgeConfig();
  await flush();
  expect(mockFetch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await initBridgeConfig();
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it('with nothing stored, resolves at once and lands the first fetch without being awaited', async () => {
  await expect(initBridgeConfig()).resolves.toMatchObject({ status: 'loading', config: null });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await flush();
  expect(getBridgeConfigSnapshot()).toMatchObject({ status: 'ready', config: config(1) });
});

it('with nothing stored and a failed first fetch, publishes ready with no document', async () => {
  mockFetch.mockRejectedValue(new Error('HTTP 503'));
  await initBridgeConfig();
  await flush();
  expect(getBridgeConfigSnapshot()).toMatchObject({
    status: 'ready',
    config: null,
    derived: null,
    lastFetch: { ok: false }
  });
});

it('backs off a failed refresh before the next load may retry', async () => {
  mockFetch.mockRejectedValue(new Error('HTTP 503'));
  await initBridgeConfig();
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(60_000 - 1);
  await initBridgeConfig();
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await initBridgeConfig();
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('after a wipe, drops the copy and waits for the next load to fetch', async () => {
  seed(1);
  await initBridgeConfig();
  mockStorage.clear();
  await Promise.all(mockRereads.map(reread => reread()));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(getBridgeConfigSnapshot().status).toBe('loading');
  await initBridgeConfig();
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
