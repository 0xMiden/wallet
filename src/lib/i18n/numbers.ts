import BigNumber from 'bignumber.js';
import i18n from 'i18next';

import { MIDEN_METADATA } from 'lib/miden/metadata';

import { getAdaptiveDecimalPlaces } from './adaptive-precision';
import { getCurrentLocale, getNumberSymbols } from './core';

export { getAdaptiveDecimalPlaces, toAdaptiveFixed, MAX_DISPLAY_DECIMAL_PLACES } from './adaptive-precision';

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
  const decimalPlaces = getAdaptiveDecimalPlaces(value);
  return `$${value.toLocaleString('en-US', {
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
  // A zero-decimal faucet is a whole-unit token, so its base units ARE the
  // amount. Falling through would divide by a phantom decimal place: `-0 === 0`
  // makes `slice(0, -decimals)` return '' and `slice(-decimals)` return the
  // whole string, so 1000 renders as "0.01". Batch claims put arbitrary
  // third-party faucets through here, and 0 decimals is a legal choice.
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
 * A decimal amount string to base units.
 *
 * This is the conversion that decides how much value actually leaves the wallet
 * on every send, swap and deposit, so it runs in arbitrary precision rather than
 * through a double. `parseFloat(str) * 10 ** decimals` cannot represent the
 * result exactly once it exceeds 2^53 — for an 18-decimal token that is any
 * amount over about 9 units, so a routine transfer was silently rounded in its
 * low digits, and a large enough one overflowed to `Infinity`, where `BigInt()`
 * throws `RangeError` instead of sending anything.
 *
 * Still throws on input that is not a number, which is what callers already
 * guard against (an empty amount field reaches here).
 */
export function stringToBigInt(str: string, decimals: number): bigint {
  const shifted = new BigNumber(str).shiftedBy(decimals).integerValue(BigNumber.ROUND_HALF_UP);
  if (!shifted.isFinite()) throw new RangeError(`Cannot convert ${str} to base units`);
  return BigInt(shifted.toFixed(0));
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
