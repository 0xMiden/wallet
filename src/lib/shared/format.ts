import { formatBigInt } from 'lib/i18n/numbers';
import { MIDEN_METADATA } from 'lib/miden/front';

export const formatAmount = (amount: bigint, tokenDecimals: number | undefined) => {
  const normalizedAmount = formatBigInt(amount, tokenDecimals ?? MIDEN_METADATA.decimals);
  return normalizedAmount;
};
