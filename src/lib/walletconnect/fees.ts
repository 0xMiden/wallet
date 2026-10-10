import { createPublicClient, Hex, http, toHex } from 'viem';

import { getChain } from './config';

/**
 * Fee fields for a native WalletConnect request: the max fee per gas covers twice the latest base fee
 * plus the priority fee, so a base fee that rises between the wallet's estimate and inclusion does not
 * reject the transaction at `eth_sendRawTransaction` ("max fee per gas less than block base fee", seen
 * on Arbitrum Sepolia). The wallet is still free to raise them.
 */
export interface NativeFeeFields {
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
}

/** Twice the base fee: enough for the base fee to double across the blocks a wallet prompt takes. */
const BASE_FEE_HEADROOM = 2n;
const FEE_READ_TIMEOUT_MS = 10_000;

/**
 * Read the chain's latest base fee and suggested priority fee and build the fee fields with headroom.
 * A chain without EIP-1559 fields, a missing RPC or a failed read yields no fields, so the wallet
 * estimates as before; a fee read must never block a deposit.
 */
export async function readNativeFeeFields(chainId: number): Promise<NativeFeeFields> {
  const chain = getChain(chainId);
  if (!chain) return {};
  try {
    const client = createPublicClient({
      transport: http(chain.rpcUrl, { timeout: FEE_READ_TIMEOUT_MS, retryCount: 0 })
    });
    const block = await client.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas;
    if (baseFee === null || baseFee === undefined) return {};
    const priorityFee = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
    return {
      maxFeePerGas: toHex(baseFee * BASE_FEE_HEADROOM + priorityFee),
      maxPriorityFeePerGas: toHex(priorityFee)
    };
  } catch (error) {
    console.warn('[walletconnect] fee read failed; the wallet estimates the fee', chainId, error);
    return {};
  }
}
