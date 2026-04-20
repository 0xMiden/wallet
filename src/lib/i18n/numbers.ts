import BigNumber from 'bignumber.js';
import i18n from 'i18next';

import { MIDEN_METADATA } from 'lib/miden/metadata';

import { getCurrentLocale, getNumberSymbols } from './core';

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

export function formatBigInt(amount: bigint, decimals: number = MIDEN_METADATA.decimals): string {
  if (amount === BigInt(0)) {
    return '0';
  }
  const amountString = amount.toString();
  const numZeros = decimals > 0 ? decimals : 1; // ensure there's always at least 1 zero before the decimal point
  const prefixed = '0'.repeat(numZeros) + amountString;
  const withDecimal = prefixed.slice(0, -decimals) + '.' + prefixed.slice(-decimals);
  const trimmed = withDecimal.replace(/^0+|0+$/g, '');
  const withoutTrailingDecimal = trimmed.replace(/\.$/, '');
  const withLeadingZero = withoutTrailingDecimal.replace(/^\./, '0.');
  return withLeadingZero;
}

export function stringToBigInt(str: string, decimals: number) {
  // Parse the string as a float
  let num = parseFloat(str);

  // Multiply by 10 to the power of the decimal count
  num *= Math.pow(10, decimals);

  // Round the number to avoid float precision issues
  num = Math.round(num);

  // Return the result as a BigInt
  return BigInt(num);
}

export const ALEO_MICROCREDITS_TO_CREDITS = 1_000_000;

export const stringToAleoMicrocredits = (value: string) =>
  BigInt(Math.floor(Number(value) * ALEO_MICROCREDITS_TO_CREDITS));

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
