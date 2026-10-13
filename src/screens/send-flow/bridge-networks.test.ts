import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import {
  BRIDGE_NETWORKS,
  defaultUsdcxBridgeNetwork,
  isEpochBridgeNetwork,
  isUsdcxBridgeNetwork,
  sendBridgeNetworks,
  usdcxBridgeNetworks
} from './bridge-networks';

// The USDCx destinations come from the bridge config snapshot. Each test sets the snapshot it reads.
let mockBridgeSnapshot: BridgeConfigSnapshot;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);

/** The testnet snapshot with no `usdcx` section in its document. */
const NO_USDCX_SNAPSHOT: BridgeConfigSnapshot = {
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  config: { ...TEST_BRIDGE_CONFIG, usdcx: undefined }
};

beforeEach(() => {
  mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
});

describe('send destinations', () => {
  it('settles Epoch and Agglayer on Sepolia alone', () => {
    expect(BRIDGE_NETWORKS.filter(network => isEpochBridgeNetwork(network.id)).map(network => network.id)).toEqual([
      'sepolia'
    ]);
    expect(isEpochBridgeNetwork('miden')).toBe(false);
    expect(isEpochBridgeNetwork(undefined)).toBe(false);
  });

  it('offers every USDCx destination where USDCx withdrawals exist, the rest of them USDCx-only', () => {
    expect(sendBridgeNetworks(true)).toBe(usdcxBridgeNetworks());
    expect(
      sendBridgeNetworks(true)
        .filter(network => !isEpochBridgeNetwork(network.id))
        .map(network => network.id)
        .sort()
    ).toEqual(['arbitrum-sepolia', 'arc-testnet', 'base-sepolia']);
  });

  it('offers the four USDCx destinations in the order of the document, the first one as the default', () => {
    expect(sendBridgeNetworks(true).map(network => network.id)).toEqual([
      'arc-testnet',
      'sepolia',
      'base-sepolia',
      'arbitrum-sepolia'
    ]);
    expect(defaultUsdcxBridgeNetwork()?.id).toBe('arc-testnet');
    expect(isUsdcxBridgeNetwork('base-sepolia')).toBe(true);
  });

  it('keeps one USDCx list for one document', () => {
    expect(usdcxBridgeNetworks()).toBe(usdcxBridgeNetworks());
  });

  it('lists no USDCx destination and no default while the document has no usdcx section', () => {
    mockBridgeSnapshot = NO_USDCX_SNAPSHOT;
    expect(usdcxBridgeNetworks()).toEqual([]);
    expect(defaultUsdcxBridgeNetwork()).toBeUndefined();
    expect(isUsdcxBridgeNetwork('arc-testnet')).toBe(false);
  });

  it('offers Sepolia alone elsewhere, as one list across renders', () => {
    expect(sendBridgeNetworks(false).map(network => network.id)).toEqual(['sepolia']);
    expect(sendBridgeNetworks(false)).toBe(sendBridgeNetworks(false));
  });
});
