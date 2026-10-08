import { createPublicClient, erc20Abi, http, type Address, type Hash } from 'viem';
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

/** The amount of `token` that `spender` may move for `owner`; the read gives up after about 11 s at most. */
export async function readSepoliaErc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  const rpcUrl = getChain(DEFAULT_CHAIN_ID)?.rpcUrl;
  if (!rpcUrl) throw new Error('Sepolia RPC is not configured');
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 5_000, retryCount: 1 }) });
  return client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
}
