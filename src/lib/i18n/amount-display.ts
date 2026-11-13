import BigNumber from 'bignumber.js';

import { getAdaptiveDecimalPlaces, isDisplayable, MAX_DISPLAY_DECIMAL_PLACES } from './adaptive-precision';

export type AmountFormatting = 'adaptive' | 'exact' | 'fixed';
export type AmountRounding = 'up' | 'down' | 'nearest';
export type DisplayAmount = BigNumber.Value | bigint;

export interface AmountDisplayOptions {
  /** Required for base units. Decimal strings and numbers are already in token units. */
  decimals?: number;
  formatting?: AmountFormatting;
  rounding?: AmountRounding;
  symbol?: string;
  minimumFractionDigits?: number;
  trimTrailingZeros?: boolean;
  grouping?: boolean;
  prefix?: string;
  preserveSign?: boolean;
}

/** The one USD display policy: the components' defaults and every USD string. */
export const USD_DISPLAY_OPTIONS: Readonly<
  Pick<AmountDisplayOptions, 'prefix' | 'minimumFractionDigits' | 'trimTrailingZeros' | 'grouping'>
> = {
  prefix: '$',
  minimumFractionDigits: 2,
  trimTrailingZeros: false,
  grouping: true
};

const ROUNDING: Record<AmountRounding, BigNumber.RoundingMode> = {
  up: BigNumber.ROUND_UP,
  down: BigNumber.ROUND_DOWN,
  nearest: BigNumber.ROUND_HALF_UP
};

function displayValue(amount: DisplayAmount, decimals?: number): BigNumber {
  if (typeof amount !== 'bigint') return new BigNumber(amount);
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    return new BigNumber(NaN);
  }
  return new BigNumber(amount.toString()).shiftedBy(-decimals);
}

function minimumDigits(options: AmountDisplayOptions): number {
  if (options.minimumFractionDigits !== undefined) {
    return Math.min(MAX_DISPLAY_DECIMAL_PLACES, Math.max(0, Math.trunc(options.minimumFractionDigits) || 0));
  }
  switch (options.symbol?.toUpperCase()) {
    case 'ETH':
    case 'WETH':
      return 6;
    default:
      return 2;
  }
}

function fractionDigits(value: BigNumber, options: AmountDisplayOptions): number {
  const minimum = minimumDigits(options);
  if (options.formatting === 'fixed') return minimum;
  return value.abs().gte(1) ? minimum : getAdaptiveDecimalPlaces(value, minimum);
}

function renderValue(value: BigNumber, options: AmountDisplayOptions, places?: number, showSmallValue = true): string {
  const rounded = places === undefined ? value : value.decimalPlaces(places, ROUNDING[options.rounding ?? 'nearest']);
  const digits = options.trimTrailingZeros === false ? places : undefined;
  let number = rounded.toFixed();
  if (digits !== undefined) number = rounded.toFixed(digits);
  if (options.grouping) {
    number = rounded.toFormat(digits ?? rounded.decimalPlaces() ?? 0, {
      groupSeparator: ',',
      groupSize: 3,
      decimalSeparator: '.'
    });
  }
  const prefix = options.prefix ?? '';
  if (showSmallValue && !value.isZero() && rounded.isZero()) {
    const threshold = new BigNumber(10).pow(-(places ?? MAX_DISPLAY_DECIMAL_PLACES)).toFixed();
    return value.isNegative() ? `>-${prefix}${threshold}` : `<${prefix}${threshold}`;
  }
  return rounded.isNegative() && !rounded.isZero() ? `-${prefix}${number.slice(1)}` : `${prefix}${number}`;
}

/** Display only. Never use this result as transaction input or a stored amount. */
export function formatAmountDisplay(amount: DisplayAmount, options: AmountDisplayOptions = {}): string {
  const value = displayValue(amount, options.decimals);
  if (!isDisplayable(value)) return '—';
  const text = renderValue(value, options, options.formatting === 'exact' ? undefined : fractionDigits(value, options));
  return options.preserveSign && typeof amount === 'string' && amount.startsWith('+') ? `+${text}` : text;
}

export function formatUsdDisplay(value: DisplayAmount, overrides: AmountDisplayOptions = {}): string {
  return formatAmountDisplay(value, { ...USD_DISPLAY_OPTIONS, ...overrides });
}

/** Keep the final precision for every animation frame. */
export function amountFormatterFor(target: number, options: AmountDisplayOptions = {}): (value: number) => string {
  const value = new BigNumber(target);
  if (!isDisplayable(value)) return () => '—';
  let places = options.formatting === 'exact' ? undefined : fractionDigits(value, options);
  if (
    places !== undefined &&
    !value.isZero() &&
    value.decimalPlaces(places, ROUNDING[options.rounding ?? 'nearest']).isZero()
  ) {
    return () => formatAmountDisplay(target, options);
  }
  if (places !== undefined && options.trimTrailingZeros !== false) {
    const rounded = value.decimalPlaces(places, ROUNDING[options.rounding ?? 'nearest']);
    if (!rounded.isZero()) places = rounded.decimalPlaces() ?? places;
  }
  return frame => renderValue(new BigNumber(frame), { ...options, trimTrailingZeros: false }, places, false);
}
