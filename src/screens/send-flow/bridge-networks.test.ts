import { getChain } from 'lib/walletconnect/config';

import { BRIDGE_NETWORKS, isEpochBridgeNetwork, sendBridgeNetworks, usdcxBridgeNetworks } from './bridge-networks';

let mockEpochChains = new Set([11155111]);
const mockUsdcxChainIds = [5042002, 11155111, 84532, 421614];
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({
    config: {
      supportedEvmChains: Object.fromEntries(
        [...mockEpochChains].map(chainId => [String(chainId), { chainId, bridges: { epoch: {} } }])
      )
    }
  })
}));
jest.mock('lib/remote-config/availability', () => ({
  featureAvailability: (_feature: string, _snapshot: object, _options: undefined, chainId: number) => ({
    state: mockEpochChains.has(chainId) ? 'available' : 'unavailable'
  })
}));
jest.mock('lib/usdcx/constant', () => ({
  DEFAULT_USDCX_DESTINATION_CHAIN_ID: 5042002,
  listUsdcxDestinations: () => mockUsdcxChainIds.map(id => ({ chain: getChain(id) }))
}));

beforeEach(() => {
  mockEpochChains = new Set([11155111]);
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

  it('uses current route availability for each read', () => {
    mockEpochChains = new Set([84532]);
    expect(sendBridgeNetworks(false).map(network => network.id)).toEqual(['base-sepolia']);
    expect(isEpochBridgeNetwork('sepolia')).toBe(false);
    expect(isEpochBridgeNetwork('base-sepolia')).toBe(true);
    mockEpochChains.clear();
    expect(sendBridgeNetworks(false)).toEqual([]);
  });
});
