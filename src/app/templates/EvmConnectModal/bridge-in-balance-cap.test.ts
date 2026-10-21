import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { TokenPrices } from 'lib/prices';

import { bridgeInBalanceCapVerdict, settledHeldUsd } from './bridge-in-balance-cap';

// Each faucet prices under its own symbol; LISTED holds the symbols whose market lookup has not settled.
const LISTED = new Set<string>();
jest.mock('lib/miden/swap/tokens', () => ({
  priceSymbolFor: (_faucetId: string, symbol: string) => symbol,
  tokenQuote: (prices: TokenPrices, _faucetId: string, symbol: string) => prices[symbol]
}));
jest.mock('lib/prices/binance', () => ({
  isListedSymbol: (symbol: string | undefined) => symbol !== undefined && LISTED.has(symbol)
}));

describe('bridgeInBalanceCapVerdict', () => {
  const cap = 1232.462;

  it('holds nothing when the document sets no ceiling', () => {
    expect(bridgeInBalanceCapVerdict({ capUsd: null, heldUsd: null, depositAmount: 5, depositPriceUsd: 1 })).toEqual({
      state: 'none'
    });
  });

  it('waits while the holdings or the amount are not in', () => {
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: null, depositAmount: 5, depositPriceUsd: 1 })).toEqual({
      state: 'loading'
    });
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 10, depositAmount: null, depositPriceUsd: 1 })).toEqual({
      state: 'loading'
    });
  });

  it('refuses a deposit whose token has no price', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 10, depositAmount: 0.5, depositPriceUsd: undefined })
    ).toEqual({ state: 'unpriced', capUsd: cap });
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 10, depositAmount: 0.5, depositPriceUsd: 0 })).toEqual({
      state: 'unpriced',
      capUsd: cap
    });
  });

  it('clears a deposit that lands at or under the ceiling', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 1000, depositAmount: 232.46, depositPriceUsd: 1 })
    ).toEqual({ state: 'clear', capUsd: cap, heldUsd: 1000, depositUsd: 232.46 });
    expect(bridgeInBalanceCapVerdict({ capUsd: 100, heldUsd: 0, depositAmount: 100, depositPriceUsd: 1 }).state).toBe(
      'clear'
    );
  });

  it('refuses a deposit that takes the account past the ceiling', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 1000, depositAmount: 232.47, depositPriceUsd: 1 })
    ).toEqual({ state: 'exceeded', capUsd: cap, heldUsd: 1000, depositUsd: 232.47 });
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 0, depositAmount: 1, depositPriceUsd: 2000 }).state).toBe(
      'exceeded'
    );
  });

  it('lets float noise on an exact ceiling through', () => {
    expect(bridgeInBalanceCapVerdict({ capUsd: 0.3, heldUsd: 0.1, depositAmount: 0.2, depositPriceUsd: 1 }).state).toBe(
      'clear'
    );
  });

  it('compares the unrounded sum, so a fraction of a cent decides it', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 100.006, depositAmount: 1132.456, depositPriceUsd: 1 }).state
    ).toBe('clear');
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: cap, depositAmount: 0.004, depositPriceUsd: 1 }).state
    ).toBe('exceeded');
  });
});

describe('settledHeldUsd', () => {
  const row = (symbol: string, balance: number, scaleIsUnknown = false): TokenBalanceData => ({
    tokenId: `faucet-${symbol}`,
    tokenSlug: symbol,
    metadata: { name: symbol, symbol, decimals: 6, ...(scaleIsUnknown ? { scaleIsUnknown: true } : {}) },
    balance,
    fiatPrice: 0,
    change24h: 0
  });
  const quote = (price: number) => ({ price, change24h: 0, percentageChange24h: 0 });

  afterEach(() => LISTED.clear());

  it('waits while a held token still waits for its quote, even with another token quoted', () => {
    LISTED.add('PEND');
    expect(settledHeldUsd([row('ETH', 1), row('PEND', 5)], { ETH: quote(2000) })).toBeNull();
  });

  it('sums the holdings once every held token is quoted', () => {
    expect(settledHeldUsd([row('ETH', 1), row('USDC', 5)], { ETH: quote(2000), USDC: quote(1) })).toBe(2005);
  });

  it('does not wait for a token whose market is known to be absent', () => {
    expect(settledHeldUsd([row('ETH', 1), row('NOPE', 5)], { ETH: quote(2000) })).toBe(2000);
  });

  it('does not wait when nothing held is priced by the valuation', () => {
    LISTED.add('PEND');
    expect(settledHeldUsd([], {})).toBe(0);
    expect(settledHeldUsd([row('PEND', 0)], {})).toBe(0);
    expect(settledHeldUsd([row('PEND', 5, true)], {})).toBe(0);
  });
});
