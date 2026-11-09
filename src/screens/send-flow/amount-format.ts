import { formatAmountDisplay } from 'lib/i18n/amount-display';

export function approxFiatAmount(value: number): string {
  return formatAmountDisplay(value, { prefix: '$', trimTrailingZeros: false, minimumFractionDigits: 2 });
}
