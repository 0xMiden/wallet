import { encodeFunctionData, type Address } from 'viem';

import type { BatchCall } from './calibur.js';
import { ERC20_ABI } from './erc20.js';

/**
 * The relay of a sell: one ERC-20 `transfer` of the released token to Transak's deposit address. The wallet twin
 * of the call is `buildSellBatch` in `src/lib/onramp/buy-batch.ts`.
 */

/**
 * TEMPORARY, testnet only: the relay of a sell sends `cryptoAmount / 100` of the token, so a 100 USDCx test sale
 * moves 1 USDC. The wallet has the same constant (`SELL_RELAY_AMOUNT_DIVISOR` in `src/lib/onramp/buy-batch.ts`).
 * Set both to 1 when the sell relays the full amount.
 */
export const SELL_RELAY_AMOUNT_DIVISOR = 100n;

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
