import { basketChange24h, basketKlines } from './basket';
import type { BasketComponent, KlinePoint, KlineSeries, TokenPrices } from './binance';

jest.mock('./fixed', () => ({ fixedQuote: () => undefined }));
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
  kind: source ?? ('market' as const)
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
  const series = (stepMs: number, points: KlinePoint[]): KlineSeries => ({ points, stepMs });

  it("scales the basket's price by its holdings' value at each shared candle close", () => {
    const btc = series(1, [
      { time: 1, value: 50 },
      { time: 2, value: 100 }
    ]);
    const eth = series(1, [
      { time: 1, value: 20 },
      { time: 2, value: 10 },
      { time: 3, value: 11 }
    ]);
    // The candle closing at 3 is the last both share: there the line is today's price.
    expect(basketKlines(mix, [btc, eth], 2)).toEqual([
      { time: 2, value: 2 * (0.6 * 0.5 + 0.4 * 2) },
      { time: 3, value: 2 }
    ]);
  });

  it('draws no line when a token has none or they share no candle close', () => {
    const one = series(1, [{ time: 1, value: 1 }]);
    expect(basketKlines(mix, [one, series(1, [])], 2)).toEqual([]);
    expect(basketKlines(mix, [one, series(1, [{ time: 2, value: 1 }])], 2)).toEqual([]);
    expect(basketKlines(mix, [one], 2)).toEqual([]);
  });

  it('pairs candles by close instant, not by open time', () => {
    const long = series(6, [{ time: 0, value: 1 }]);
    const short = series(4, [{ time: 0, value: 1 }]);
    // Both candles open at 0 but close at 6 and 4, so they are not one moment.
    expect(basketKlines(mix, [long, short], 2)).toEqual([]);
    const aligned = series(4, [
      { time: 2, value: 1 },
      { time: 6, value: 3 }
    ]);
    // Only the close at 6 is shared: the long candle opened at 0 and the short one at 2.
    expect(basketKlines(mix, [long, aligned], 2)).toEqual([{ time: 6, value: 2 }]);
  });

  it('keeps a sparse series on its declared step', () => {
    const sparse = series(6, [
      { time: 0, value: 1 },
      { time: 12, value: 2 }
    ]);
    const full = series(6, [
      { time: 0, value: 1 },
      { time: 6, value: 1 },
      { time: 12, value: 2 }
    ]);
    expect(basketKlines(mix, [sparse, full], 2)).toEqual([
      { time: 6, value: 2 * (0.6 * 0.5 + 0.4 * 0.5) },
      { time: 18, value: 2 }
    ]);
  });

  it('dates the unfinished candle at now, not at its future close', () => {
    const btc = series(6, [
      { time: 0, value: 1 },
      { time: 6, value: 2 }
    ]);
    const eth = series(6, [
      { time: 0, value: 1 },
      { time: 6, value: 1 }
    ]);
    // At 8 the candle that opened at 6 is still open: its close at 12 has not happened yet.
    expect(basketKlines(mix, [btc, eth], 2, {}, 8)).toEqual([
      { time: 6, value: 2 * (0.6 * 0.5 + 0.4 * 1) },
      { time: 8, value: 2 }
    ]);
  });

  it("anchors each token at its current quote, so tokens whose candles close apart still end at today's value", () => {
    // 6h and 4h candles: BTC closes at -12, -6, 0 and its open candle at 6; ETH at -12, -8, -4, 0 and its open
    // candle at 8. The last close they share is 0, hours before now.
    const btc = series(6, [
      { time: -18, value: 40 },
      { time: -12, value: 45 },
      { time: -6, value: 50 },
      { time: 0, value: 100 }
    ]);
    const eth = series(4, [
      { time: -16, value: 10 },
      { time: -12, value: 15 },
      { time: -8, value: 18 },
      { time: -4, value: 20 },
      { time: 0, value: 22 },
      { time: 4, value: 20 }
    ]);
    const btcQuote = { price: 100, change24h: 0, percentageChange24h: 0, kind: 'market' as const };
    const prices: TokenPrices = {
      BTC: btcQuote,
      ETH: { price: 20, change24h: 0, percentageChange24h: 0, kind: 'market' as const }
    };
    // At 0 BTC was 50 of today's 100 and ETH 20 of today's 20: the basket was worth 0.6 * 0.5 + 0.4 * 1 of today.
    expect(basketKlines(mix, [btc, eth], 2, prices, 5)).toEqual([
      { time: -12, value: 2 * (0.6 * 0.4 + 0.4 * 0.5) },
      { time: 0, value: 2 * (0.6 * 0.5 + 0.4 * 1) }
    ]);
    // Without a quote for every token the line falls back to the last shared close, where it reads today's price.
    expect(basketKlines(mix, [btc, eth], 2, { BTC: btcQuote }, 5)).toEqual([
      { time: -12, value: 2 * (0.6 * 0.8 + 0.4 * 0.5) },
      { time: 0, value: 2 }
    ]);
  });

  it('draws no line when a candle length is not a finite positive number', () => {
    const points = [{ time: 1, value: 1 }];
    for (const stepMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(basketKlines(mix, [series(stepMs, points), series(1, points)], 2)).toEqual([]);
    }
  });
});
