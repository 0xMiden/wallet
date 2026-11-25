import type { NearIntentsAddressKind } from 'lib/one-click/types';
import { getChain } from 'lib/walletconnect/config';

import {
  BRIDGE_NETWORKS,
  defaultBridgeNetwork,
  defaultUsdcxBridgeNetwork,
  getSendNetwork,
  isEpochBridgeNetwork,
  isSendNetworkId,
  sendBridgeNetworks,
  sendNetworks,
  usdcxBridgeNetworks
} from './bridge-networks';

type MockSendChain = { id: string; name: string; addressKind: NearIntentsAddressKind; evmChainId?: number };
// The NEAR Intents chains the config offers. Null is the feature off.
let mockNearIntentsChains: MockSendChain[] | null = null;
jest.mock('lib/one-click/config', () => ({
  getNearIntentsConfig: () => (mockNearIntentsChains ? { chains: mockNearIntentsChains } : null)
}));
jest.mock('lib/one-click/send', () => ({
  nearIntentsSendChains: (config: { chains: MockSendChain[] } | null) => config?.chains ?? []
}));

let mockEpochChains = new Set([11155111]);
const mockUsdcxChainIds = [5042002, 11155111, 84532, 421614];
const snapshotOf = (chains: Set<number>) => ({
  config: {
    supportedEvmChains: Object.fromEntries(
      [...chains].map(chainId => [String(chainId), { chainId, bridges: { epoch: {} } }])
    )
  }
});
// One stable object until the chains change, as the runtime publishes it.
let mockSnapshot = snapshotOf(mockEpochChains);
const setChains = (chains: Set<number>) => {
  mockEpochChains = chains;
  mockSnapshot = snapshotOf(chains);
};
let mockNetworkName = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetworkName }));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => mockSnapshot
}));
jest.mock('lib/remote-config/availability', () => ({
  featureAvailability: (_feature: string, _snapshot: object, _options: undefined, chainId: number) => ({
    state: mockEpochChains.has(chainId) ? 'available' : 'unavailable'
  })
}));
jest.mock('lib/usdcx/constant', () => ({
  defaultUsdcxChainId: () => 5042002,
  listUsdcxDestinations: () => mockUsdcxChainIds.map(id => ({ chain: getChain(id) }))
}));

beforeEach(() => {
  mockNetworkName = 'testnet';
  mockNearIntentsChains = null;
  setChains(new Set([11155111]));
});

// The default is keyed per Miden network as the RPC endpoints are, so a wallet switched to mainnet opens on Ethereum.
describe('default bridge network', () => {
  it('is Sepolia on the test networks and Ethereum on mainnet', () => {
    expect(defaultBridgeNetwork().id).toBe('sepolia');
    mockNetworkName = 'localnet';
    expect(defaultBridgeNetwork().id).toBe('sepolia');
    mockNetworkName = 'mainnet';
    expect(defaultBridgeNetwork()).toEqual({ id: 'ethereum', name: 'Ethereum', chainId: 1 });
  });

  it('pre-selects the USDCx chain of the network, else the bridge default', () => {
    expect(defaultUsdcxBridgeNetwork().id).toBe('arc-testnet');
  });
});

describe('send destinations', () => {
  it('settles Epoch and Agglayer on the configured Sepolia route', () => {
    expect(BRIDGE_NETWORKS.filter(network => isEpochBridgeNetwork(network.id)).map(network => network.id)).toEqual([
      'sepolia'
    ]);
    expect(isEpochBridgeNetwork('miden')).toBe(false);
    expect(isEpochBridgeNetwork(undefined)).toBe(false);
  });

  it('offers every USDCx destination where USDCx withdrawals exist, the rest of them USDCx-only', () => {
    expect(sendBridgeNetworks(true)).toEqual(expect.arrayContaining(usdcxBridgeNetworks()));
    expect(sendBridgeNetworks(true)).toHaveLength(usdcxBridgeNetworks().length);
    expect(
      sendBridgeNetworks(true)
        .filter(network => !isEpochBridgeNetwork(network.id))
        .map(network => network.id)
        .sort()
    ).toEqual(['arbitrum-sepolia', 'arc-testnet', 'base-sepolia']);
  });

  it('offers Sepolia alone elsewhere, with the same values across renders', () => {
    expect(sendBridgeNetworks(false).map(network => network.id)).toEqual(['sepolia']);
    expect(sendBridgeNetworks(false)).toEqual(sendBridgeNetworks(false));
  });

  it('returns the same array while the snapshot and the USDCx flag are unchanged', () => {
    const offered = sendBridgeNetworks(false);
    expect(sendBridgeNetworks(false)).toBe(offered);
    expect(sendBridgeNetworks(true)).toBe(sendBridgeNetworks(true));
    expect(sendBridgeNetworks(true)).not.toBe(offered);
    setChains(new Set([84532]));
    expect(sendBridgeNetworks(false)).not.toBe(offered);
    expect(sendBridgeNetworks(false)).toBe(sendBridgeNetworks(false));
  });

  it('uses current route availability for each read', () => {
    setChains(new Set([84532]));
    expect(sendBridgeNetworks(false).map(network => network.id)).toEqual(['base-sepolia']);
    expect(isEpochBridgeNetwork('sepolia')).toBe(false);
    expect(isEpochBridgeNetwork('base-sepolia')).toBe(true);
    setChains(new Set());
    expect(sendBridgeNetworks(false)).toEqual([]);
  });
});

