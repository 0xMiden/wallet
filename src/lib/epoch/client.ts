import { getConnection, getWalletClient } from '@wagmi/core';
import { type Chain, type WalletClient, createWalletClient, custom } from 'viem';
import { sepolia } from 'viem/chains';

import { wagmiConfig } from 'lib/walletconnect/appkit';
import { buildNativeReownProvider, isNativeReownAvailable, NativeReown } from 'lib/walletconnect/native';

import { MIDEN_DESTINATION_CHAIN_ID } from './config';

export interface EvmConnection {
  address?: string;
  chainId?: number;
  /** True when the session is owned by the native Reown plugin (iOS/Android). */
  isNative: boolean;
}

/**
 * Resolve the active EVM connection from whichever WalletConnect backend is in
 * play — the native Reown plugin on mobile, or the wagmi/AppKit adapter on
 * web/desktop. Lets the Epoch store stay backend-agnostic.
 */
export async function getEvmConnection(): Promise<EvmConnection> {
  if (isNativeReownAvailable()) {
    const state = await NativeReown.getState();
    return { address: state.connected ? state.address : undefined, chainId: state.chainId, isNative: true };
  }
  const connection = getConnection(wagmiConfig);
  return { address: connection.address, chainId: connection.chainId, isNative: false };
}

/**
 * Build a viem WalletClient backed by our existing WalletConnect
 * EthereumProvider. The EthereumProvider is already EIP-1193 compliant, so
 * viem's `custom()` transport adapts it without further plumbing.
 *
 * For Miden→EVM flows pass `{ chainOverride: MIDEN_DESTINATION_CHAIN_ID }` —
 * per Epoch's docs the walletClient's chain.id must be 999999999 before
 * solveIntent so the SDK routes the Miden input correctly. Building a fresh
 * walletClient with that chain id is cleaner than mutating a shared instance.
 */
export async function buildEpochWalletClient(
  address: `0x${string}`,
  opts?: { chainOverride?: number }
): Promise<WalletClient> {
  const chain: Chain =
    opts?.chainOverride !== undefined && opts.chainOverride !== sepolia.id
      ? { ...sepolia, id: opts.chainOverride }
      : sepolia;
  // On mobile the EVM session lives in the native Reown plugin (wagmi is never
  // connected), so back the viem walletClient with a native EIP-1193 shim.
  const rpcUrl = chain.rpcUrls.default.http[0] ?? '';
  const transport = isNativeReownAvailable()
    ? custom(buildNativeReownProvider({ chainId: chain.id, address, rpcUrl }))
    : custom(await getWalletClient(wagmiConfig));
  return createWalletClient({
    account: address,
    chain,
    transport
  });
}

export { MIDEN_DESTINATION_CHAIN_ID };
