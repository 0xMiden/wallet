import {
  DEFAULT_SLIPPAGE_PERCENT,
  SLIPPAGE_PERCENT_BOUNDS,
  slippageBpsToPercent,
  slippagePercentToBps
} from './slippage';

describe('slippageBpsToPercent', () => {
  it('prints basis points as a percent with no trailing zeros', () => {
    expect(slippageBpsToPercent(20)).toBe('0.2');
    expect(slippageBpsToPercent(1)).toBe('0.01');
    expect(slippageBpsToPercent(25)).toBe('0.25');
    expect(slippageBpsToPercent(100)).toBe('1');
    expect(slippageBpsToPercent(500)).toBe('5');
    expect(slippageBpsToPercent(150)).toBe('1.5');
  });

  it('opens on 0.05 % and bounds the range at 0.01 % and 1 %', () => {
    expect(DEFAULT_SLIPPAGE_PERCENT).toBe('0.05');
    expect(SLIPPAGE_PERCENT_BOUNDS).toEqual({ min: '0.01', max: '1' });
  });
});

describe('slippagePercentToBps', () => {
  it('reads a percent with up to two decimals lexically', () => {
    expect(slippagePercentToBps('0.2')).toBe(20);
    expect(slippagePercentToBps('0.29')).toBe(29);
    expect(slippagePercentToBps('.5')).toBe(50);
    expect(slippagePercentToBps('1.')).toBe(100);
    expect(slippagePercentToBps('1')).toBe(100);
    expect(slippagePercentToBps(' 0.01 ')).toBe(1);
  });

  it('refuses a draft outside the range or with more than two decimals', () => {
    expect(slippagePercentToBps('')).toBeUndefined();
    expect(slippagePercentToBps('.')).toBeUndefined();
    expect(slippagePercentToBps('0')).toBeUndefined();
    expect(slippagePercentToBps('0.001')).toBeUndefined();
    expect(slippagePercentToBps('1.01')).toBeUndefined();
    expect(slippagePercentToBps('5')).toBeUndefined();
    expect(slippagePercentToBps('-1')).toBeUndefined();
    expect(slippagePercentToBps('abc')).toBeUndefined();
  });
});
