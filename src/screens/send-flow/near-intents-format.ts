import BigNumber from 'bignumber.js';

import { toAdaptiveFixed } from 'lib/i18n/adaptive-precision';
import type { OneClickQuote } from 'lib/one-click/types';
import { arrivalMinutes } from 'screens/near-intents-flow/format';

/** Decimal places that a NEAR Intents amount shows: at most 6, and fewer as the whole part grows. */
const MAX_AMOUNT_PLACES = 6;
const MIN_AMOUNT_PLACES = 2;

/**
 * A 1Click base-unit amount as display text, rounded down so it never shows more than arrives. A value under 1
 * shows at most 6 decimal places (a smaller value shows its first digits that are not zero); a value of 1 or more
 * shows fewer places as its whole part grows. Zeros at the end are removed. Undefined when the value is not an
 * amount.
 */
export function formatNearIntentsAmount(value: string | undefined, decimals: number): string | undefined {
  if (!value || !/^[0-9]{1,78}$/.test(value) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38)
    return undefined;
  const amount = new BigNumber(value).shiftedBy(-decimals);
  const text = amount.lt(1)
    ? toAdaptiveFixed(amount, MAX_AMOUNT_PLACES, BigNumber.ROUND_DOWN)
    : amount.toFixed(
        Math.max(MIN_AMOUNT_PLACES, MAX_AMOUNT_PLACES - amount.integerValue(BigNumber.ROUND_DOWN).toFixed().length),
        BigNumber.ROUND_DOWN
      );
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * The fee of a NEAR Intents send in USD: the USD value of the input less the USD value of the output, never below
 * zero. Undefined when a value does not parse to a finite number. `amountInUsd` and `amountOutUsd` are not part of
 * the signed 1Click quote, so this value is for display only and never for a check.
 */
export function nearIntentsFeeUsd(quote: Pick<OneClickQuote, 'amountInUsd' | 'amountOutUsd'>): number | undefined {
  const amountIn = Number(quote.amountInUsd);
  const amountOut = Number(quote.amountOutUsd);
  if (quote.amountInUsd.trim() === '' || quote.amountOutUsd.trim() === '') return undefined;
  if (!Number.isFinite(amountIn) || !Number.isFinite(amountOut)) return undefined;
  return Math.max(0, amountIn - amountOut);
}

/**
 * The 1Click time estimate in the style of the other route cards ("~30 sec", "~8 mins"): seconds (to the nearest 5)
 * under one minute, else whole minutes rounded up.
 */
export function nearIntentsArrivalText(
  t: (key: string, values?: Record<string, string>) => string,
  seconds: number
): string {
  const rounded = Number.isFinite(seconds) && seconds > 0 ? Math.max(5, Math.round(seconds / 5) * 5) : 60;
  if (rounded < 60) return t('nearIntentsSendArrivalSeconds', { seconds: String(rounded) });
  return t('nearIntentsSendArrivalMinutes', { minutes: String(arrivalMinutes(seconds)) });
}
