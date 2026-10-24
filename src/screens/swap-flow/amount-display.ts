import BigNumber from 'bignumber.js';

import { toAdaptiveFixed } from 'lib/i18n/adaptive-precision';

/** Presentation only. Never feed this rounded display back into order terms or amount inputs. */
export function swapPayEstimate(amount: string): string {
  const value = new BigNumber(amount);
  if (!value.isFinite() || value.lte(0)) return amount;
  // Eight decimal places normally; retain significant digits for dust instead of displaying zero.
  // toFixed() without a precision trims display-only trailing zeroes without a Number round-trip.
  const rounded = value.gte(1)
    ? value.toFixed(8, BigNumber.ROUND_HALF_UP)
    : toAdaptiveFixed(value, 8, BigNumber.ROUND_HALF_UP);
  // Keep the same ungrouped decimal notation as the editable token field.
  return new BigNumber(rounded).toFixed();
}
