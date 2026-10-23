import BigNumber from 'bignumber.js';
import i18n from 'i18next';

import { MIDEN_METADATA } from 'lib/miden/metadata';

import { getAdaptiveDecimalPlaces } from './adaptive-precision';
import { getCurrentLocale, getNumberSymbols } from './core';

export {
  getAdaptiveDecimalPlaces,
  toAdaptiveFixed,
  adaptiveFormatterFor,
  MAX_DISPLAY_DECIMAL_PLACES
} from './adaptive-precision';

/**
 * Tiny single-argument memoizer — was `micro-memoize` until we removed
 * it (its `index.d.ts` used a relative `import('./src/Cache')` which
 * pulled unchecked `.ts` source into the TypeScript program,
 * producing 11 errors under `noUncheckedIndexedAccess` that we can't
 * fix since they're in library code).
 */
function memoize1<A, R>(fn: (arg: A) => R): (arg: A) => R {
  const cache = new Map<A, R>();
  return arg => {
    const cached = cache.get(arg);
    if (cached !== undefined) return cached;
    const result = fn(arg);
    cache.set(arg, result);
    return result;
  };
}

type FormatParams = {
  decimalPlaces?: number;
  roundingMode?: BigNumber.RoundingMode;
  format?: BigNumber.Format;
};

function localizeDefaultFormattedNumber(formattedNumber: string) {
  const numberSymbols = getNumberSymbols();
  const pointIndex = formattedNumber.indexOf('.');
  if (pointIndex >= 0) {
    const integerPartStr = formattedNumber.substring(0, pointIndex).replace(/,/g, numberSymbols.group);
    return `${integerPartStr}${numberSymbols.decimal}${formattedNumber.substring(pointIndex + 1)}`;
  }
  return formattedNumber.replace(/,/g, numberSymbols.group);
}

export function toLocalFormat(value: BigNumber.Value, { decimalPlaces, roundingMode, format }: FormatParams) {
  const bn = new BigNumber(value);
  const numberSymbols = getNumberSymbols();

  if (!bn.isFinite()) {
    const showMinus = bn.lt(0) ? '-' : '';
    return bn.isNaN() ? numberSymbols.nan : `${showMinus}${numberSymbols.infinity}`;
  }

  let rawResult = '';
  if (decimalPlaces !== undefined && roundingMode !== undefined) {
    rawResult = bn.toFormat(decimalPlaces, roundingMode, format);
  } else if (decimalPlaces !== undefined && format) {
    rawResult = bn.toFormat(decimalPlaces, format);
  } else if (decimalPlaces !== undefined) {
    rawResult = bn.toFormat(decimalPlaces, roundingMode);
  } else if (format) {
    rawResult = bn.toFormat(format);
  } else {
    rawResult = bn.toFormat();
  }

  if (format === undefined) {
    return localizeDefaultFormattedNumber(rawResult);
  }
  return rawResult;
}

const makePluralRules = memoize1((locale: string) => new Intl.PluralRules(locale.replace('_', '-')));

export function getPluralKey(keyPrefix: string, amount: number) {
  const rules = makePluralRules(getCurrentLocale());
  return `${keyPrefix}_${rules.select(amount)}`;
}

export function formatUsd(value: number): string {
  return usdFormatterFor(value)(value);
}

/**
 * `formatUsd` with its decimal places pinned to the ones `target` earns, for a USD figure animated
 * towards `target` (`components/ui/AnimatedNumber`). Per value, a frame like 13.0071 on the way to
 * 15.67 would widen to four decimals; pinned, every frame keeps the destination's shape.
 */
export function usdFormatterFor(target: number): (value: number) => string {
  const decimalPlaces = getAdaptiveDecimalPlaces(target);
  return value =>
    `$${value.toLocaleString('en-US', {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces
    })}`;
}

export function formatBigInt(amount: bigint, decimals: number = MIDEN_METADATA.decimals): string {
  if (amount === BigInt(0)) {
    return '0';
  }
  // Format the magnitude and reattach the sign. Zero-padding a string that
  // already starts with '-' buries the sign inside the padding, so -5 at 5
  // decimals came out as "-0.00005" spelled "0.000-5" — not a number at all.
  const negative = amount < BigInt(0);
  const amountString = (negative ? -amount : amount).toString();
  // A zero-decimal faucet denominates in whole units, so the amount already IS
  // the display string. The general path below cannot produce that: `-decimals`
  // is `-0`, and `slice(0, -0)` is `slice(0, 0)` — the empty string — so the
  // integer part is dropped and 100 renders as "0.01". That number is shown on
  // the dApp approval sheet next to the amount actually being sent.
  if (decimals <= 0) {
    return negative ? `-${amountString}` : amountString;
  }
  const prefixed = '0'.repeat(decimals) + amountString;
  const withDecimal = prefixed.slice(0, -decimals) + '.' + prefixed.slice(-decimals);
  const trimmed = withDecimal.replace(/^0+|0+$/g, '');
  const withoutTrailingDecimal = trimmed.replace(/\.$/, '');
  const withLeadingZero = withoutTrailingDecimal.replace(/^\./, '0.');
  return negative ? `-${withLeadingZero}` : withLeadingZero;
}

/**
 * Convert a human-typed decimal amount into faucet base units.
 *
 * Lexical, not arithmetic. This used to be `parseFloat(str) * 10 ** decimals`
 * rounded, which cannot represent what the user typed once the scaled value
 * exceeds 2^53: on an 18-decimal asset, `1.000001` came out as
 * 1000000999999999872 base units — 128 short of the amount shown on the review
 * screen the user approved. Shifting the decimal point across the digit STRING
 * has no such limit, so what is built is exactly what was displayed.
 *
 * Digits beyond the faucet's precision are TRUNCATED, not rounded, which is both
 * what the old float path happened to do at the boundary (`1.005` at 2 decimals
 * scaled to 100.49999999999999 and rounded to 100) and the safer direction for an
 * outgoing amount — rounding up would send more than was typed.
 *
 * Throws on input that denotes no number, `''` included; callers depend on that
 * (see `SendManager`, which treats it as "amount not yet valid").
 */
