import BigNumber from 'bignumber.js';

export const formatNumber = (v: any) => String(v);
export const formatFiat = (v: any) => String(v);
export const formatPercentage = (v: any) => String(v);

const SMALL_AMOUNT_SIGNIFICANT_PLACES = 2;

// Mirrors the real getAdaptiveDecimalPlaces so small amounts keep the same
// precision in tests as they do in the app.
export const getAdaptiveDecimalPlaces = (value: BigNumber.Value, minimumDecimalPlaces: number = 2): number => {
  const bn = new BigNumber(value);

  if (!bn.isFinite() || bn.isZero()) {
    return minimumDecimalPlaces;
  }

  const fractionalPart = bn.abs().toFixed().split('.')[1] ?? '';
  const firstNonZeroIndex = fractionalPart.search(/[1-9]/);

  if (firstNonZeroIndex < minimumDecimalPlaces) {
    return minimumDecimalPlaces;
  }

  return firstNonZeroIndex + SMALL_AMOUNT_SIGNIFICANT_PLACES;
};

// Mirrors the real toAdaptiveFixed.
export const toAdaptiveFixed = (
  value: BigNumber.Value,
  minimumDecimalPlaces: number = 2,
  roundingMode?: BigNumber.RoundingMode
): string => {
  const bn = new BigNumber(value);
  return bn.toFixed(getAdaptiveDecimalPlaces(bn, minimumDecimalPlaces), roundingMode);
};

// Mirrors the real formatUsd so USD strings keep their exact shape in tests.
export const formatUsd = (v: number) => {
  const decimalPlaces = getAdaptiveDecimalPlaces(v);
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces
  })}`;
};
// Mirrors the real stringToBigInt: scale by the decimals and round.
export const stringToBigInt = (str: string, decimals: number): bigint =>
  BigInt(Math.round(parseFloat(str) * Math.pow(10, decimals)));
