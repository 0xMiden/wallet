import { fastFeeExpectation } from './epoch-quote';

describe('fastFeeExpectation', () => {
  it.each([1, 0.5])('expects a fee for a token priced at %p', price => {
    expect(fastFeeExpectation(price)).toBe('fee');
  });

  it.each([0, null, NaN])('expects the placeholder for an unpriced token (%p)', price => {
    expect(fastFeeExpectation(price)).toBe('placeholder');
  });
});
