import BigNumber from 'bignumber.js';

import { type AmountRounding, amountFormatterFor, formatAmountDisplay } from './amount-display';

describe('amount display policy', () => {
  it('removes long decimal tails from bridge amounts', () => {
    expect(formatAmountDisplay('1.5747999999999986')).toBe('1.57');
    expect(formatAmountDisplay('13.0000000000001')).toBe('13');
  });

  it('keeps small nonzero values visible', () => {
    expect(formatAmountDisplay('0.000000123456')).toBe('0.00000012');
    expect(formatAmountDisplay('1e-30')).toBe('<0.00000000000000000001');
    expect(formatAmountDisplay('-1e-30', { prefix: '$' })).toBe('>-$0.00000000000000000001');
    expect(formatAmountDisplay('1e-30', { rounding: 'up' })).toBe('0.00000000000000000001');
  });

  it('scales base units without a floating point conversion', () => {
    expect(formatAmountDisplay(123456789012345678901234567890n, { decimals: 18, formatting: 'exact' })).toBe(
      '123456789012.34567890123456789'
    );
    expect(formatAmountDisplay(123456789012345678901234567890n, { decimals: 18, rounding: 'up' })).toBe(
      '123456789012.35'
    );
    expect(formatAmountDisplay(100n, { decimals: 0 })).toBe('100');
  });

  it.each<[AmountRounding, string, string]>([
    ['up', '1.234', '1.24'],
    ['down', '1.239', '1.23'],
    ['nearest', '1.235', '1.24']
  ])('supports %s rounding', (rounding, amount, expected) => {
    expect(formatAmountDisplay(amount, { rounding })).toBe(expected);
    expect(formatAmountDisplay(`-${amount}`, { rounding })).toBe(`-${expected}`);
  });

  it('keeps exact values independent of the rounding setting', () => {
    expect(formatAmountDisplay('1.234567890123456789', { formatting: 'exact', rounding: 'up' })).toBe(
      '1.234567890123456789'
    );
    expect(formatAmountDisplay('1e-30', { formatting: 'exact' })).toBe('0.000000000000000000000000000001');
  });

  it('supports token precision, grouping, signs and padded fiat values', () => {
    expect(formatAmountDisplay('1.23456789', { symbol: 'ETH' })).toBe('1.234568');
    expect(formatAmountDisplay('1.23456789', { symbol: 'WETH' })).toBe('1.234568');
    expect(
      formatAmountDisplay('+1234.5', { grouping: true, prefix: '$', preserveSign: true, trimTrailingZeros: false })
    ).toBe('+$1,234.50');
    expect(formatAmountDisplay(-1234.5, { grouping: true, prefix: '$' })).toBe('-$1,234.5');
    expect(formatAmountDisplay(-0, { prefix: '$' })).toBe('$0');
    expect(formatAmountDisplay(new BigNumber('1.5'), { minimumFractionDigits: 4, trimTrailingZeros: false })).toBe(
      '1.5000'
    );
  });

  it('bounds precision and rejects invalid values and scales', () => {
    for (const amount of [NaN, Infinity, -Infinity, 'invalid', '1e9999999', '1e-9999999']) {
      expect(formatAmountDisplay(amount)).toBe('—');
    }
    for (const decimals of [undefined, -1, 1.5, 37]) {
      expect(formatAmountDisplay(1n, { decimals })).toBe('—');
    }
    expect(formatAmountDisplay('1.234', { minimumFractionDigits: -1 })).toBe('1');
    expect(formatAmountDisplay('1.234', { minimumFractionDigits: NaN })).toBe('1');
    expect(formatAmountDisplay('1.234', { minimumFractionDigits: 100 })).toBe('1.234');
  });

  it('keeps animation precision stable', () => {
    const format = amountFormatterFor(15.67, { prefix: '$' });
    expect(format(0)).toBe('$0.00');
    expect(format(13.0071)).toBe('$13.01');
    expect(format(15.67)).toBe('$15.67');
    expect(amountFormatterFor(0.0000012)(0.0000011)).toBe('0.0000011');
    expect(amountFormatterFor(1.234, { formatting: 'exact' })(1.123)).toBe('1.123');
    expect(amountFormatterFor(Infinity)(1)).toBe('—');
    expect(amountFormatterFor(15.67)(0.004)).toBe('0.00');
    expect(amountFormatterFor(1e-30)(1e-30)).toBe('<0.00000000000000000001');
    expect(amountFormatterFor(1, { rounding: 'down' })(0.005)).toBe('0');
    expect(
      formatAmountDisplay(1n, { decimals: 6, formatting: 'fixed', rounding: 'up', trimTrailingZeros: false })
    ).toBe('0.01');
  });
});
