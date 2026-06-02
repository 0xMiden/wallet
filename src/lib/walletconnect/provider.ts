import { Eip1193Provider } from 'ethers';

import { getModal } from './appkit';

/**
 * The connected EVM wallet's EIP-1193 provider, sourced from AppKit's eip155
 * namespace. Throws when no wallet is connected — callers build SDKs/clients
 * only after a connection exists, so the throw surfaces a programming error.
 */
export async function getProvider(): Promise<Eip1193Provider> {
  const provider = getModal().getProvider<Eip1193Provider>('eip155');
  if (!provider) {
    throw new Error('No EVM wallet connected');
  }
  return provider;
}
