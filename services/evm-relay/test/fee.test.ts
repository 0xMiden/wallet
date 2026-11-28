/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { price } from './harness';
import {
  exactFee,
  formatDecimal,
  maxGasForQuote,
  parseDecimal,
  quotedFee,
  type Decimal,
  type FeeInput
} from '../src/fee';

describe('parseDecimal', () => {
  it.each<[string, Decimal]>([
    ['1', { units: 1n, scale: 0 }],
    ['3456.78000000', { units: 345_678_000_000n, scale: 8 }],
    ['0.5', { units: 5n, scale: 1 }],
    ['0.000000000000000001', { units: 1n, scale: 18 }],
    ['123456789012345678901234567890', { units: 123_456_789_012_345_678_901_234_567_890n, scale: 0 }]
  ])('reads %s', (text, expected) => {
    expect(parseDecimal(text)).toEqual(expected);
  });

  it.each([
    '0',
    '0.0',
    '0.000',
    '-1',
    '+1',
    '1e5',
    '1E-5',
    'NaN',
    'Infinity',
    '',
    ' 1',
    '1 ',
    '1.',
    '.5',
    '01',
    '1,5',
    '0x10',
    '0.0000000000000000001',
    '1234567890123456789012345678901'
  ])('refuses %j', text => {
    expect(parseDecimal(text)).toBeNull();
  });

  it.each([1, 0.5, null, undefined, {}, ['1'], 1n])('refuses the value %p that is not text', value => {
    expect(parseDecimal(value)).toBeNull();
  });

  it.each(['1', '0.5', '3456.78000000', '0.000000000000000001', '10.01'])(
    'formats %s back to a text that reads to the same value',
    text => {
      const value = price(text);
      expect(parseDecimal(formatDecimal(value))).toEqual(value);
    }
  );
});

describe('the fee rule', () => {
  // The worked example of the README: gas 250000 at 0.021 gwei, ETH at 3456.78 USD, USDC (6 decimals) at 1 USD.
  const example: FeeInput = {
    gas: 250_000n,
    gasPrice: 21_000_000n,
    nativePrice: price('3456.78'),
    tokenPrice: price('1'),
    tokenDecimals: 6,
    native: false
  };

  it('gives the exact fee as one fraction and rounds only at the end', () => {
    const fee = exactFee(example);
    // 5.25e12 wei at 3456.78 USD/ETH costs 0.018148095 USD.
    expect(fee.numerator * 1000n).toBe(fee.denominator * 18_148_095n);
    expect(quotedFee(fee)).toBe(20_871n);
  });

  it('gives the cost in wei for a fee in the native coin, and reads no price', () => {
    const fee = exactFee({ ...example, native: true, nativePrice: price('0.1'), tokenPrice: price('9') });
    expect(fee).toEqual({ numerator: 250_000n * 21_000_000n, denominator: 1n });
    expect(quotedFee(fee)).toBe(6_037_500_000_000n);
  });

  it('prices a token against the native coin', () => {
    // 5.25e12 wei at 2000 USD/ETH costs 0.0105 USD, or 10.5 base units at 100000 USD/BTC.
    const fee = exactFee({ ...example, nativePrice: price('2000'), tokenPrice: price('100000'), tokenDecimals: 8 });
    expect(fee.numerator * 10n).toBe(fee.denominator * 105n);
    expect(quotedFee(fee)).toBe(13n);
  });

  it('quotes at least 1 base unit, because a fee call of 0 is not a fee call', () => {
    const fee = exactFee({ ...example, gas: 0n });
    expect(quotedFee(fee)).toBe(1n);
  });

  it('rounds the signed gas allowance down', () => {
    expect(maxGasForQuote(200_000n)).toBe(242_105n);
  });
});
