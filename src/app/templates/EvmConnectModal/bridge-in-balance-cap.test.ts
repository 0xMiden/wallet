import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { TokenPrices } from 'lib/prices';
import { fetchTokenPrices } from 'lib/prices/feed';

import { bridgeInBalanceCapVerdict, depositTokenPrice, settledHeldUsd } from './bridge-in-balance-cap';
import type { OfferedErc20 } from './deposit-token';

// Each faucet prices under its own symbol but NOSYM, which has none; LISTED holds the symbols Binance has not ruled out.
// Kraken lists nothing, and a symbol is ruled out there only once the real feed has asked it.
const LISTED = new Set<string>();
// The nominal $1 a test network gives an unquoted token, which is no market price.
const mockNominalQuote = { price: 1, change24h: 0, percentageChange24h: 0 };
const mockPriceSymbolFor = jest.fn((_faucetId: string, symbol: string) => (symbol === 'NOSYM' ? undefined : symbol));
jest.mock('lib/miden/swap/tokens', () => ({
  priceSymbolFor: (faucetId: string, symbol: string) => mockPriceSymbolFor(faucetId, symbol),
  tokenQuote: (prices: TokenPrices, _faucetId: string, symbol: string) => prices[symbol]
}));
jest.mock('lib/prices/binance', () => ({
  fetchTokenPrices: async () => ({}),
  isNominalQuote: (quote: unknown) => quote === mockNominalQuote,
  quotedPrice: (prices: TokenPrices, symbol: string | undefined) => (symbol === undefined ? undefined : prices[symbol]),
  isListedSymbol: (symbol: string | undefined) => symbol !== undefined && LISTED.has(symbol)
}));
jest.mock('lib/prices/kraken', () => ({
  findKrakenUsdMarket: async () => null,
  fetchKrakenPrices: async () => ({})
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

  it('waits while the feed may still quote the deposit token, and refuses it once both providers rule it out', () => {
    expect(
      bridgeInBalanceCapVerdict({
        capUsd: cap,
        heldUsd: 10,
        depositAmount: 0.5,
        depositPriceUsd: undefined,
        depositPricePending: true
      })
    ).toEqual({ state: 'loading' });
    expect(
      bridgeInBalanceCapVerdict({
        capUsd: cap,
        heldUsd: 10,
        depositAmount: 0.5,
        depositPriceUsd: undefined,
        depositPricePending: false
      })
    ).toEqual({ state: 'unpriced', capUsd: cap });
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

  it('waits while a held token is priced by an expired quote', () => {
    const now = 10_000_000;
    const at = (price: number, age: number) => ({ ...quote(price), observedAt: now - age });
    expect(settledHeldUsd([row('ETH', 1)], { ETH: at(2000, 60_000) }, now)).toBe(2000);
    expect(settledHeldUsd([row('ETH', 1)], { ETH: at(2000, 10 * 60_000 + 1) }, now)).toBeNull();
  });

  it('sums the holdings once every held token is quoted', () => {
    expect(settledHeldUsd([row('ETH', 1), row('USDC', 5)], { ETH: quote(2000), USDC: quote(1) })).toBe(2005);
  });

  it('waits for a token Binance does not list until Kraken has ruled it out as well', async () => {
    expect(settledHeldUsd([row('ETH', 1), row('KPEND', 5)], { ETH: quote(2000) })).toBeNull();
    await fetchTokenPrices(['KPEND']);
    expect(settledHeldUsd([row('ETH', 1), row('KPEND', 5)], { ETH: quote(2000) })).toBe(2000);
  });

  it('does not wait for a token whose market is known to be absent', async () => {
    await fetchTokenPrices(['NOPE']);
    expect(settledHeldUsd([row('ETH', 1), row('NOPE', 5)], { ETH: quote(2000) })).toBe(2000);
  });

  it('does not wait for a token with no price symbol, or one the feed never sends to Kraken', () => {
    expect(settledHeldUsd([row('ETH', 1), row('NOSYM', 5)], { ETH: quote(2000) })).toBe(2000);
    expect(settledHeldUsd([row('ETH', 1), row('bad/pair', 5)], { ETH: quote(2000) })).toBe(2000);
  });

  it('does not wait when nothing held is priced by the valuation', () => {
    LISTED.add('PEND');
    expect(settledHeldUsd([], {})).toBe(0);
    expect(settledHeldUsd([row('PEND', 0)], {})).toBe(0);
    expect(settledHeldUsd([row('PEND', 5, true)], {})).toBe(0);
  });
});

describe('depositTokenPrice', () => {
  const quote = (price: number) => ({ price, change24h: 0, percentageChange24h: 0 });
  const offered = (symbol: string, delivery = true): OfferedErc20 => ({
    symbol,
    contractAddress: '0x00000000000000000000000000000000000000d1',
    decimals: 8,
    ...(delivery ? { delivery: { midenFaucetId: `faucet-${symbol}`, scale: 2 } } : {})
  });
  const erc20 = { kind: 'erc20', contractAddress: '0x00000000000000000000000000000000000000d1' } as const;
  const unpriced = { priceUsd: undefined, pending: false };

  it('weighs USDC and Circle USDC at par, whatever the feed holds', () => {
    expect(depositTokenPrice('USDC', null, {})).toEqual({ priceUsd: 1, pending: false });
    expect(depositTokenPrice('CIRCLE_USDC', null, { USDC: quote(0.5) })).toEqual({ priceUsd: 1, pending: false });
  });

  it('weighs ETH at its quote, waits while its market is pending and never takes the nominal rate', () => {
    expect(depositTokenPrice('ETH', null, { ETH: quote(2000) })).toEqual({ priceUsd: 2000, pending: false });
    expect(depositTokenPrice('ETH', null, {})).toEqual({ priceUsd: undefined, pending: true });
    expect(depositTokenPrice('ETH', null, { ETH: mockNominalQuote })).toEqual(unpriced);
  });

  it("weighs an offered ERC-20 at the quote for its delivery faucet's price symbol", () => {
    expect(depositTokenPrice(erc20, offered('WBTC'), { WBTC: quote(60000) })).toEqual({
      priceUsd: 60000,
      pending: false
    });
    expect(mockPriceSymbolFor).toHaveBeenLastCalledWith('faucet-WBTC', 'WBTC');
  });

  it('weighs the Epoch USDC at par and another Epoch token at the quote for its Miden faucet', () => {
    expect(depositTokenPrice({ kind: 'epoch', key: 'USDC' }, null, {})).toEqual({ priceUsd: 1, pending: false });
    const pol = { symbol: 'POL', delivery: { midenFaucetId: 'faucet-POL' } };
    expect(depositTokenPrice({ kind: 'epoch', key: 'POL' }, pol, { POL: quote(0.2) })).toEqual({
      priceUsd: 0.2,
      pending: false
    });
    expect(mockPriceSymbolFor).toHaveBeenLastCalledWith('faucet-POL', 'POL');
  });

  it('waits for an ERC-20 quote while its market is pending', () => {
    expect(depositTokenPrice(erc20, offered('WPEND'), {})).toEqual({ priceUsd: undefined, pending: true });
  });

  it('refuses to price an ERC-20 with no delivery faucet, no price symbol or an unresolved pick', () => {
    expect(depositTokenPrice(erc20, offered('WHELD', false), { WHELD: quote(5) })).toEqual(unpriced);
    expect(depositTokenPrice(erc20, offered('NOSYM'), {})).toEqual(unpriced);
    expect(depositTokenPrice(erc20, null, {})).toEqual(unpriced);
  });

  it('refuses to price an ERC-20 whose market is ruled out or that only has the nominal rate', async () => {
    await fetchTokenPrices(['WGONE']);
    expect(depositTokenPrice(erc20, offered('WGONE'), {})).toEqual(unpriced);
    expect(depositTokenPrice(erc20, offered('WNOM'), { WNOM: mockNominalQuote })).toEqual(unpriced);
  });
});
