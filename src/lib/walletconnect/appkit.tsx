import React, { useEffect } from 'react';

import { type AppKitNetwork, defineChain } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';

import { initBridgeConfig, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';
import { followRelay, noteConnectModalOpen } from 'lib/telemetry/relay-diagnostics';

import { getWalletConnectChains, prepareWalletConnectChains } from './chains';
import { APP_METADATA, copyPlainData, EVM_CHAIN_DEFINITIONS, getChain, WC_PROJECT_ID } from './config';

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

export const modal = createAppKit({
  adapters: [wagmiAdapter],
  networks,
  defaultNetwork: networks[0],
  projectId: WC_PROJECT_ID,
  metadata: APP_METADATA,
  themeMode: getInitialAppKitThemeMode(),
  themeVariables: appKitThemeVariables,
  featuredWalletIds: [
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // metamask
    '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // rainbow
    'c03dfee351b6fcc421b4494ea33b9d4b92a984f87aa76d1663bb28705e95034a' // uniswap
  ],
  features: { analytics: false }
});

// Read only, for relay failure reports: whether the connect modal is open, and whether the relay connected.
let relayFollowed = false;
try {
  modal.subscribeState(state => {
    noteConnectModalOpen(state.open);
    if (!state.initialized || relayFollowed) return;
    relayFollowed = true;
    modal
      .getUniversalProvider()
      .then(provider => {
        if (provider) followRelay(provider.client.core.relayer);
      })
      .catch(() => {});
  });
} catch {
  // Crash diagnostics cannot keep AppKit from starting.
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
