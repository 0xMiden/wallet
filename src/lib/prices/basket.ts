import { quotedPrice, type BasketComponent, type KlinePoint, type KlineSeries, type TokenPrices } from './binance';

/**
 * A basket holds fixed amounts of its tokens between rebalances, so its value moves as the value-weighted sum of
 * theirs: over a window in which the holdings do not change, its return is Σ weightᵢ · returnᵢ, with each weight the
 * token's share of the basket's value at the window's end. These read a basket's move and line from its tokens'
 * market quotes and candles; they are exact for unchanged holdings and an estimate across a rebalance.
 */

/** A market quote for the token: never the nominal rate, a fixed price or another basket's value. */
function marketQuote(prices: TokenPrices, priceSymbol: string) {
  const quote = quotedPrice(prices, priceSymbol);
  return quote?.kind === 'market' ? quote : undefined;
}

/**
 * The basket's 24h move in percent, from the weighted 24h moves of its tokens, or undefined while any token has no
 * market quote (a move missing a part would be a wrong number, not a smaller one).
 *
 * The weights are shares at the window's end, so each token's return is taken as its end-weighted contribution:
 * R = 1 / Σ (wᵢ / (1 + rᵢ)) − 1, the exact basket return for unchanged holdings.
 */
export function basketChange24h(composition: readonly BasketComponent[], prices: TokenPrices): number | undefined {
  let startOverEnd = 0;
  for (const { priceSymbol, weight } of composition) {
    const quote = marketQuote(prices, priceSymbol);
    if (!quote) return undefined;
    const growth = 1 + quote.percentageChange24h / 100;
    if (!(growth > 0) || !Number.isFinite(growth)) return undefined;
    startOverEnd += weight / growth;
  }
  if (!(startOverEnd > 0)) return undefined;
  return (1 / startOverEnd - 1) * 100;
}

/**
 * The basket's price line: at each candle close all of its tokens share, the basket's price `price` (its current
 * price) scaled by Σ weightᵢ · closeᵢ / nowᵢ, the value its holdings had then relative to their value now. `nowᵢ` is
 * each token's current market quote in `prices`, the same quotes the composition's weights were read from, so tokens
 * whose candles close at different times (6h Binance, 4h Kraken) are still anchored at the present. When a token has
 * no market quote, the line falls back to anchoring every token at the last shared close. A candle closes one
 * declared step after it opens, so candles of different lengths pair only where they end together. The candle that
 * is still open closes after `now`, so its point is dated `now`. Empty when any token has no candles, any step is not
 * a finite positive number, or they share no candle close.
 */
export function basketKlines(
  composition: readonly BasketComponent[],
  candles: readonly KlineSeries[],
  price: number,
  prices: TokenPrices = {},
  now: number = Date.now()
): KlinePoint[] {
  if (composition.length === 0 || candles.length !== composition.length || !(price > 0)) return [];
  if (!candles.every(({ stepMs }) => Number.isFinite(stepMs) && stepMs > 0)) return [];
  const series = candles.map(
    ({ points, stepMs }) => new Map(points.filter(p => p.value > 0).map(p => [p.time + stepMs, p.value]))
  );
  const [first] = series;
  if (!first) return [];
  const times = Array.from(first.keys())
    .filter(time => series.every(s => s.has(time)))
    .sort((a, b) => a - b);
  const last = times[times.length - 1];
  if (last === undefined) return [];
  // Each token's candles divided by its current quote: the factor its value has moved by since then. Without a
  // quote for every token, divide by the value at the last shared close instead.
  const quoted = composition.map(c => marketQuote(prices, c.priceSymbol)?.price);
  const anchors = quoted.every(p => p !== undefined && p > 0 && Number.isFinite(p))
    ? (quoted as number[])
    : series.map(s => s.get(last) ?? 0);
  const relative = series.map((s, i) => {
    const end = anchors[i] ?? 0;
    return (time: number) => (s.get(time) ?? 0) / end;
  });
  return times.map(time => ({
    time: Math.min(time, now),
    value: price * composition.reduce((sum, c, i) => sum + c.weight * (relative[i]?.(time) ?? 0), 0)
  }));
}
