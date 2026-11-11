import type { OneClickAppFee, OneClickFeePolicy } from './types';

export function expectedOneClickFees(fees: readonly OneClickAppFee[], _policy?: OneClickFeePolicy): OneClickAppFee[] {
  return [...fees];
}
