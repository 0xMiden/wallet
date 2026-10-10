import { BRIDGE_NETWORKS, isEpochBridgeNetwork, sendBridgeNetworks, USDCX_BRIDGE_NETWORKS } from './bridge-networks';

describe('send destinations', () => {
  it('settles Epoch and Agglayer on Sepolia alone', () => {
    expect(BRIDGE_NETWORKS.filter(network => isEpochBridgeNetwork(network.id)).map(network => network.id)).toEqual([
      'sepolia'
    ]);
    expect(isEpochBridgeNetwork('miden')).toBe(false);
    expect(isEpochBridgeNetwork(undefined)).toBe(false);
  });

  it('offers every USDCx destination where USDCx withdrawals exist, the rest of them USDCx-only', () => {
    expect(sendBridgeNetworks(true)).toBe(USDCX_BRIDGE_NETWORKS);
    expect(
      sendBridgeNetworks(true)
        .filter(network => !isEpochBridgeNetwork(network.id))
        .map(network => network.id)
        .sort()
    ).toEqual(['arbitrum-sepolia', 'arc-testnet', 'base-sepolia']);
  });

  it('offers Sepolia alone elsewhere, as one list across renders', () => {
    expect(sendBridgeNetworks(false).map(network => network.id)).toEqual(['sepolia']);
    expect(sendBridgeNetworks(false)).toBe(sendBridgeNetworks(false));
  });
});
