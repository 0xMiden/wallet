import type { AppKitNetwork } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { getVersion, proxy } from 'valtio/vanilla';

import { __resetRelayDiagnosticsForTest, classifyRelayFailure } from 'lib/telemetry/relay-diagnostics';

import { type AppKitInstance, modal } from './appkit';
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

describe('what a relay failure report says about AppKit', () => {
  type AppKitState = Parameters<Parameters<AppKitInstance['subscribeState']>[0]>[0];
  const onAppKitState = jest.mocked(modal.subscribeState).mock.calls[0]?.[0];
  const appKitState = (state: Partial<AppKitState>): AppKitState => ({
    loading: false,
    open: false,
    initialized: false,
    connectingWallet: undefined,
    ...state
  });
  const reported = () => {
    const failure = classifyRelayFailure('WebSocket connection failed for host: wss://relay.walletconnect.org');
    return failure?.report ? failure.diagnostics : undefined;
  };

  beforeEach(() => __resetRelayDiagnosticsForTest());

  it('tells a failure after the connect modal opened in this window from a session restore', () => {
    onAppKitState?.(appKitState({ open: false }));
    expect(reported()?.relayTrigger).toBe('session_restore');
    onAppKitState?.(appKitState({ open: true }));
    expect(reported()?.relayTrigger).toBe('connect_modal');
  });

  it('follows the relay of an initialized AppKit once, for whether it ever connected', async () => {
    onAppKitState?.(appKitState({ initialized: true }));
    onAppKitState?.(appKitState({ initialized: true }));
    const relayer = (await modal.getUniversalProvider())?.client.core.relayer;
    if (relayer === undefined) throw new Error('the AppKit mock has no relayer');
    await new Promise(resolve => setTimeout(resolve, 0));
    const subscriptions = jest.mocked(relayer.on).mock.calls;
    expect(subscriptions.map(([event]) => event)).toEqual(['relayer_connect']);
    expect(reported()?.relayEverConnected).toBe(false);
    for (const [, listener] of subscriptions) listener();
    expect(reported()?.relayEverConnected).toBe(true);
  });
});
