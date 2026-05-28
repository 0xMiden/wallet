import type EthereumProviderType from '@walletconnect/ethereum-provider';

import { APP_METADATA, SUPPORTED_CHAINS, WC_PROJECT_ID } from './config';

let providerPromise: Promise<EthereumProviderType> | null = null;

export async function getProvider(): Promise<EthereumProviderType> {
  if (typeof window === 'undefined') {
    throw new Error('WalletConnect provider can only be used in a browser context');
  }
  if (!WC_PROJECT_ID) {
    throw new Error('WALLETCONNECT_PROJECT_ID is not set');
  }
  if (!providerPromise) {
    providerPromise = (async () => {
      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      const rpcMap = SUPPORTED_CHAINS.reduce<Record<number, string>>((acc, c) => {
        acc[c.id] = c.rpcUrl;
        return acc;
      }, {});
      const primary = SUPPORTED_CHAINS[0]!;
      const chains: [number, ...number[]] = [primary.id];
      const optionalChains = SUPPORTED_CHAINS.map(c => c.id);
      return EthereumProvider.init({
        projectId: WC_PROJECT_ID,
        showQrModal: false,
        chains,
        optionalChains,
        rpcMap,
        metadata: APP_METADATA
      });
    })();
  }
  return providerPromise;
}

export function resetProvider(): void {
  providerPromise = null;
}
