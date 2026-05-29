import { getModal } from './appkit';

/**
 * Minimal EIP-1193 surface. Generic `request` keeps it compatible with both
 * viem's `custom()` transport (which only needs `{ request(...args): Promise }`)
 * and the bridge layer's typed calls (`provider.request<string>(...)`).
 */
export type Eip1193Provider = {
  request<T = unknown>(args: { method: string; params?: unknown[] | object }): Promise<T>;
};

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
