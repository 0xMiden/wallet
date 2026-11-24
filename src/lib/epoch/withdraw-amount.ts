/** Parse underlying base units exactly. No rounding, exponent notation or floating-point intermediates. */
export function withdrawalAmount(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || value.length > 116) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const units = BigInt(`${match[1]}${(match[2] ?? '').padEnd(decimals, '0')}`);
  return units < 2n ** 256n ? units : null;
}

export function withdrawalAmountError(value: string, available: string, decimals: number): string | undefined {
  const fraction = value.split('.')[1];
  if (fraction && fraction.length > decimals) return 'earnWithdrawPrecision';
  const amount = withdrawalAmount(value, decimals);
  if (amount === null || amount <= 0n) return 'earnWithdrawPositive';
  const cap = withdrawalAmount(available, decimals);
  if (cap === null || amount > cap) return 'earnWithdrawAboveAvailable';
  return undefined;
}
