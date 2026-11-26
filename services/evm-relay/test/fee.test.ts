/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { price } from './harness';
import {
  FEE_TOLERANCE_PERCENT,
  QUOTE_MARGIN_PERCENT,
  exactFee,
  formatDecimal,
  minimumFee,
  parseDecimal,
  quotedFee,
  type Decimal,
  type FeeInput
} from '../src/fee';

/** A small deterministic generator (Park–Miller), so a failure repeats. Each product stays below 2^53. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state;
  };
}

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
  // The worked example of the README: gas 250000 at 0.041 gwei, ETH at 3456.78 USD, USDC (6 decimals) at 1 USD.
  const example: FeeInput = {
    gas: 250_000n,
    maxFeePerGas: 41_000_000n,
    nativePrice: price('3456.78'),
    tokenPrice: price('1'),
    tokenDecimals: 6,
    native: false
  };

  it('gives the exact fee as one fraction and rounds only at the end', () => {
    const fee = exactFee(example);
    // 1.025e13 wei × 3456.78 USD/ETH = 0.035431995 USD = 35431.995 base units.
    expect(fee.numerator * 1000n).toBe(fee.denominator * 35_431_995n);
    expect(quotedFee(fee)).toBe(40_747n);
    expect(minimumFee(fee)).toBe(33_661n);
  });

  it('gives the cost in wei for a fee in the native coin, and reads no price', () => {
    const fee = exactFee({ ...example, native: true, nativePrice: price('0.1'), tokenPrice: price('9') });
    expect(fee).toEqual({ numerator: 250_000n * 41_000_000n, denominator: 1n });
    expect(quotedFee(fee)).toBe(11_787_500_000_000n);
  });

  it('prices a token against the native coin', () => {
    // 1.025e13 wei at 2000 USD per ETH is 0.0205 USD; at 100000 USD per BTC (8 decimals) that is 20.5 base units.
    const fee = exactFee({ ...example, nativePrice: price('2000'), tokenPrice: price('100000'), tokenDecimals: 8 });
    expect(fee.numerator * 10n).toBe(fee.denominator * 205n);
    expect(quotedFee(fee)).toBe(24n);
    expect(minimumFee(fee)).toBe(20n);
  });

  it('quotes and accepts at least 1 base unit, because a fee call of 0 is not a fee call', () => {
    const fee = exactFee({ ...example, gas: 0n });
    expect(quotedFee(fee)).toBe(1n);
    expect(minimumFee(fee)).toBe(1n);
  });

  it('uses the named margins', () => {
    expect(QUOTE_MARGIN_PERCENT).toBe(15n);
    expect(FEE_TOLERANCE_PERCENT).toBe(5n);
  });

  it('never gives a quote below the relay minimum for an estimate up to 115/95 of the quoted gas', () => {
    const next = generator(7);
    for (let round = 0; round < 2_000; round += 1) {
      const quoteGas = BigInt(21_000 + (next() % 5_000_000));
      // Any relay estimate R with R × (100 - tolerance) ≤ quoteGas × (100 + margin).
      const relayGas = (quoteGas * (100n + QUOTE_MARGIN_PERCENT)) / (100n - FEE_TOLERANCE_PERCENT);
      const input: FeeInput = {
        gas: quoteGas,
        maxFeePerGas: BigInt(1 + (next() % 200_000_000_000)),
        nativePrice: { units: BigInt(1 + (next() % 100_000_000)), scale: next() % 9 },
        tokenPrice: { units: BigInt(1 + (next() % 100_000_000)), scale: next() % 9 },
        tokenDecimals: next() % 19,
        native: next() % 4 === 0
      };
      const quoted = quotedFee(exactFee(input));
      expect(quoted).toBeGreaterThanOrEqual(minimumFee(exactFee({ ...input, gas: relayGas })));
    }
  });
});
