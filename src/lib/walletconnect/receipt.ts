import { createPublicClient, erc20Abi, http, type Address, type Chain, type Hash } from 'viem';
import { sepolia } from 'viem/chains';

import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { DEFAULT_CHAIN_ID, getChain } from './config';

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

/**
 * The amount of `token` that `spender` may move for `owner`. The read, one retry included, settles within about 10 s:
 * viem's own retry is off so a Retry-After header cannot stretch it.
 */
export async function readSepoliaErc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  const rpcUrl = getChain(DEFAULT_CHAIN_ID)?.rpcUrl;
  if (!rpcUrl) throw new Error('Sepolia RPC is not configured');
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }) });
  return withRpcTimeout(
    () => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    'sepolia-allowance',
    { timeoutMs: 5_000, retries: 1 }
  );
}
