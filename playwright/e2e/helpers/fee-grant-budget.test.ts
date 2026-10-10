import { requiredFeeGrantCount } from './fee-grant-budget';

describe('requiredFeeGrantCount', () => {
  it('rounds up the maximum transaction budget to advertised grants', () => {
    expect(requiredFeeGrantCount(100, 210n, 10_000n)).toBe(3);
    expect(requiredFeeGrantCount(101, 210n, 10_000n)).toBe(3);
    expect(requiredFeeGrantCount(100, 300n, 10_000n)).toBe(3);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid transaction count %s', count => {
    expect(() => requiredFeeGrantCount(count, 210n, 10_000n)).toThrow('transactionCount');
  });

  it('rejects non-positive maximum fees and grants', () => {
    expect(() => requiredFeeGrantCount(1, 0n, 10_000n)).toThrow('maxFeePerTransaction');
    expect(() => requiredFeeGrantCount(1, 210n, 0n)).toThrow('grantAmount');
  });
});
