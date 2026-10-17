import type { AppKitNetwork } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { getVersion, proxy } from 'valtio/vanilla';

import {
  __resetRelayDiagnosticsForTest,
  classifyRelayFailure,
  type RelayDiagnostics
} from 'lib/telemetry/relay-diagnostics';

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
  type StartedAppKit = { modal: AppKitInstance; reported: () => RelayDiagnostics | undefined };
  const appKitState = (state: Partial<AppKitState>): AppKitState => ({
    loading: false,
    open: false,
    initialized: false,
    connectingWallet: undefined,
    ...state
  });
  const reportedBy = (classify: typeof classifyRelayFailure) => (): RelayDiagnostics | undefined => {
    const failure = classify('WebSocket connection failed for host: wss://relay.walletconnect.org');
    return failure?.report ? failure.diagnostics : undefined;
  };
  const reported = reportedBy(classifyRelayFailure);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  // A fresh page load: a new AppKit, with the test's ready() or provider read in place of the mock's, and a new
  // relay history.
  async function startAppKit(
    overrides: Partial<Pick<AppKitInstance, 'ready' | 'getUniversalProvider'>>
  ): Promise<StartedAppKit> {
    const loads: StartedAppKit[] = [];
    await jest.isolateModulesAsync(async () => {
      const createAppKitMock = jest.mocked((await import('@reown/appkit/react')).createAppKit);
      const base = createAppKitMock.getMockImplementation();
      if (base === undefined) throw new Error('the AppKit mock has no implementation');
      createAppKitMock.mockImplementationOnce(options => Object.assign(base(options), overrides));
      const { classifyRelayFailure: classify } = await import('lib/telemetry/relay-diagnostics');
      loads.push({ modal: (await import('./appkit')).modal, reported: reportedBy(classify) });
    });
    const [started] = loads;
    if (started === undefined) throw new Error('AppKit did not load');
    return started;
  }

  beforeEach(() => __resetRelayDiagnosticsForTest());

  it("passes on AppKit's word that the connect modal is open, and then that it closed", () => {
    const onAppKitState = jest.mocked(modal.subscribeState).mock.calls[0]?.[0];
    onAppKitState?.(appKitState({ open: true }));
    expect(reported()?.relayTrigger).toBe('connect_modal');
    onAppKitState?.(appKitState({ open: false }));
    expect(reported()?.relayTrigger).toBe('no_connect_modal');
  });

  it('follows the relay once AppKit is ready, whatever states it emits before or after', async () => {
    let ready = () => {};
    const started = await startAppKit({
      ready: () =>
        new Promise<void>(resolve => {
          ready = () => resolve();
        })
    });
    const onAppKitState = jest.mocked(started.modal.subscribeState).mock.calls[0]?.[0];
    const relayer = (await started.modal.getUniversalProvider())?.client.core.relayer;
    if (relayer === undefined) throw new Error('the AppKit mock has no relayer');
    const subscribed = () => jest.mocked(relayer.on).mock.calls.map(([event]) => event);

    for (const initialized of [false, true, true]) onAppKitState?.(appKitState({ initialized }));
    await settle();
    expect(subscribed()).toEqual([]);

    ready();
    await settle();
    for (const initialized of [true, false, true]) onAppKitState?.(appKitState({ initialized }));
    await settle();
    expect(subscribed()).toEqual(['relayer_connect']);
    expect(started.reported()?.relayEverConnected).toBe(false);
    for (const [, listener] of jest.mocked(relayer.on).mock.calls) listener();
    expect(started.reported()?.relayEverConnected).toBe(true);
  });

  // An unhandled rejection fails the test on its own.
  it.each([
    ['ready() rejects', { ready: jest.fn(() => Promise.reject(new Error('AppKit did not start'))) }, 0],
    ['the provider read rejects', { getUniversalProvider: jest.fn(() => Promise.reject(new Error('no provider'))) }, 1],
    ['there is no provider', { getUniversalProvider: jest.fn(async () => undefined) }, 1]
  ])('starts AppKit and follows no relay when %s', async (_label, overrides, providerReads) => {
    const started = await startAppKit(overrides);
    await settle();
    expect(started.modal.subscribeState).toHaveBeenCalledTimes(1);
    expect(started.modal.ready).toHaveBeenCalledTimes(1);
    expect(started.modal.getUniversalProvider).toHaveBeenCalledTimes(providerReads);
  });
});
