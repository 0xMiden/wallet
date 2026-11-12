import { tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';

import type { TokenBalanceData } from './balance';
import { DUST_USD_THRESHOLD, isDustBalance } from './dust';

jest.mock('lib/miden/swap/tokens', () => ({
  normalizedFaucetId: (id: string) => id.toLowerCase(),
  tokenQuote: jest.fn()
}));
const mockTokenQuote = jest.mocked(tokenQuote);

const PRICES: TokenPrices = {};
const NATIVE = 'faucet-native';

const row = (balance: number, overrides: Partial<TokenBalanceData> = {}): TokenBalanceData => ({
  tokenId: 'faucet-token',
  tokenSlug: 'TKN',
  metadata: { symbol: 'TKN', name: 'Token', decimals: 6 },
  balance,
  fiatPrice: 0,
  change24h: 0,
  ...overrides
});

const quoteAt = (price: number) => mockTokenQuote.mockReturnValue({ price, change24h: 0, percentageChange24h: 0 });

describe('isDustBalance', () => {
  beforeEach(() => {
    mockTokenQuote.mockReset();
    quoteAt(1);
  });

  it('is one tenth of a cent', () => {
    expect(DUST_USD_THRESHOLD).toBe(0.001);
  });

  it('is true below the threshold and false at or above it', () => {
    expect(isDustBalance(row(0.0009), PRICES, NATIVE)).toBe(true);
    expect(isDustBalance(row(0), PRICES, NATIVE)).toBe(true);
    expect(isDustBalance(row(0.001), PRICES, NATIVE)).toBe(false);
    expect(isDustBalance(row(5), PRICES, NATIVE)).toBe(false);
  });

  it('values the balance at the quote', () => {
    quoteAt(0.0001);
    expect(isDustBalance(row(9), PRICES, NATIVE)).toBe(true);
    expect(isDustBalance(row(10), PRICES, NATIVE)).toBe(false);
  });

  it('is never true for the native token, in either spelling of its id', () => {
    expect(isDustBalance(row(0.0001, { tokenId: NATIVE }), PRICES, NATIVE)).toBe(false);
    expect(isDustBalance(row(0.0001, { tokenId: 'FAUCET-NATIVE' }), PRICES, NATIVE)).toBe(false);
  });

  it('is false until the native id is known', () => {
    expect(isDustBalance(row(0.0001), PRICES, null)).toBe(false);
  });

  it('is false when the value is not known', () => {
    mockTokenQuote.mockReturnValue(undefined);
    expect(isDustBalance(row(0.0001), PRICES, NATIVE)).toBe(false);

    quoteAt(0);
    expect(isDustBalance(row(0.0001), PRICES, NATIVE)).toBe(false);

    quoteAt(Number.NaN);
    expect(isDustBalance(row(0.0001), PRICES, NATIVE)).toBe(false);

    quoteAt(1);
    expect(isDustBalance(row(Number.NaN), PRICES, NATIVE)).toBe(false);
    expect(
      isDustBalance(
        row(0.0001, { metadata: { symbol: 'TKN', name: 'Token', decimals: 6, scaleIsUnknown: true } }),
        PRICES,
        NATIVE
      )
    ).toBe(false);
  });
});
