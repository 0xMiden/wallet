import { USD_QUOTE_MAX_AGE_MS } from 'lib/prices/amount';
import { fixedQuote } from 'lib/prices/fixed';

import { swapMinimumError } from './minimum';

describe('swap minimum', () => {
  const quote = (price: number) => ({ price, change24h: 0, percentageChange24h: 0, observedAt: Date.now() });

  it.each(['0', '0.99', '0.999999999999999999'])('rejects %s dollars without rounding', amount => {
    expect(swapMinimumError(amount, quote(1))).toBe('swapBelowMinimum');
  });

  it.each(['1', '1.000000000000000001', '2'])('allows %s dollars', amount => {
    expect(swapMinimumError(amount, quote(1))).toBeUndefined();
  });

  it('uses the token price', () => {
    expect(swapMinimumError('0.0005', quote(2000))).toBeUndefined();
    expect(swapMinimumError('0.00049999', quote(2000))).toBe('swapBelowMinimum');
  });

  it('blocks missing, invalid, and stale prices', () => {
    expect(swapMinimumError('10', undefined)).toBe('swapMinimumPriceUnavailable');
    expect(swapMinimumError('10', quote(0))).toBe('swapMinimumPriceUnavailable');
    expect(swapMinimumError('10', { ...quote(1), observedAt: Date.now() - USD_QUOTE_MAX_AGE_MS - 1 })).toBe(
      'swapMinimumPriceUnavailable'
    );
  });

  it('accepts the fixed USDCx price', () => {
    expect(swapMinimumError('1', fixedQuote('USDCX'))).toBeUndefined();
  });
});