describe('send networks (bridges and NEAR Intents)', () => {
  // The snapshot is the cache key, so a test that changes the NEAR Intents chains publishes a new one.
  const setNearIntentsChains = (chains: MockSendChain[] | null) => {
    mockNearIntentsChains = chains;
    setChains(mockEpochChains);
  };

  it('gives the bridge networks alone while NEAR Intents is off', () => {
    expect(sendNetworks(false)).toEqual([
      { id: 'sepolia', name: 'Sepolia', kind: 'evm', chainId: 11155111, bridge: true }
    ]);
    expect(getSendNetwork('solana')).toBeUndefined();
    expect(isSendNetworkId('solana')).toBe(false);
  });

  it('merges a NEAR Intents EVM chain into the bridge network with the same chain id', () => {
    mockNetworkName = 'mainnet';
    setChains(new Set([1]));
    setNearIntentsChains([{ id: 'eth', name: 'Ethereum', addressKind: 'evm', evmChainId: 1 }]);

    expect(sendNetworks(false)).toEqual([
      { id: 'ethereum', name: 'Ethereum', kind: 'evm', chainId: 1, bridge: true, nearIntentsChainId: 'eth' }
    ]);
  });

  it('adds a NEAR Intents EVM chain that no bridge offers, and leaves out one the wallet does not know', () => {
    setChains(new Set());
    setNearIntentsChains([
      { id: 'eth', name: 'Ethereum', addressKind: 'evm', evmChainId: 1 },
      { id: 'bera', name: 'Berachain', addressKind: 'evm', evmChainId: 80094 },
      { id: 'gnosis', name: 'Gnosis', addressKind: 'evm' }
    ]);

    expect(sendNetworks(false)).toEqual([
      { id: 'ethereum', name: 'Ethereum', kind: 'evm', chainId: 1, bridge: false, nearIntentsChainId: 'eth' }
    ]);
  });

  it('adds Solana, Bitcoin and NEAR as NEAR Intents networks, with the config name', () => {
    setNearIntentsChains([
      { id: 'sol', name: 'Solana', addressKind: 'solana' },
      { id: 'btc', name: 'Bitcoin', addressKind: 'bitcoin' },
      { id: 'near', name: 'NEAR', addressKind: 'near' }
    ]);

    expect(sendNetworks(false).map(network => [network.id, network.kind, network.nearIntentsChainId])).toEqual([
      ['sepolia', 'evm', undefined],
      ['solana', 'solana', 'sol'],
      ['bitcoin', 'bitcoin', 'btc'],
      ['near', 'near', 'near']
    ]);
    expect(getSendNetwork('solana')).toEqual({
      id: 'solana',
      name: 'Solana',
      kind: 'solana',
      nearIntentsChainId: 'sol',
      bridge: false
    });
    expect(isSendNetworkId('bitcoin')).toBe(true);
  });

  it('returns the same array while the snapshot is unchanged', () => {
    setNearIntentsChains([{ id: 'sol', name: 'Solana', addressKind: 'solana' }]);
    const networks = sendNetworks(true);
    expect(sendNetworks(true)).toBe(networks);
    setNearIntentsChains(null);
    expect(sendNetworks(true)).not.toBe(networks);
    expect(sendNetworks(true).some(network => network.id === 'solana')).toBe(false);
  });

  it('finds a known EVM network that no route offers, with no bridge', () => {
    setChains(new Set());
    expect(getSendNetwork('base')).toEqual({ id: 'base', name: 'Base', kind: 'evm', chainId: 8453, bridge: false });
    expect(getSendNetwork(undefined)).toBeUndefined();
    expect(isSendNetworkId(null)).toBe(false);
    expect(isSendNetworkId('nowhere')).toBe(false);
  });
});
