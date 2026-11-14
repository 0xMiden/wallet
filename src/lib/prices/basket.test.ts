import { basketChange24h, basketKlines } from './basket';
import type { BasketComponent, TokenPrices } from './binance';

jest.mock('./fixed', () => ({ isFixedQuote: () => false, fixedQuote: () => undefined }));
jest.mock('./unquoted-default', () => ({ hasUnquotedDefaultPrice: () => false }));

const component = (priceSymbol: string, weight: number): BasketComponent => ({
  faucetId: `mm1${priceSymbol.toLowerCase()}`,
  symbol: priceSymbol,
  priceSymbol,
  weight
});
const quote = (percentageChange24h: number, source?: 'basket') => ({
  price: 1,
  change24h: 0,
  percentageChange24h,
  ...(source ? { source } : {})
});

describe('basketChange24h', () => {
  const mix = [component('BTC', 0.5), component('ETH', 0.3), component('SOL', 0.2)];

  it("moves as its tokens' moves, weighted by their shares of its value", () => {
    const prices: TokenPrices = { BTC: quote(-2), ETH: quote(0), SOL: quote(4) };
    // Value 24h ago over value now: 0.5/0.98 + 0.3/1 + 0.2/1.04.
    const expected = (1 / (0.5 / 0.98 + 0.3 + 0.2 / 1.04) - 1) * 100;
    expect(basketChange24h(mix, prices)).toBeCloseTo(expected, 10);
  });

  it('matches a single token exactly', () => {
    expect(basketChange24h([component('BTC', 1)], { BTC: quote(-2.4) })).toBeCloseTo(-2.4, 10);
  });

  it('has no move while a token has no market quote', () => {
    expect(basketChange24h(mix, { BTC: quote(1), ETH: quote(1) })).toBeUndefined();
    expect(basketChange24h(mix, { BTC: quote(1), ETH: quote(1), SOL: quote(1, 'basket') })).toBeUndefined();
  });
});

describe('basketKlines', () => {
  const mix = [component('BTC', 0.6), component('ETH', 0.4)];

  it("scales the basket's price by its holdings' value at each shared time", () => {
    const btc = [
      { time: 1, value: 50 },
      { time: 2, value: 100 }
    ];
    const eth = [
      { time: 1, value: 20 },
      { time: 2, value: 10 },
      { time: 3, value: 11 }
    ];
    // Time 2 is the last time both share: there the line is today's price.
    expect(basketKlines(mix, [btc, eth], 2)).toEqual([
      { time: 1, value: 2 * (0.6 * 0.5 + 0.4 * 2) },
      { time: 2, value: 2 }
    ]);
  });

  it('draws no line when a token has none or they share no time', () => {
    expect(basketKlines(mix, [[{ time: 1, value: 1 }], []], 2)).toEqual([]);
    expect(basketKlines(mix, [[{ time: 1, value: 1 }], [{ time: 2, value: 1 }]], 2)).toEqual([]);
    expect(basketKlines(mix, [[{ time: 1, value: 1 }]], 2)).toEqual([]);
  });
});
