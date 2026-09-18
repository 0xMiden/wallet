import BigNumber from 'bignumber.js';

import { toAdaptiveFixed } from 'lib/i18n/numbers';

/**
 * Round DOWN to 4dp (more for tiny balances) and trim zeros: the figure shown as available, and
 * the one Max fills in, must never exceed what the form accepts once the fee reserve is held back.
 * Both amount steps read this, so the rule cannot drift between them.
 */
export function formatBalance(value: number): string {
  return toAdaptiveFixed(value, 4, BigNumber.ROUND_DOWN).replace(/\.?0+$/, '');
}

/**
 * The approximate fiat figure, already prefixed, for the `approxFiatValue` line. Callers keep their
 * own presence guard, because those differ by design: a typed amount on the send screens, a known
 * price on the older amount step, a supplied value on the review hero.
 */
export function approxFiatAmount(value: number): string {
  return `$${toAdaptiveFixed(value)}`;
}
