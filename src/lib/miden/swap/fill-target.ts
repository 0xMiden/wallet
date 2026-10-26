import { BPS_DENOMINATOR, isValidSlippageBps } from './slippage-bounds';

/**
 * The amount of the requested token at which a swap order counts as filled:
 * `ceil(requestedAmount × (1 − slippage))`.
 *
 * The slippage is the one the wallet built the ask with (`ISwapExtraInputs.slippageBps`). An order
 * without a valid one (a user-typed ask, an order placed before the slippage was stored, or a value
 * a restored backup made up) is filled only when the full requested amount arrives. The ceiling
 * keeps a one-unit order from counting as filled with nothing received. The target labels the
 * receipt only: settlement reclaims whatever is left at expiry, from the lineage alone.
 */
export function swapFillTarget(requestedAmount: bigint, slippageBps?: number): bigint {
  if (slippageBps === undefined || !isValidSlippageBps(slippageBps)) return requestedAmount;
  const kept = requestedAmount * (BPS_DENOMINATOR - BigInt(slippageBps));
  return (kept + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

/** Did the order receive at least its fill target? A fill above the requested amount counts as reached. */
export function swapFillReached(requestedAmount: bigint, filledAmount: bigint, slippageBps?: number): boolean {
  return filledAmount > 0n && filledAmount >= swapFillTarget(requestedAmount, slippageBps);
}
