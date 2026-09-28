import BigNumber from 'bignumber.js';

/**
 * Adaptive display precision, kept in its own module because it is the one
 * piece of `numbers.ts` with NO i18n dependencies. `__mocks__/lib/i18n/numbers`
 * re-exports straight from here, so the manual mock and the real
 * implementation can never drift apart (a copy-pasted mock that fell behind
 * its implementation has broken CI in this repo before).
 */

const SMALL_AMOUNT_SIGNIFICANT_PLACES = 2;

/**
 * Hard ceiling on the adaptive expansion. `Intl.NumberFormat` (used by
 * `formatUsd`) throws `RangeError` above 20 fraction digits — ECMA-402 only
 * guarantees 0–20 — so an unbounded result turns a dust balance into a render
 * crash. 20 is also past the point of usefulness: the deepest token we handle
 * is 18 decimals, so nothing real is ever truncated by this clamp.
 */
export const MAX_DISPLAY_DECIMAL_PLACES = 20;

/**
 * Keep the normal display precision unless it would hide a small non-zero
 * value. In that case, include the first non-zero fractional digit and one
 * more significant place (for example, 0.001234 at 2dp uses 4dp).
 */
export function getAdaptiveDecimalPlaces(value: BigNumber.Value, minimumDecimalPlaces: number = 2): number {
  const bn = new BigNumber(value);

  if (!bn.isFinite() || bn.isZero()) {
    return minimumDecimalPlaces;
  }

  const fractionalPart = bn.abs().toFixed().split('.')[1] ?? '';
  const firstNonZeroIndex = fractionalPart.search(/[1-9]/);

  if (firstNonZeroIndex < minimumDecimalPlaces) {
    return minimumDecimalPlaces;
  }

  return Math.min(firstNonZeroIndex + SMALL_AMOUNT_SIGNIFICANT_PLACES, MAX_DISPLAY_DECIMAL_PLACES);
}

export function toAdaptiveFixed(
  value: BigNumber.Value,
  minimumDecimalPlaces: number = 2,
  roundingMode?: BigNumber.RoundingMode
): string {
  const bn = new BigNumber(value);
  const decimalPlaces = getAdaptiveDecimalPlaces(bn, minimumDecimalPlaces);
  return bn.toFixed(decimalPlaces, roundingMode);
}

/**
 * `toAdaptiveFixed` with the decimal places pinned to the ones `target` itself earns, for a figure
 * that is being animated towards `target` (`components/ui/AnimatedNumber`).
 *
 * The adaptive rule picks its precision from each value's own magnitude, which is right for a
 * figure that is simply shown and wrong for one that is travelling: every frame on the way to 1.00
 * is a smaller number, so the frames near zero expand to four decimals and the text changes width
 * on its way to a two-decimal destination. Pinning the target's precision keeps the shape the
 * destination's for the whole trip. Rounding is still BigNumber's, unchanged.
 */
export function adaptiveFormatterFor(
  target: BigNumber.Value,
  minimumDecimalPlaces: number = 2,
  roundingMode?: BigNumber.RoundingMode
): (value: BigNumber.Value) => string {
  const decimalPlaces = getAdaptiveDecimalPlaces(target, minimumDecimalPlaces);
  return value => new BigNumber(value).toFixed(decimalPlaces, roundingMode);
}
