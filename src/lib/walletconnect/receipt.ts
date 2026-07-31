import { createPublicClient, http, type Hash } from 'viem';
import { sepolia } from 'viem/chains';

import { DEFAULT_CHAIN_ID, getChain } from './config';

/** Wait for one successful Sepolia confirmation using the app's configured RPC. */
export async function waitForSepoliaReceipt(hash: Hash): Promise<void> {
  const rpcUrl = getChain(DEFAULT_CHAIN_ID)?.rpcUrl;
  if (!rpcUrl) throw new Error('Sepolia RPC is not configured');
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error('The Sepolia transaction reverted');
}
