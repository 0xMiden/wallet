import { arbitrumSepolia, baseSepolia, sepolia } from 'viem/chains';

import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { BridgeConfigUnavailableError } from 'lib/remote-config/values';

import {
  getUsdcxDestination,
  getUsdcxDestinations,
  getUsdcxExecutorSource,
  getUsdcxMidenDomain,
  getUsdcxRoutes,
  getUsdcxSourceChain,
  getUsdcxSourceChains,
  getUsdcxXReserveSource,
  isUsdcxExecutorSource,
  listUsdcxDestinations,
  listUsdcxSourceChains,
  minimumUsdcxPayout,
  usdcxPayoutFeeShortfall
} from './chains';

let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);

const ARC_TESTNET_ID = 5042002;
const { usdcx: _usdcx, ...configWithoutUsdcx } = TEST_BRIDGE_CONFIG;
const NO_USDCX: BridgeConfigSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: configWithoutUsdcx };

describe('USDCx routes of the effective network', () => {
  beforeEach(() => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
  });

  it('lists the sources and destinations of the document, in its order', () => {
    const order = [ARC_TESTNET_ID, sepolia.id, baseSepolia.id, arbitrumSepolia.id];
    expect(listUsdcxSourceChains().map(entry => entry.chain.id)).toEqual(order);
    expect(listUsdcxDestinations().map(entry => entry.chain.id)).toEqual(order);
    expect(getUsdcxMidenDomain()).toBe(10007);
  });

  it('builds the routes once per document', () => {
    const routes = getUsdcxRoutes();
    expect(getUsdcxRoutes()).toBe(routes);
    expect(getUsdcxSourceChains()).toBe(routes?.sources);
    // A snapshot the runtime publishes again for the same document keeps the same routes.
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, lastFetch: { at: 1, ok: true } };
    expect(getUsdcxRoutes()).toBe(routes);
    expect(getUsdcxDestinations()).toBe(routes?.destinations);
  });

  it('narrows each route and refuses a chain the document does not list', () => {
    expect(getUsdcxXReserveSource(ARC_TESTNET_ID).usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(getUsdcxExecutorSource(sepolia.id).chain.name).toBe('Sepolia');
    expect(getUsdcxExecutorSource(baseSepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
    expect(() => getUsdcxXReserveSource(sepolia.id)).toThrow('no local xReserve');
    expect(() => getUsdcxExecutorSource(ARC_TESTNET_ID)).toThrow('not an executor source');
    expect(() => getUsdcxSourceChain(999)).toThrow('not configured');
    expect(isUsdcxExecutorSource(baseSepolia.id)).toBe(true);
    expect(isUsdcxExecutorSource(ARC_TESTNET_ID)).toBe(false);
    expect(isUsdcxExecutorSource(undefined)).toBe(false);
  });

  it('reads the domain of each destination', () => {
    expect(getUsdcxDestination(ARC_TESTNET_ID).domain).toBe(26);
    expect(getUsdcxDestination(sepolia.id).domain).toBe(0);
    expect(getUsdcxDestination(arbitrumSepolia.id).domain).toBe(3);
    expect(getUsdcxDestination(baseSepolia.id).domain).toBe(6);
    expect(() => getUsdcxDestination(999)).toThrow('not configured');
  });

  it('names the allowance a burn must exceed and its chain, until the amount exceeds it', () => {
    expect(minimumUsdcxPayout(sepolia.id, 2_000_000n)).toBe(500_000n);
    expect(usdcxPayoutFeeShortfall(sepolia.id, 1_500_000n)).toEqual({ amount: '1.5', network: 'Sepolia' });
    expect(usdcxPayoutFeeShortfall(ARC_TESTNET_ID, 100_000n)).toEqual({ amount: '0.1', network: 'Arc Testnet' });
    expect(usdcxPayoutFeeShortfall(sepolia.id, 1_500_001n)).toBeUndefined();
    expect(usdcxPayoutFeeShortfall(ARC_TESTNET_ID, 100_001n)).toBeUndefined();
    // No amount, or no destination: the amount and destination checks refuse those.
    expect(usdcxPayoutFeeShortfall(sepolia.id, 0n)).toBeUndefined();
    expect(usdcxPayoutFeeShortfall(999, 1n)).toBeUndefined();
  });
});

describe('USDCx routes while the document lists none', () => {
  it.each([
    ['a document with no usdcx section', NO_USDCX],
    ['no accepted document', { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null }]
  ])('offers no route with %s', (_name, snapshot) => {
    mockBridgeSnapshot = snapshot;
    expect(getUsdcxRoutes()).toBeNull();
    expect(listUsdcxSourceChains()).toEqual([]);
    expect(listUsdcxDestinations()).toEqual([]);
    expect(isUsdcxExecutorSource(sepolia.id)).toBe(false);
    expect(() => getUsdcxSourceChain(ARC_TESTNET_ID)).toThrow('not configured');
    expect(() => getUsdcxDestination(ARC_TESTNET_ID)).toThrow('not configured');
    expect(() => getUsdcxMidenDomain()).toThrow(BridgeConfigUnavailableError);
    expect(usdcxPayoutFeeShortfall(sepolia.id, 1n)).toBeUndefined();
  });
});
