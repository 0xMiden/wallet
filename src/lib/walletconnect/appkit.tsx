import React, { useEffect } from 'react';

import { sepolia } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';

import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';

import { APP_METADATA, WC_PROJECT_ID } from './config';

export type AppKitInstance = ReturnType<typeof createAppKit>;
type AppKitThemeMode = 'light' | 'dark';

const networks = [sepolia];
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
  networks: [sepolia],
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
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
