import { getChain } from 'lib/walletconnect/config';

import {
  BRIDGE_NETWORKS,
  defaultBridgeNetwork,
  defaultUsdcxBridgeNetwork,
  isEpochBridgeNetwork,
  sendBridgeNetworks,
  usdcxBridgeNetworks
} from './bridge-networks';

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
  setChains(new Set([11155111]));
});

// The default is keyed per Miden network as the RPC endpoints are, so a wallet switched to mainnet opens on Ethereum.
describe('default bridge network', () => {
  it('is Sepolia on the test networks and Ethereum on mainnet', () => {
    expect(defaultBridgeNetwork().id).toBe('sepolia');
    mockNetworkName = 'localnet';
    expect(defaultBridgeNetwork().id).toBe('sepolia');
    mockNetworkName = 'mainnet';
    expect(defaultBridgeNetwork()).toEqual({ id: 'ethereum', name: 'Ethereum', chainId: 1, family: 'evm' });
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
