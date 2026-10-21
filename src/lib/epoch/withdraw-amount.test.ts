import { withdrawalAmount, withdrawalAmountError } from './withdraw-amount';

describe('exact withdrawal amount', () => {
  it('keeps all 18 decimals and never increases a request by floating point rounding', () => {
    expect(withdrawalAmount('9007199254740993.123456789012345678', 18)).toBe(9007199254740993123456789012345678n);
    expect(withdrawalAmountError('1.000000000000000001', '2', 18)).toBeUndefined();
  });
  it.each(['', '0', '-1', 'NaN', '1e3', '1,000', 'Infinity'])('rejects %p', amount => {
    expect(withdrawalAmountError(amount, '2', 18)).toBeDefined();
  });
  it('rejects excess precision rather than rounding it', () => {
    expect(withdrawalAmountError('1.0000001', '2', 6)).toBe('earnWithdrawPrecision');
  });
  it('compares exact available units and accepts Max and a one-unit residual', () => {
    expect(withdrawalAmountError('2.000000000000000001', '2', 18)).toBe('earnWithdrawAboveAvailable');
    expect(withdrawalAmountError('2', '2', 18)).toBeUndefined();
    expect(withdrawalAmountError('1.999999999999999999', '2', 18)).toBeUndefined();
    expect(withdrawalAmountError('0.000000000000000001', '2', 18)).toBeUndefined();
  });
  it('rejects unknown scale and uint256 overflow', () => {
    expect(withdrawalAmount('1', -1)).toBeNull();
    expect(withdrawalAmount('1', 256)).toBeNull();
    expect(withdrawalAmount((2n ** 256n).toString(), 0)).toBeNull();
  });
});
