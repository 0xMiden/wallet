import type { TokenPriceInfo } from 'lib/prices/binance';

export const tokenQuote = (): TokenPriceInfo => ({
  price: 0.05,
  kind: 'fixed',
  change24h: 0,
  percentageChange24h: 0
});
