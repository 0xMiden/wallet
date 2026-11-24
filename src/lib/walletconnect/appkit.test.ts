import type { AppKitNetwork } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { RouterController } from '@reown/appkit-controllers';
import { getVersion, proxy } from 'valtio/vanilla';

import {
  __resetRelayDiagnosticsForTest,
  classifyRelayFailure,
  type RelayDiagnostics
} from 'lib/telemetry/relay-diagnostics';

import { type AppKitInstance, CONNECT_VIEW, modal, openConnectModal } from './appkit';
import { APP_METADATA, EVM_CHAIN_DEFINITIONS, getChain } from './config';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({ config: null }),
  ensureBridgeConfig: async () => ({ config: null }),
  initBridgeConfig: async () => ({ config: null }),
  subscribeBridgeConfig: () => () => {}
}));

const networks: AppKitNetwork[] = jest.mocked(createAppKit).mock.calls[0]?.[0].networks ?? [];

it('keeps the shared native metadata unchanged when AppKit owns its copy', () => {
  const metadata = jest.mocked(createAppKit).mock.calls[0]?.[0].metadata;
  expect(metadata).toEqual(APP_METADATA);
  expect(metadata).not.toBe(APP_METADATA);
  expect(metadata?.icons).not.toBe(APP_METADATA.icons);
  if (!metadata) throw new Error('AppKit did not receive Bread metadata');
  const originalUrl = metadata.url;
  try {
    metadata.url = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html';
    expect(APP_METADATA.url).toBe('https://miden.io');
  } finally {
    metadata.url = originalUrl;
  }
});

it('describes the EVM wallet actions Bread requests at connection', () => {
  const metadata = jest.mocked(createAppKit).mock.calls[0]?.[0].metadata;
  expect(metadata?.name).toBe('Bread Wallet');
  expect(metadata?.description).toMatch(/bridge deposits and claims/i);
  expect(metadata?.description).toMatch(/token approvals/i);
});

describe('external-wallet picker', () => {
  const options = jest.mocked(createAppKit).mock.calls[0]?.[0];

  it('disables embedded email sign-in explicitly', () => {
    expect(options?.features?.email).toBe(false);
  });

  it('disables embedded social sign-in explicitly', () => {
    expect(options?.features?.socials).toBe(false);
  });

  it('offers only external-wallet methods even when the dashboard enables authentication', () => {
    expect(options?.features?.connectMethodsOrder).toEqual(['wallet']);
  });

  it.each(['enableWallets', 'enableWalletConnect'] as const)(
    'keeps external-wallet connections available through %s',
    flag => {
      expect(options).toBeDefined();
      expect(options?.[flag]).not.toBe(false);
    }
  );

  // The Jest realm carries an extension runtime, so this module built the extension's modal.
  it.each(['enableInjected', 'enableEIP6963', 'enableCoinbase'] as const)(
    'hides browser-extension wallets on the extension through %s',
    flag => {
      expect(options?.[flag]).toBe(false);
    }
  );

  it('hides the "All Wallets" grid and opens on the QR code on the extension', () => {
    expect(options?.allWallets).toBe('HIDE');
    expect(CONNECT_VIEW).toBe('ConnectingWalletConnectBasic');
  });

  it('points the open modal at the wallet-less QR view on the extension', async () => {
    jest.mocked(RouterController.reset).mockClear();
    await openConnectModal();
    expect(modal.open).toHaveBeenCalledWith({ view: 'ConnectingWalletConnectBasic', namespace: 'eip155' });
    expect(RouterController.reset).toHaveBeenCalledWith('ConnectingWalletConnect');
  });

  it('keeps every wallet connector and the wallet list off the extension', async () => {
    let realm: { appkit: typeof import('./appkit'); router: typeof import('@reown/appkit-controllers') } | undefined;
    jest.isolateModules(() => {
      jest.doMock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => false }));
      // The isolated registry maps the SDK to a fresh copy of its mock; read the one this realm's module sees.
      const { createAppKit: createAppKitInRealm } =
        jest.requireActual<typeof import('@reown/appkit/react')>('@reown/appkit/react');
      const appkit = jest.requireActual<typeof import('./appkit')>('./appkit');
      const realmOptions = jest.mocked(createAppKitInRealm).mock.calls[0]?.[0];
      expect(realmOptions?.enableInjected).toBe(true);
      expect(realmOptions?.enableEIP6963).toBe(true);
      expect(realmOptions?.enableCoinbase).toBe(true);
      expect(realmOptions?.allWallets).toBe('SHOW');
      expect(appkit.CONNECT_VIEW).toBe('Connect');
      realm = {
        appkit,
        router: jest.requireActual<typeof import('@reown/appkit-controllers')>('@reown/appkit-controllers')
      };
    });
    expect(realm).toBeDefined();
    if (!realm) return;
    jest.mocked(realm.router.RouterController.reset).mockClear();
    await realm.appkit.openConnectModal();
    expect(realm.router.RouterController.reset).not.toHaveBeenCalled();
  });
});

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
    const error = new Error('WebSocket connection failed for host: wss://relay.walletconnect.org');
    const failure = classify(error, error.message);
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
