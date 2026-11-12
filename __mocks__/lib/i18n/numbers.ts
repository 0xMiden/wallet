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
// The balance check has to use the real digit shift. This stand-in still scales through parseFloat,
// which is the comparison the helper exists to replace.
export const typedAmountExceedsBalance = (amount: string, balance: number, decimals: number): boolean =>
  jest
    .requireActual<typeof import('../../../src/lib/i18n/numbers')>('lib/i18n/numbers')
    .typedAmountExceedsBalance(amount, balance, decimals);
export const balanceLowerBound = (balance: number, decimals: number): number =>
  jest
    .requireActual<typeof import('../../../src/lib/i18n/numbers')>('lib/i18n/numbers')
    .balanceLowerBound(balance, decimals);
export const amountExceedsTokenDecimals = (amount: string, decimals: number): boolean =>
  jest
    .requireActual<typeof import('../../../src/lib/i18n/numbers')>('lib/i18n/numbers')
    .amountExceedsTokenDecimals(amount, decimals);
export const toLocalFormat = (...args: Parameters<typeof import('../../../src/lib/i18n/numbers').toLocalFormat>) =>
  jest.requireActual<typeof import('../../../src/lib/i18n/numbers')>('lib/i18n/numbers').toLocalFormat(...args);
// Mirrors the real formatBigInt: the decimal point shifted into the digit string, trailing zeros dropped.
export const formatBigInt = (amount: bigint, decimals: number): string => {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const text = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
};
