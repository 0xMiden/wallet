import type { TokenBalanceData } from 'lib/miden/front/balance';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { quotedPrice, type TokenPrices } from 'lib/prices';

/**
 * A balance row's price fields: the quote of the token's price symbol (IETH at ETH), or 0, which
 * every reader of `fiatPrice` takes as "no price". Never a $1 guess for a token the feed does not quote.
 */
export function balancePrice(
  tokenPrices: TokenPrices,
  tokenId: string,
  symbol: string
): Pick<TokenBalanceData, 'fiatPrice' | 'change24h'> {
  const quote = quotedPrice(tokenPrices, priceSymbolFor(tokenId, symbol));
  return { fiatPrice: quote?.price ?? 0, change24h: quote?.change24h ?? 0 };
}
