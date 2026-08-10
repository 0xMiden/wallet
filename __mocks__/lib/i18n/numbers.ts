export const formatNumber = (v: any) => String(v);
export const formatFiat = (v: any) => String(v);
export const formatPercentage = (v: any) => String(v);
// Mirrors the real formatUsd so USD strings keep their exact shape in tests.
export const formatUsd = (v: number) =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Mirrors the real stringToBigInt: scale by the decimals and round.
export const stringToBigInt = (str: string, decimals: number): bigint =>
  BigInt(Math.round(parseFloat(str) * Math.pow(10, decimals)));
