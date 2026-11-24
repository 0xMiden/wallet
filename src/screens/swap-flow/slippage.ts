import {
  DEFAULT_SWAP_SLIPPAGE_BPS,
  isValidSlippageBps,
  MAX_SWAP_SLIPPAGE_BPS,
  MIN_SWAP_SLIPPAGE_BPS
} from 'lib/miden/swap/quote';

/**
 * The slippage the review screen edits, as a percent string ("0.2"), and the basis points the
 * quote builds the ask with (20). Basis points stay the stored unit: a whole number, so the ask
 * formula divides by exactly 10 000 and two screens can never disagree about a rounding.
 *
 * The range is the quote module's (`MIN_SWAP_SLIPPAGE_BPS` to `MAX_SWAP_SLIPPAGE_BPS`, 0.01 % to
 * 1 %). On testnet the market-maker bot answers at the user's price plus its 0.3 % spread and the
 * solver fills at the mid, so an order above about 0.25 % does not fill; the screen says so in a
 * hint, but the range does not stop it, since a real market maker has no such ceiling.
 */

export const DEFAULT_SLIPPAGE_PERCENT = slippageBpsToPercent(DEFAULT_SWAP_SLIPPAGE_BPS);

/** `20` → `"0.2"`, `500` → `"5"`: the percent with no trailing zeros. */
export function slippageBpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${whole}.${fraction}`;
}

/**
 * The basis points a typed percent stands for, or undefined when it is not a number with at most
 * two decimals inside the range. Lexical: the two decimal digits are read off the string, so no
 * float can round "0.29" to 28.
 */
export function slippagePercentToBps(draft: string): number | undefined {
  const match = /^\s*(\d*)(?:\.(\d{0,2}))?\s*$/.exec(draft);
  if (!match) return undefined;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return undefined;
  const bps = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  return isValidSlippageBps(bps) ? bps : undefined;
}

/** The percent bounds, for the range message. */
export const SLIPPAGE_PERCENT_BOUNDS = {
  min: slippageBpsToPercent(MIN_SWAP_SLIPPAGE_BPS),
  max: slippageBpsToPercent(MAX_SWAP_SLIPPAGE_BPS)
};
