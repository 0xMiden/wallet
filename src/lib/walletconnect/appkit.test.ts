import type { AppKitNetwork } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { getVersion, proxy } from 'valtio/vanilla';

import './appkit';
import { EVM_CHAIN_DEFINITIONS, getChain } from './config';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({ config: null }),
  ensureBridgeConfig: async () => ({ config: null }),
  initBridgeConfig: async () => ({ config: null }),
  subscribeBridgeConfig: () => () => {}
}));

const networks: AppKitNetwork[] = jest.mocked(createAppKit).mock.calls[0]?.[0].networks ?? [];

function nestedObjects(value: object): object[] {
  return Object.values(value).flatMap(entry =>
    typeof entry === 'object' && entry !== null ? [entry, ...nestedObjects(entry)] : []
  );
}

it('keeps the shared viem chains plain once AppKit holds its networks in valtio state', () => {
  expect(networks).toHaveLength(EVM_CHAIN_DEFINITIONS.length);
  // AppKit's ChainController does this with the networks, and valtio proxies their nested objects in place.
  proxy({ caipNetworks: networks });
  expect(getVersion(networks[0]?.blockExplorers?.default)).toBeDefined();
  for (const chain of EVM_CHAIN_DEFINITIONS) {
    expect(nestedObjects(chain).filter(entry => getVersion(entry) !== undefined)).toEqual([]);
  }
});

it('hands AppKit and wagmi every field of each chain, on the configured RPC', () => {
  for (const chain of EVM_CHAIN_DEFINITIONS) {
    expect(networks.find(network => network.id === chain.id)).toEqual({
      ...chain,
      rpcUrls: { default: { http: [getChain(chain.id)?.rpcUrl] } },
      chainNamespace: 'eip155',
      caipNetworkId: `eip155:${chain.id}`
    });
  }
});
