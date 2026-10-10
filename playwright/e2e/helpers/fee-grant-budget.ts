/** Minimum advertised public-faucet grants needed to cover a bounded transaction fee budget. */
export function requiredFeeGrantCount(
  transactionCount: number,
  maxFeePerTransaction: bigint,
  grantAmount: bigint
): number {
  if (!Number.isSafeInteger(transactionCount) || transactionCount < 1) {
    throw new Error('transactionCount must be a positive safe integer');
  }
  if (maxFeePerTransaction <= 0n) throw new Error('maxFeePerTransaction must be positive');
  if (grantAmount <= 0n) throw new Error('grantAmount must be positive');

  const requiredAmount = BigInt(transactionCount) * maxFeePerTransaction;
  if (requiredAmount === 0n) return 1;
  const count = (requiredAmount + grantAmount - 1n) / grantAmount;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('required fee grant count exceeds the safe integer range');
  }
  return Number(count);
}
