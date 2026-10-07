import type { MidenUsdc } from 'lib/remote-config/e2e-overrides';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BridgeConfig } from 'lib/remote-config/schema';
import type { EarnMarket, EvmUsdc } from 'lib/remote-config/values';

/** Today's testnet Epoch deployment on fixed test hosts: the bridge-config values the Epoch suites run against. */
export const TEST_ALLOCATOR_URL = 'https://allocator.test';
export const TEST_POSITIONS_URL = 'https://positions.test';
export const TEST_EVM_CHAIN_ID = 11155111;
export const TEST_EVM_USDC: EvmUsdc = {
  address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  symbol: 'USDC',
  decimals: 18,
  chainId: TEST_EVM_CHAIN_ID
};
export const TEST_EARN_MARKET: EarnMarket = {
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
  underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  chainId: TEST_EVM_CHAIN_ID
};
export const TEST_MIDEN_USDC_FAUCET = '0x537c15a622074e91188aa894456c52';
export const TEST_MIDEN_USDC: MidenUsdc = { faucetId: TEST_MIDEN_USDC_FAUCET, symbol: 'USDC', decimals: 6 };
/** The testnet bridge registry's native-ETH faucet: it mints bridged ETH and sends its deliveries. */
export const TEST_NATIVE_ETH_FAUCET = '0x0b372f2735e33e91216d995bf29b91';
/** That faucet's registry scale: a deposit of `w` wei arrives as `floor(w / 10^scale)` of its units. */
export const TEST_NATIVE_ETH_SCALE = 10;
/** The testnet Agglayer bridge account every bridge-out note targets, and the L1 bridge's networkID() it carries. */
export const TEST_MIDEN_BRIDGE = '0x3b66e20b5088f25133b69216484652';
export const TEST_EVM_NETWORK_ID = 0;

/**
 * A `lib/remote-config/values` stand-in resolving to the fixtures above; every getter is a jest.fn a suite can
 * re-stub. Install it with
 * `jest.mock('lib/remote-config/values', () => jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config').remoteConfigValuesMock())`.
 */
export function remoteConfigValuesMock() {
  return {
    getEpochAllocatorUrl: jest.fn(() => TEST_ALLOCATOR_URL),
    getEpochPositionsUrl: jest.fn(() => TEST_POSITIONS_URL),
    getEvmChainId: jest.fn(() => TEST_EVM_CHAIN_ID),
    getEvmUsdc: jest.fn(() => TEST_EVM_USDC),
    getEvmUsdcAddress: jest.fn(() => TEST_EVM_USDC.address),
    findEvmUsdc: jest.fn((): EvmUsdc | null => TEST_EVM_USDC),
    getEarnMarket: jest.fn(() => TEST_EARN_MARKET),
    getMidenUsdc: jest.fn(() => TEST_MIDEN_USDC)
  };
}

/** The testnet document naming the fixtures above. */
export const TEST_BRIDGE_CONFIG: BridgeConfig = {
  network: 'testnet',
  version: 1,
  evm: { chainId: TEST_EVM_CHAIN_ID },
  agglayer: {},
  epoch: {
    allocatorUrl: TEST_ALLOCATOR_URL,
    positionsUrl: TEST_POSITIONS_URL,
    midenUsdcFaucet: TEST_MIDEN_USDC_FAUCET,
    evmUsdc: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    earnProtocol: 'dummy-lending'
  },
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
};

const SKIPPED: { state: 'skipped' } = { state: 'skipped' };

/** That document as this realm holds it once loaded, with both USDC tokens read. */
export const TEST_BRIDGE_CONFIG_SNAPSHOT: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'ready',
  config: TEST_BRIDGE_CONFIG,
  derived: {
    network: 'testnet',
    version: 1,
    derivedAt: 0,
    agglayer: { rollupId: SKIPPED, tokens: SKIPPED, evmNetworkId: SKIPPED, l1BridgeCode: SKIPPED, indexer: SKIPPED },
    epoch: {
      allocator: { state: 'ok', value: true },
      midenUsdcFaucet: { state: 'ok', value: { symbol: TEST_MIDEN_USDC.symbol, decimals: TEST_MIDEN_USDC.decimals } },
      evmUsdc: { state: 'ok', value: { symbol: TEST_EVM_USDC.symbol, decimals: TEST_EVM_USDC.decimals } }
    }
  },
  lastFetch: null
};

const mockRuntimeListeners = new Set<() => void>();

/**
 * A `lib/remote-config/runtime` stand-in whose snapshot is `read()`'s when it returns one, else the real realm's.
 * Install it with
 * `jest.mock('lib/remote-config/runtime', () => jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config').remoteConfigRuntimeMock(() => mockBridgeSnapshot))`,
 * where `mockBridgeSnapshot` is a `let` the suite sets before it renders, then `publishMockBridgeSnapshot()` to
 * re-render its subscribers. It never fetches or schedules: loading resolves to the snapshot read, and a hold is inert.
 */
export function remoteConfigRuntimeMock(
  read: () => BridgeConfigSnapshot | undefined
): typeof import('lib/remote-config/runtime') {
  const actual = jest.requireActual<typeof import('lib/remote-config/runtime')>('lib/remote-config/runtime');
  const getBridgeConfigSnapshot = () => read() ?? actual.getBridgeConfigSnapshot();
  return {
    ...actual,
    getBridgeConfigSnapshot,
    subscribeBridgeConfig: listener => {
      mockRuntimeListeners.add(listener);
      return () => {
        mockRuntimeListeners.delete(listener);
      };
    },
    initBridgeConfig: async () => getBridgeConfigSnapshot(),
    holdFastPoll: () => () => undefined
  };
}

/** Notifies every subscriber of `remoteConfigRuntimeMock`, as the runtime does once it replaces its snapshot. */
export function publishMockBridgeSnapshot(): void {
  mockRuntimeListeners.forEach(listener => listener());
}
