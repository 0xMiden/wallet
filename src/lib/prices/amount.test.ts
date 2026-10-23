import { quotedPrice } from 'lib/prices/binance';

import { USD_QUOTE_MAX_AGE_MS, tokenToUsd, usdToToken, usdQuoteStatus, usdEstimateText } from './amount';
import type { TokenPriceInfo } from './binance';
import { fixedQuote } from './fixed';
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: () => true }));

const quote = (price = 2, observedAt = Date.now()): TokenPriceInfo => ({
  price,
  observedAt,
  change24h: 0,
  percentageChange24h: 0
});

describe('exact amount conversion', () => {
  it.each([
    ['1', 3, 6, '0.333333'],
    ['1', 3, 18, '0.333333333333333333'],
    ['1', 3, 36, '0.333333333333333333333333333333333333'],
    ['0.000000000000000000000000000000000001', 1, 36, '0.000000000000000000000000000000000001'],
    ['90071992547409931234567890.123456', 2, 6, '45035996273704965617283945.061728'],
    ['0.000001', 2, 6, '0'],
    ['0', 2, 18, '0']
  ])('floors %s USD at %s to %s decimals', (value, price, decimals, expected) => {
    expect(usdToToken(value, price, decimals)).toBe(expected);
  });

  it.each(['', '.', '-1', 'Infinity', 'NaN', '1e3', '1,5', 'hello'])('rejects invalid USD text %s', value => {
    expect(usdToToken(value, 2, 6)).toBe('');
  });

  it.each([-1, 1.5, 37, NaN])('rejects an unknown or unsupported decimal scale %s', decimals => {
    expect(usdToToken('1', 2, decimals)).toBe('');
  });

  it.each([0, -1, Infinity, NaN])('rejects an invalid price %s', price => {
    expect(usdToToken('1', price, 6)).toBe('');
    expect(tokenToUsd('1', price)).toBe('');
  });

  it('multiplies exact token strings without passing through JavaScript number', () => {
    expect(tokenToUsd('90071992547409931234567890.123456789123456789', 2)).toBe(
      '180143985094819862469135780.246913578246913578'
    );
    expect(tokenToUsd('0.000000000000000000000000000000000001', 2)).toBe('0.000000000000000000000000000000000002');
    expect(tokenToUsd('', 2)).toBe('');
    expect(tokenToUsd('0', 2)).toBe('0');
  });
});

describe('trustworthy USD estimates', () => {
  it('requires a positive finite price and an observed timestamp', () => {
    expect(usdQuoteStatus(undefined)).toBe('unavailable');
    const nominal = quotedPrice({}, 'UNLISTED_TEST_TOKEN');
    expect(nominal?.price).toBe(1);
    expect(usdQuoteStatus(nominal)).toBe('unavailable');
    expect(usdQuoteStatus({ ...quote(), observedAt: undefined })).toBe('unavailable');
    for (const price of [0, -1, NaN, Infinity]) expect(usdQuoteStatus(quote(price))).toBe('unavailable');
  });

  it('expires market prices and rejects timestamps in the future', () => {
    const now = Date.now();
    expect(usdQuoteStatus(quote(2, now - USD_QUOTE_MAX_AGE_MS), now)).toBe('ready');
    expect(usdQuoteStatus(quote(2, now - USD_QUOTE_MAX_AGE_MS - 1), now)).toBe('stale');
    expect(usdQuoteStatus(quote(2, now + 1), now)).toBe('stale');
    expect(usdQuoteStatus(fixedQuote('USDCX'), now)).toBe('ready');
  });

  it('keeps empty, zero, subunit and atomic amounts distinct', () => {
    expect(usdEstimateText('', quote())).toBeUndefined();
    expect(usdEstimateText('0', quote())).toMatch(/0/);
    expect(usdEstimateText('0.000000000000000001', quote())).toBe('$0.0000000000000000020');
    expect(usdEstimateText(1n, quote(), 18)).toBe('$0.0000000000000000020');
    expect(usdEstimateText('0.0000000000000000000001', quote())).toBe('<$0.00000000000000000001');
    expect(usdEstimateText(1n, quote())).toBeUndefined();
    expect(usdEstimateText('1', undefined)).toBeUndefined();
    expect(usdEstimateText('1', quote(2, Date.now() - USD_QUOTE_MAX_AGE_MS - 1))).toBeUndefined();
  });
});
