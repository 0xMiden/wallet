import { encodeFunctionData, type Address } from 'viem';

import type { BatchCall } from './calibur.js';
import { ERC20_ABI } from './erc20.js';

/**
 * The relay of a sell: one ERC-20 `transfer` of the released token to Transak's deposit address, in the full amount
 * of the Transak order. The wallet twin of the call is `buildSellBatch` in `src/lib/onramp/buy-batch.ts`.
 */

/** Transfer the token to the deposit address. */
export function offrampTransferCalls(token: Address, amount: bigint, depositAddress: Address): BatchCall[] {
  return [
    {
      to: token,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [depositAddress, amount] })
    }
  ];
}
