import BigNumber from 'bignumber.js';

import { usdQuoteStatus } from 'lib/prices/amount';
import { TokenPriceInfo } from 'lib/prices/binance';

export function swapMinimumError(
  amount: string,
  quote: TokenPriceInfo | undefined
): 'swapBelowMinimum' | 'swapMinimumPriceUnavailable' | undefined {
  if (!quote || usdQuoteStatus(quote) !== 'ready') return 'swapMinimumPriceUnavailable';
  const value = new BigNumber(amount).multipliedBy(quote.price);
  if (!value.isFinite() || value.lt(1)) return 'swapBelowMinimum';
  return undefined;
}
