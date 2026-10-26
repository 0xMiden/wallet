import { swapOrderExpired } from './expiry';

describe('swapOrderExpired', () => {
  it('lapses at the expiry second and after it, never before', () => {
    expect(swapOrderExpired(100, 99)).toBe(false);
    expect(swapOrderExpired(100, 100)).toBe(true);
    expect(swapOrderExpired(100, 101)).toBe(true);
  });

  it('never lapses an order with no expiry, whether it is missing or null', () => {
    expect(swapOrderExpired(undefined, 1_000_000)).toBe(false);
    expect(swapOrderExpired(null, 1_000_000)).toBe(false);
  });
});
