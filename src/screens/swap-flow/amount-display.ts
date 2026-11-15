import { formatAmountDisplay } from 'lib/i18n/amount-display';

/** Display only. Never use this result as order input. */
export function swapPayEstimate(amount: string): string {
  return formatAmountDisplay(amount, { minimumFractionDigits: 8 });
}
