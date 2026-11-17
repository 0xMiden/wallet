// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/deposit-terms.ts (MIT).
import { parseUnits } from 'viem';

/** Refuse rounding and amounts the native AssetAmount cannot represent. */
export function parseArcAmount(amount: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount.trim())) throw new Error('Invalid Circle amount precision');
  const value = parseUnits(amount.trim(), 6);
  if (value <= 0n || value > (1n << 63n) - (1n << 31n)) throw new Error('Unsupported Circle native amount');
  return value;
}