export function stringToBigInt(str: string, decimals: number): bigint {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(str ?? '');
  const intDigits = match?.[2] ?? '';
  const fracDigits = match?.[3] ?? '';
  if (!match || (intDigits === '' && fracDigits === '')) {
    throw new RangeError(`Cannot convert "${str}" to a base-unit amount`);
  }

  const digits = intDigits + fracDigits;
  const exponent = match[4] ? parseInt(match[4], 10) : 0;
  // value = digits × 10^(exponent − fracDigits.length), and we want it scaled by
  // 10^decimals, so the whole conversion is one power-of-ten shift of `digits`.
  const shift = decimals + exponent - fracDigits.length;
  // BigInt division truncates toward zero, which is the drop-excess-digits case.
  const magnitude = shift >= 0 ? BigInt(digits) * 10n ** BigInt(shift) : BigInt(digits) / 10n ** BigInt(-shift);

  return match[1] === '-' ? -magnitude : magnitude;
}

/**
 * True only when `amount`'s base units are strictly greater than `balance`'s.
 *
 * The typed string is scaled by `stringToBigInt`, so digits past `decimals` are
 * dropped and a value past 2^53 stays exact. `balance` is already a JavaScript
 * number; multiplying it by `10 ** decimals` repeats the float error this module
 * left behind, so it is read back through its own decimal string first, shaved
 * by `balanceLowerBound` once it is too large to keep every base unit. An
 * unparsable amount is not over the cap; callers reject it on their own path.
 * Equal base units stay allowed.
 */
export function typedAmountExceedsBalance(amount: string, balance: number, decimals: number): boolean {
  let typed: bigint;
  try {
    typed = stringToBigInt(amount, decimals);
  } catch {
    return false;
  }
  if (!Number.isFinite(balance)) return false;
  return typed > stringToBigInt(balanceLowerBound(balance, decimals).toString(), decimals);
}

// Relative margin of four double ulps: wider than the rounding between a stored balance and the chain's.
const BALANCE_MARGIN = 2 ** -50;

/**
 * The most of `balance` that can be relied on, as a number.
 *
 * Balances are stored as doubles, which keep every base unit only while they fit 2^53. Past that the
 * stored figure can sit a few units above the real balance, so Max or a cap check built from it could
 * accept an amount the account does not hold. Those balances are shaved by a few ulps; the rest are
 * returned unchanged.
 */
export function balanceLowerBound(balance: number, decimals: number): number {
  if (!(balance > 0) || !Number.isFinite(balance)) return balance;
  if (stringToBigInt(balance.toString(), decimals) <= BigInt(Number.MAX_SAFE_INTEGER)) return balance;
  return balance * (1 - BALANCE_MARGIN);
}

/**
 * True when `amount` has a non-zero digit past `decimals`.
 *
 * Trailing zeros past the scale are the same base-unit value `stringToBigInt`
 * already keeps, so they are not a refusal. An unparsable amount is not finer
 * than the scale; callers reject it on their own path. The shift is the same
 * power of ten as `stringToBigInt`, exponent included, so the digits it would
 * truncate are exactly the ones checked here.
 */
export function amountExceedsTokenDecimals(amount: string, decimals: number): boolean {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(amount ?? '');
  const intDigits = match?.[2] ?? '';
  const fracDigits = match?.[3] ?? '';
  if (!match || (intDigits === '' && fracDigits === '')) return false;

  const exponent = match[4] ? parseInt(match[4], 10) : 0;
  const shift = decimals + exponent - fracDigits.length;
  if (shift >= 0) return false;
  return /[1-9]/.test((intDigits + fracDigits).slice(shift));
}

export function toLocalFixed(value: BigNumber.Value, decimalPlaces?: number, roundingMode?: BigNumber.RoundingMode) {
  const bn = new BigNumber(value);
  const numberSymbols = getNumberSymbols();

  if (!bn.isFinite()) {
    const showMinus = bn.lt(0) ? '-' : '';
    return bn.isNaN() ? numberSymbols.nan : `${showMinus}${numberSymbols.infinity}`;
  }

  const rawResult = decimalPlaces === undefined ? bn.toFixed() : bn.toFixed(decimalPlaces, roundingMode);

  return localizeDefaultFormattedNumber(rawResult);
}

export function toShortened(value: BigNumber.Value) {
  let bn = new BigNumber(value);
  if (bn.abs().lt(1)) {
    return toLocalFixed(bn.toPrecision(1));
  }
  bn = bn.integerValue();
  const formats = [
    { key: 'thousandFormat', param: 'thousand' },
    { key: 'millionFormat', param: 'million' },
    { key: 'billionFormat', param: 'billion' }
  ];
  let formatIndex = -1;
  while (bn.abs().gte(1000) && formatIndex < formats.length - 1) {
    formatIndex++;
    bn = bn.div(1000);
  }
  bn = bn.decimalPlaces(1, BigNumber.ROUND_FLOOR);
  if (formatIndex === -1) {
    return toLocalFixed(bn);
  }
  const format = formats[formatIndex]!;
  return i18n.t(format.key, { [format.param]: toLocalFixed(bn) });
}

export function toFixedRoundedDown(value: number, precision: number) {
  const factor = Math.pow(10, precision);
  return (Math.floor(value * factor) / factor).toFixed(precision);
}
