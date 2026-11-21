import { formatUsdDisplay } from 'lib/i18n/amount-display';

export function approxFiatAmount(value: number): string {
  return formatUsdDisplay(value);
}
