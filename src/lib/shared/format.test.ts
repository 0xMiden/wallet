import { formatBigInt } from 'lib/i18n/numbers';

import { formatAmount } from './format';

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: jest.fn((amount: bigint, decimals: number) => `${amount.toString()}:${decimals}`)
}));

jest.mock('lib/miden/front', () => ({
  MIDEN_METADATA: { decimals: 8 }
}));

const mockFormatBigInt = formatBigInt as jest.Mock;

describe('formatAmount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('formats using the provided token decimals', () => {
    expect(formatAmount(123n, 6)).toBe('123:6');
    expect(mockFormatBigInt).toHaveBeenCalledWith(123n, 6);
  });

  it('falls back to MIDEN decimals when token decimals are missing', () => {
    expect(formatAmount(123n, undefined)).toBe('123:8');
    expect(mockFormatBigInt).toHaveBeenCalledWith(123n, 8);
  });
});
