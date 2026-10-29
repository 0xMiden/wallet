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

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://rpc.testnet.example'
}));

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

const mockLookup = jest.fn();
jest.mock('./geo-lookup', () => ({ lookupFeatureEligibility: (...args: unknown[]) => mockLookup(...args) }));

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
  'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
  supportedEvmChains: {},
  features: { earn: false, nearIntents: false }
});
const derivedFor = (source: BridgeConfig, derivedAt: number): DerivedBridgeConfig => {
  const skipped = { state: 'skipped' } as const;
  return {
    network: source.network,
    version: source.version,
    derivedAt,
    chains: {},
    agglayer: { indexer: skipped },
    epoch: { allocator: skipped, market: skipped, midenUsdcFaucet: skipped, vaults: skipped },
    swap: { pairs: skipped }
  };
};
const storeEntry = (version: number, fetchedAt = Date.now()): StoredBridgeConfig => {
  const entry = { config: config(version), fetchedAt };
  mockStorage.set('bridge_config_v1:testnet', entry);
  return entry;
};
const seed = (version: number, fetchedAt = NOW) => {
  const entry = storeEntry(version, fetchedAt);
  mockStorage.set('bridge_config_derived_v2:testnet', derivedFor(entry.config, fetchedAt));
};
const flush = () => jest.advanceTimersByTimeAsync(0);

let warn: jest.SpyInstance;

beforeEach(() => {
  _resetBridgeConfigRuntimeForTest();
  jest.useFakeTimers({ now: NOW });
  mockStorage.clear();
  mockLookup.mockReset();
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

// A reset keeps the stored document and its derivation, so a request right after one reads them without a fetch.
it('after a wipe, keeps the copy and fetches nothing', async () => {
  seed(1);
  await initBridgeConfig();
  const before = getBridgeConfigSnapshot();
  await Promise.all(mockRereads.map(reread => reread()));
  expect(getBridgeConfigSnapshot()).toBe(before);
  await initBridgeConfig();
  await flush();
  expect(getBridgeConfigSnapshot()).toBe(before);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('never requests eligibility from backend initialization, elapsed time or reset recovery', async () => {
  seed(13);
  await initBridgeConfig();
  await jest.advanceTimersByTimeAsync(HEALTHY_POLL_MS * 2);
  await initBridgeConfig();
  await flush();
  mockStorage.clear();
  await Promise.all(mockRereads.map(reread => reread()));
  await initBridgeConfig();
  expect(mockLookup).not.toHaveBeenCalled();
  expect(getBridgeConfigSnapshot().geo).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});
