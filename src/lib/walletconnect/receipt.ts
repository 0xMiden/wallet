import { createPublicClient, http, type Chain, type Hash } from 'viem';
import { sepolia } from 'viem/chains';

import { getChain } from './config';

export class EvmTransactionRevertedError extends Error {
  constructor(chainName: string) {
    super(`The ${chainName} transaction reverted`);
    this.name = 'EvmTransactionRevertedError';
  }
}

/** Wait for one successful Sepolia confirmation using the app's configured RPC. */
export async function waitForSepoliaReceipt(hash: Hash): Promise<void> {
  return waitForEvmReceipt(hash, sepolia);
}

export async function waitForEvmReceipt(hash: Hash, chain: Chain): Promise<void> {
  const rpcUrl = getChain(chain.id)?.rpcUrl;
  if (!rpcUrl) throw new Error(`${chain.name} RPC is not configured`);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new EvmTransactionRevertedError(chain.name);
}
