import {
  createPublicClient,
  erc20Abi,
  http,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type Hash
} from 'viem';

import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { DEFAULT_CHAIN_ID, EVM_CHAIN_DEFINITIONS, getChain } from './config';

export class EvmTransactionRevertedError extends Error {
  constructor(chainName: string) {
    super(`The ${chainName} transaction reverted`);
    this.name = 'EvmTransactionRevertedError';
  }
}

export async function waitForEvmReceipt(hash: Hash, chain: Chain): Promise<void> {
  const rpcUrl = getChain(chain.id)?.rpcUrl;
  if (!rpcUrl) throw new Error(`${chain.name} RPC is not configured`);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new EvmTransactionRevertedError(chain.name);
}

/** A sent transaction's outcome as the chain reports it now: `pending` until it has a receipt. RPC failures throw. */
export async function readEvmReceiptOutcome(hash: Hash, chain: Chain): Promise<'success' | 'reverted' | 'pending'> {
  const rpcUrl = getChain(chain.id)?.rpcUrl;
  if (!rpcUrl) throw new Error(`${chain.name} RPC is not configured`);
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return 'pending';
    throw error;
  }
}

/**
 * The amount of `token` that `spender` may move for `owner`. The read, one retry included, settles within about 10 s:
 * viem's own retry is off so a Retry-After header cannot stretch it.
 */
export async function readSepoliaErc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return readEvmErc20Allowance(token, owner, spender, DEFAULT_CHAIN_ID);
}

export async function readEvmErc20Allowance(
  token: Address,
  owner: Address,
  spender: Address,
  chainId: number
): Promise<bigint> {
  const rpcUrl = getChain(chainId)?.rpcUrl;
  const chain = EVM_CHAIN_DEFINITIONS.find(entry => entry.id === chainId);
  if (!rpcUrl || !chain) throw new Error(`RPC is not configured for EVM chain ${chainId}`);
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }) });
  return withRpcTimeout(
    () => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    `erc20-allowance:${chainId}`,
    { timeoutMs: 5_000, retries: 1 }
  );
}
