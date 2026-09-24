// The adaptive-precision helpers are pure and i18n-free, so the mock re-exports
// the REAL implementation rather than restating it. Copying the logic here once
// let the mock drift from the code it stands in for; importing it cannot.
import { getAdaptiveDecimalPlaces } from 'lib/i18n/adaptive-precision';

export {
  getAdaptiveDecimalPlaces,
  toAdaptiveFixed,
  adaptiveFormatterFor,
  MAX_DISPLAY_DECIMAL_PLACES
} from 'lib/i18n/adaptive-precision';

export const formatNumber = (v: any) => String(v);
export const formatFiat = (v: any) => String(v);
export const formatPercentage = (v: any) => String(v);

// Mirror the real usdFormatterFor and formatUsd so USD strings keep their exact shape in tests.
export const usdFormatterFor = (target: number) => {
  const decimalPlaces = getAdaptiveDecimalPlaces(target);
  return (v: number) =>
    `$${v.toLocaleString('en-US', {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces
    })}`;
};
export const formatUsd = (v: number) => usdFormatterFor(v)(v);
// Mirrors the real stringToBigInt: scale by the decimals and round.
export const stringToBigInt = (str: string, decimals: number): bigint =>
  BigInt(Math.round(parseFloat(str) * Math.pow(10, decimals)));
