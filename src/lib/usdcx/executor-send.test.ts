import { executorSendSplit } from './executor-send';

describe('executorSendSplit', () => {
  it('burns the amount sent less the fee that Circle quoted for it', () => {
    // 1.5 USDC sent with a fee of 0.02 USDC: 1.48 is burned and arrives as USDCx.
    expect(executorSendSplit(1_500_000n, 20_000n)).toEqual({ burnUnits: 1_480_000n, feeUnits: 20_000n });
  });

  it('burns the whole amount when the fee is zero', () => {
    expect(executorSendSplit(1_500_000n, 0n)).toEqual({ burnUnits: 1_500_000n, feeUnits: 0n });
  });

  it('keeps the burn and its fee inside the amount sent', () => {
    const split = executorSendSplit(1_500_000n, 20_000n);
    expect(split === null ? null : split.burnUnits + split.feeUnits).toBe(1_500_000n);
  });

  it.each<[string, bigint, bigint]>([
    ['the fee takes the whole amount', 20_000n, 20_000n],
    ['the fee is more than the amount', 10_000n, 20_000n],
    ['the amount is zero', 0n, 0n],
    ['the fee is negative', 1_000n, -1n]
  ])('gives null when %s', (_name, send, fee) => {
    expect(executorSendSplit(send, fee)).toBeNull();
  });

  it('burns one unit at the smallest amount that fits', () => {
    expect(executorSendSplit(20_001n, 20_000n)).toEqual({ burnUnits: 1n, feeUnits: 20_000n });
  });
});
