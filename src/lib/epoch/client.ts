import { getWalletClient } from '@wagmi/core';
import { type Chain, type WalletClient, createWalletClient, custom } from 'viem';
import { sepolia } from 'viem/chains';

import { wagmiConfig } from 'lib/walletconnect/appkit';

import { MIDEN_DESTINATION_CHAIN_ID } from './config';

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
  const provider = await getWalletClient(wagmiConfig);
  const chain: Chain =
    opts?.chainOverride !== undefined && opts.chainOverride !== sepolia.id
      ? { ...sepolia, id: opts.chainOverride }
      : sepolia;
  return createWalletClient({
    account: address,
    chain,
    transport: custom(provider)
  });
}

export { MIDEN_DESTINATION_CHAIN_ID };
