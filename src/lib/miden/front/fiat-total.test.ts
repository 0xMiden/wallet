import { UNKNOWN_TOKEN_IDENTITY } from 'lib/miden/metadata/scale';
import type { TokenPrices } from 'lib/prices';

import type { TokenBalanceData } from './balance';
import { valuedBalanceTotal } from './fiat-total';

jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: () => false }));
jest.mock('lib/miden/swap/tokens', () => ({
  priceSymbolFor: (_faucetId: string, symbol: string) => symbol,
  tokenQuote: (prices: TokenPrices, _faucetId: string, symbol: string) => prices[symbol]
}));

const PRICES: TokenPrices = { ETH: { price: 2000, change24h: 0, percentageChange24h: 0 } };

const row = (tokenId: string, symbol: string, balance: number, scaleIsUnknown = false): TokenBalanceData => ({
  tokenId,
  tokenSlug: symbol,
  metadata: { ...UNKNOWN_TOKEN_IDENTITY, symbol, name: symbol, decimals: 6, scaleIsUnknown },
  balance,
  fiatPrice: 0,
  change24h: 0
});

describe('valuedBalanceTotal', () => {
  it('sums the priced holdings and leaves the unpriced and unscaled ones out', () => {
    const total = valuedBalanceTotal(
      [row('a', 'ETH', 0.5), row('b', 'ZZZ', 10), row('c', 'ETH', 3, true), row('d', 'ETH', 0)],
      PRICES
    );
    expect(total).toEqual({ totalFiat: 1000, holdsAnything: true, valuedAnything: true });
  });

  it('reports a held but unvalued account', () => {
    expect(valuedBalanceTotal([row('b', 'ZZZ', 10)], PRICES)).toEqual({
      totalFiat: 0,
      holdsAnything: true,
      valuedAnything: false
    });
  });

  it('skips the tokens the caller names', () => {
    expect(valuedBalanceTotal([row('a', 'ETH', 1), row('b', 'ETH', 1)], PRICES, id => id === 'a')).toEqual({
      totalFiat: 2000,
      holdsAnything: true,
      valuedAnything: true
    });
  });
});
