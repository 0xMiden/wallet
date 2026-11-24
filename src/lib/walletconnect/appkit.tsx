import React, { useEffect } from 'react';

import { type AppKitNetwork, defineChain } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { RouterController, StorageUtil } from '@reown/appkit-controllers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';

import { isExtension } from 'lib/platform';
import { initBridgeConfig, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';
import { followRelay, noteConnectModalOpen } from 'lib/telemetry/relay-diagnostics';

import { getWalletConnectChains, prepareWalletConnectChains } from './chains';
import { APP_METADATA, copyPlainData, EVM_CHAIN_DEFINITIONS, getChain, WC_PROJECT_ID } from './config';
import { boundStartupReconnect } from './startup-reconnect';

export type AppKitInstance = ReturnType<typeof createAppKit>;
type AppKitThemeMode = 'light' | 'dark';

// Wagmi keeps the registry for saved transfers. AppKit offers only the document's chains.
const [firstChain, ...otherChains] = EVM_CHAIN_DEFINITIONS;
function appKitNetwork(chain: (typeof EVM_CHAIN_DEFINITIONS)[number]): AppKitNetwork {
  return defineChain({
    ...copyPlainData(chain),
    rpcUrls: { default: { http: [getChain(chain.id)?.rpcUrl ?? chain.rpcUrls.default.http[0] ?? ''] } },
    chainNamespace: 'eip155',
    caipNetworkId: `eip155:${chain.id}`
  });
}
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [appKitNetwork(firstChain), ...otherChains.map(appKitNetwork)];
const appKitThemeVariables = {
  '--apkt-font-family': 'Inter, sans-serif',
  '--apkt-accent': '#E77537',
  '--apkt-color-mix': '#E77537',
  '--apkt-color-mix-strength': 6,
  '--apkt-border-radius-master': '8px'
} as const;

function getInitialAppKitThemeMode(): AppKitThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }
  return resolveTheme(getThemeSetting());
}

