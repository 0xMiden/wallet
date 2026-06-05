import React from 'react';

import { sepolia } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';

import { APP_METADATA, WC_PROJECT_ID } from './config';

export type AppKitInstance = ReturnType<typeof createAppKit>;

const networks = [sepolia];

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
  featuredWalletIds: [
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // metamask
    '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // rainbow
    'c03dfee351b6fcc421b4494ea33b9d4b92a984f87aa76d1663bb28705e95034a' // uniswap
  ],
  features: { analytics: false }
});

export function AppKitProvider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