function getCurrentAppKitThemeMode(): AppKitThemeMode {
  if (typeof document === 'undefined') {
    return getInitialAppKitThemeMode();
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId: WC_PROJECT_ID,
  ssr: true
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

const queryClient = new QueryClient();

// On the extension the modal offers only mobile wallets through the WalletConnect QR code: a
// browser-extension wallet cannot be reached from an extension page, so the injected, EIP-6963 and
// Coinbase connectors and the "All Wallets" grid are hidden there. The QR code stays on by default.
const extensionPage = isExtension();

/** The modal view a connect opens: the QR code at once on the extension, else the wallet list. */
export const CONNECT_VIEW = extensionPage ? 'ConnectingWalletConnectBasic' : 'Connect';

/**
 * The view the extension shows once the modal is open. The basic QR view draws a wallet list instead
 * of a QR code when AppKit classifies the page as mobile (a coarse pointer or a mobile user agent), and
 * each wallet in that list opens a page with a Browser tab. The wallet-less WalletConnect view always
 * draws the QR code, but `open()` does not accept it, so the router is pointed at it after the open.
 */
const EXTENSION_QR_VIEW = 'ConnectingWalletConnect';

/** Open the connect modal for the EVM namespace, on the QR code alone on the extension. */
export async function openConnectModal(): Promise<void> {
  await modal.open({ view: CONNECT_VIEW, namespace: 'eip155' });
  if (extensionPage) RouterController.reset(EXTENSION_QR_VIEW);
}

export const modal = createAppKit({
  adapters: [wagmiAdapter],
  networks,
  defaultNetwork: networks[0],
  projectId: WC_PROJECT_ID,
  metadata: { ...APP_METADATA, icons: [...APP_METADATA.icons] },
  themeMode: getInitialAppKitThemeMode(),
  themeVariables: appKitThemeVariables,
  featuredWalletIds: [
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // metamask
    '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // rainbow
    'c03dfee351b6fcc421b4494ea33b9d4b92a984f87aa76d1663bb28705e95034a' // uniswap
  ],
  enableInjected: !extensionPage,
  enableEIP6963: !extensionPage,
  enableCoinbase: !extensionPage,
  allWallets: extensionPage ? 'HIDE' : 'SHOW',
  features: { analytics: false, email: false, socials: false, connectMethodsOrder: ['wallet'] }
});

declare global {
  interface Window {
    __TEST_APPKIT_CONNECT_URI__?: () => Promise<string>;
    __TEST_APPKIT_STATE__?: () => { connected: boolean; address?: string; chainId?: number };
  }
}

if (process.env.MIDEN_E2E_TEST === 'true' && typeof window !== 'undefined') {
  let nextUri: ((uri: string) => void) | undefined;
  void modal
    .ready()
    .then(() => modal.getUniversalProvider())
    .then(provider => {
      provider?.on('display_uri', (uri: string) => {
        nextUri?.(uri);
        nextUri = undefined;
      });
    })
    .catch(() => {});
  window.__TEST_APPKIT_CONNECT_URI__ = () =>
    new Promise(resolve => {
      nextUri = resolve;
    });
  window.__TEST_APPKIT_STATE__ = () => {
    const address = modal.getAddress('eip155');
    const chain = modal.getChainId();
    return {
      connected: modal.getIsConnectedState(),
      ...(address ? { address } : {}),
      ...(typeof chain === 'number'
        ? { chainId: chain }
        : typeof chain === 'string' && /^\d+$/.test(chain)
          ? { chainId: Number(chain) }
          : {})
    };
  };
}

// Read only, for relay failure reports: whether the connect modal is open, and whether the relay connected. AppKit's
// start has created the universal provider by the time ready() resolves, so reading it then creates nothing.
try {
  modal.subscribeState(state => noteConnectModalOpen(state.open));
  modal
    .ready()
    .then(() => modal.getUniversalProvider())
    .then(provider => {
      if (provider) followRelay(provider.client.core.relayer);
    })
    .catch(() => {});
} catch {
  // Crash diagnostics cannot keep AppKit from starting.
}

// AppKit restores a stored session at startup and reports `connecting` until that settles. The bound frees Connect
// after ten seconds and leaves the stored session in place (see `startup-reconnect.ts`).
try {
  boundStartupReconnect({
    storedStatus: () => StorageUtil.getConnectionStatus(),
    subscribeStatus: listener => modal.subscribeAccount(account => listener(account.status), 'eip155'),
    subscribeModalOpen: listener => modal.subscribeState(state => listener(state.open))
  });
} catch {
  // The bound cannot keep AppKit from starting.
}

let recoveryChainId: number | undefined;

/** Update the next connection proposal without ending an existing session. */
export async function syncAppKitNetworks(): Promise<void> {
  await modal.ready();
  const ids = getWalletConnectChains().map(chain => chain.id);
  if (recoveryChainId !== undefined && !ids.includes(recoveryChainId)) ids.push(recoveryChainId);
  const previous = modal.getCaipNetworks('eip155');
  if (previous.map(network => network.id).join(',') === ids.join(',')) return;
  const activeId = modal.getCaipNetwork('eip155')?.id;
  for (const network of previous) modal.removeNetwork('eip155', network.id);
  for (const id of ids) {
    const network = networks.find(chain => chain.id === id);
    if (network) modal.addNetwork('eip155', network);
  }
  const offered = modal.getCaipNetworks('eip155');
  const active = offered.find(network => network.id === activeId) ?? offered[0];
  if (active) modal.setCaipNetwork(active);
}

export async function prepareAppKitConnection(savedChainId?: number): Promise<void> {
  await prepareWalletConnectChains(savedChainId);
  recoveryChainId = savedChainId;
  await syncAppKitNetworks();
}

function AppKitNetworkSync() {
  useEffect(() => {
    const sync = () => {
      syncAppKitNetworks().catch(error => console.warn('[walletconnect] Network update failed', error));
    };
    const unsubscribe = subscribeBridgeConfig(sync);
    initBridgeConfig()
      .then(sync)
      .catch(error => console.warn('[walletconnect] Config load failed', error));
    sync();
    return unsubscribe;
  }, []);
  return null;
}

function AppKitThemeSync() {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const syncThemeMode = () => {
      modal.setThemeMode(getCurrentAppKitThemeMode());
    };

    syncThemeMode();

    const observer = new MutationObserver(syncThemeMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => observer.disconnect();
  }, []);

  return null;
}

export function AppKitProvider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AppKitThemeSync />
        <AppKitNetworkSync />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
